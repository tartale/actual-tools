import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"

import { ageFromBirthDate, fetchAccountBalance, fetchAllOpenAccounts, formatError } from "./actual-helpers.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_TRAITS,
  MONTE_CARLO_ALLOCATION_PRESETS,
  MONTE_CARLO_ALLOCATION_PRESET_LABELS,
  classifyAccounts,
  contributionLimitLines,
  findOverride,
  isPortfolioCategory,
  loadFireConfig,
  overrideIndexFor,
  pruneStaleOverrides,
  writeFireConfig,
} from "./fire-accounts.ts"
import type { AccountType, ClassifiedAccount, ContributionLimitGroup, FireAccountOverride, FireConfig, MonteCarloAllocationPreset } from "./fire-accounts.ts"
import { loadIrsLimits } from "./irs-limits.ts"
import { checkDashboard, generateDashboard } from "./fire-generate.ts"

// A plain node:http server -- no new dependency, matching this repo's zero-runtime-deps
// convention. Routes are namespaced under /api/retirement/ so a future /api/budget/... or
// /api/transactions/... section (see the companion-app north star) is a new prefix, not a rewrite.

export interface AppServerOptions {
  actualConfig: ActualConfig
  configPath: string
  irsLimitsPath: string
  outputPath: string
  uiDir: string
  // 0 (the default) asks the OS for an unused port -- see startAppServer's doc comment for why.
  port?: number
}

export interface RunningServer {
  url: string
  close: () => Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
}

interface AccountTypeInfo {
  label: string
  ruleOf55Eligible: boolean
  isPortfolio: boolean
  // False only for inherited-ira -- an inherited/beneficiary IRA can never receive new
  // contributions at all (it only ever holds what it inherited), unlike every other portfolio
  // type. Every other non-portfolio type (debt/cash/other) is also false via isPortfolio itself.
  contributionAllowed: boolean
  // Which accounts share a contribution-limit pool -- the client uses this to enforce "at most one
  // 'max' per group" without duplicating fire-accounts.ts's grouping logic (see
  // resolveMonthlyContributions).
  limitGroup: ContributionLimitGroup | null
  limitLines: string[]
}

interface AccountState {
  id: string
  name: string
  offbudget: boolean
  balance: number
  type: AccountType
  isPortfolio: boolean
  accessAge: number | null
  allocationPreset: MonteCarloAllocationPreset | null
  monthlyContribution: number | null
  monthlyContributionIsMax: boolean
  ruleOf55SeparationAge: number | null
  limitLines: string[]
}

interface StateResponse {
  dashboard: FireConfig["dashboard"]
  currentAge: number | null
  irsLimitsAvailable: boolean
  accountTypes: Record<AccountType, AccountTypeInfo>
  allocationPresets: { value: MonteCarloAllocationPreset; label: string }[]
  accounts: AccountState[]
}

// Function to build the one JSON snapshot both GET /api/retirement/state and every mutating route
// return after persisting a change -- so the client always renders from the same shape and never
// has to separately recompute what a "max" contribution resolves to or which fields a type implies.
async function buildState(actualConfig: ActualConfig, configPath: string, irsLimitsPath: string): Promise<StateResponse> {
  const { config: fireConfig } = loadFireConfig(configPath)
  const irsLimits = loadIrsLimits(irsLimitsPath)
  const birthDate = fireConfig.dashboard.birthDate
  const currentAge = birthDate === null ? null : ageFromBirthDate(birthDate)

  const rawAccounts = await fetchAllOpenAccounts(actualConfig)
  const classified = classifyAccounts(rawAccounts, fireConfig, birthDate, irsLimits)
  const balances = await Promise.all(rawAccounts.map((account) => fetchAccountBalance(actualConfig, account.id, "1970-01-01")))
  const balanceById = new Map(rawAccounts.map((account, index) => [account.id, balances[index] as number]))

  const accounts: AccountState[] = classified.map((account) => {
    const override = findOverride(account, fireConfig)
    return {
      id: account.id,
      name: account.name,
      offbudget: account.offbudget,
      balance: balanceById.get(account.id) ?? 0,
      type: account.type,
      isPortfolio: isPortfolioCategory(account.category),
      accessAge: account.accessAge,
      allocationPreset: account.allocationPreset,
      monthlyContribution: account.monthlyContribution,
      monthlyContributionIsMax: override?.monthlyContribution === "max",
      ruleOf55SeparationAge: account.ruleOf55SeparationAge,
      limitLines: contributionLimitLines(account.type, irsLimits),
    }
  })

  const accountTypes = Object.fromEntries(
    ACCOUNT_TYPES.map((type) => {
      const traits = ACCOUNT_TYPE_TRAITS[type]
      const isPortfolio = isPortfolioCategory(traits.category)
      const info: AccountTypeInfo = {
        label: traits.label,
        ruleOf55Eligible: traits.ruleOf55Eligible,
        isPortfolio,
        contributionAllowed: isPortfolio && type !== "inherited-ira",
        limitGroup: traits.limitGroup,
        limitLines: contributionLimitLines(type, irsLimits),
      }
      return [type, info]
    }),
  ) as Record<AccountType, AccountTypeInfo>

  return {
    dashboard: fireConfig.dashboard,
    currentAge,
    irsLimitsAvailable: irsLimits !== null,
    accountTypes,
    allocationPresets: MONTE_CARLO_ALLOCATION_PRESETS.map((value) => ({ value, label: MONTE_CARLO_ALLOCATION_PRESET_LABELS[value] })),
    accounts,
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8")
    })
    req.on("end", () => {
      if (raw.trim() === "") {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${formatError(error)}`))
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) })
  res.end(json)
}

// Function to require the dashboard config a generate/check run needs, throwing the same clear
// messages the old CLI's usage() calls gave for a missing birth date/retirement age/planToAge.
function requirePlan(fireConfig: FireConfig): { currentAge: number; retirementAges: number[]; planToAge: number } {
  if (fireConfig.dashboard.birthDate === null) {
    throw new Error("Missing birth date -- set it on the Plan section first.")
  }
  const currentAge = ageFromBirthDate(fireConfig.dashboard.birthDate)
  if (fireConfig.dashboard.retirementAges.length === 0) {
    throw new Error("No retirement age configured -- set at least one on the Plan section first.")
  }
  if (fireConfig.dashboard.planToAge <= currentAge) {
    throw new Error(`Plan-to-age (${fireConfig.dashboard.planToAge}) must be greater than your current age (${currentAge}).`)
  }
  return { currentAge, retirementAges: fireConfig.dashboard.retirementAges, planToAge: fireConfig.dashboard.planToAge }
}

// Function to merge a partial account-edit body into that account's override (creating one if it
// has none yet), validating each field the same way loadFireConfig does, then persist.
function applyAccountPatch(
  fireConfig: FireConfig,
  configPath: string,
  account: { id: string; name: string },
  patch: Record<string, unknown>,
): void {
  const index = overrideIndexFor(fireConfig.accounts, account)
  const existing: FireAccountOverride = index === -1 ? { match: account.id, type: "other" } : (fireConfig.accounts[index] as FireAccountOverride)
  const next: FireAccountOverride = { ...existing }

  if ("type" in patch) {
    if (typeof patch.type !== "string" || !ACCOUNT_TYPES.includes(patch.type as AccountType)) {
      throw new Error(`Unknown type "${String(patch.type)}". Valid types: ${ACCOUNT_TYPES.join(", ")}.`)
    }
    next.type = patch.type as AccountType
    delete next.category
  }
  if ("allocationPreset" in patch) {
    if (patch.allocationPreset !== null && !MONTE_CARLO_ALLOCATION_PRESETS.includes(patch.allocationPreset as MonteCarloAllocationPreset)) {
      throw new Error(`Unknown allocationPreset "${JSON.stringify(patch.allocationPreset)}".`)
    }
    next.allocationPreset = patch.allocationPreset as MonteCarloAllocationPreset | null
  }
  if ("monthlyContribution" in patch) {
    if (next.type === "inherited-ira") {
      throw new Error("An inherited/beneficiary IRA can't receive new contributions.")
    }
    const value = patch.monthlyContribution
    if (value === null) {
      delete next.monthlyContribution
    } else if (value === "max") {
      next.monthlyContribution = "max"
    } else if (typeof value === "number" && value > 0) {
      next.monthlyContribution = value
    } else {
      throw new Error(`monthlyContribution must be a positive number, "max", or null.`)
    }
  }
  if ("ruleOf55SeparationAge" in patch) {
    const value = patch.ruleOf55SeparationAge
    if (value === null) {
      next.ruleOf55SeparationAge = null
    } else if (typeof value === "number" && value > 0) {
      next.ruleOf55SeparationAge = value
    } else {
      throw new Error(`ruleOf55SeparationAge must be a positive number or null.`)
    }
  }

  const accounts = [...fireConfig.accounts]
  if (index === -1) {
    accounts.push(next)
  } else {
    accounts[index] = next
  }
  writeFireConfig(configPath, { ...fireConfig, accounts })
}

// Function to start the local companion-app server: serves the static UI, and everything under
// /api/retirement/ that the Retirement section needs. Returns immediately once listening.
export async function startAppServer(options: AppServerOptions): Promise<RunningServer> {
  const { actualConfig, configPath, irsLimitsPath, outputPath, uiDir } = options

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const path = url.pathname

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        sendFile(res, join(uiDir, "index.html"))
        return
      }
      if (req.method === "GET" && (path === "/app.js" || path === "/style.css")) {
        sendFile(res, join(uiDir, path.slice(1)))
        return
      }

      if (req.method === "GET" && path === "/api/retirement/state") {
        sendJson(res, 200, await buildState(actualConfig, configPath, irsLimitsPath))
        return
      }

      if (req.method === "PATCH" && path === "/api/retirement/plan") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const { config: fireConfig } = loadFireConfig(configPath)
        const dashboard = { ...fireConfig.dashboard }
        if ("birthDate" in body) {
          if (body.birthDate !== null && typeof body.birthDate !== "string") {
            throw new Error("birthDate must be a YYYY-MM-DD string or null.")
          }
          dashboard.birthDate = body.birthDate
        }
        if ("retirementAges" in body) {
          if (!Array.isArray(body.retirementAges) || body.retirementAges.some((age) => typeof age !== "number" || age <= 0)) {
            throw new Error("retirementAges must be an array of positive numbers.")
          }
          dashboard.retirementAges = body.retirementAges as number[]
        }
        if ("planToAge" in body) {
          if (typeof body.planToAge !== "number" || body.planToAge <= 0) {
            throw new Error("planToAge must be a positive number.")
          }
          dashboard.planToAge = body.planToAge
        }
        writeFireConfig(configPath, { ...fireConfig, dashboard })
        sendJson(res, 200, await buildState(actualConfig, configPath, irsLimitsPath))
        return
      }

      const accountMatch = /^\/api\/retirement\/accounts\/([^/]+)$/.exec(path)
      if (req.method === "PATCH" && accountMatch) {
        const accountId = decodeURIComponent(accountMatch[1] as string)
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const { config: fireConfig } = loadFireConfig(configPath)
        const rawAccounts = await fetchAllOpenAccounts(actualConfig)
        const account = rawAccounts.find((candidate) => candidate.id === accountId)
        if (!account) {
          sendJson(res, 404, { error: `No open account with id ${accountId}.` })
          return
        }
        applyAccountPatch(fireConfig, configPath, account, body)
        // Every open account has now been fetched, so this is also a safe, cheap point to prune
        // overrides for accounts that have since closed -- mirrors configure.ts's old end-of-pass
        // pruneStaleOverrides call, just triggered by any edit rather than a completed CLI run.
        const { config: reloaded } = loadFireConfig(configPath)
        const prunedAccounts = pruneStaleOverrides(reloaded.accounts, rawAccounts.map((candidate) => candidate.id))
        if (prunedAccounts.length !== reloaded.accounts.length) {
          writeFireConfig(configPath, { ...reloaded, accounts: prunedAccounts })
        }
        sendJson(res, 200, await buildState(actualConfig, configPath, irsLimitsPath))
        return
      }

      if (req.method === "POST" && path === "/api/retirement/generate") {
        const { config: fireConfig } = loadFireConfig(configPath)
        const plan = requirePlan(fireConfig)
        const rawAccounts = await fetchAllOpenAccounts(actualConfig)
        const irsLimits = loadIrsLimits(irsLimitsPath)
        const accounts: ClassifiedAccount[] = classifyAccounts(rawAccounts, fireConfig, fireConfig.dashboard.birthDate, irsLimits)
        const result = await generateDashboard(actualConfig, accounts, { outputPath, ...plan })
        sendJson(res, 200, result)
        return
      }

      if (req.method === "GET" && path === "/api/retirement/check") {
        const { config: fireConfig } = loadFireConfig(configPath)
        const plan = requirePlan(fireConfig)
        const rawAccounts = await fetchAllOpenAccounts(actualConfig)
        const irsLimits = loadIrsLimits(irsLimitsPath)
        const accounts: ClassifiedAccount[] = classifyAccounts(rawAccounts, fireConfig, fireConfig.dashboard.birthDate, irsLimits)
        const result = await checkDashboard(actualConfig, accounts, {
          ...plan,
          fallbackAnnualSpend: 0,
          fallbackInflationMean: 0.03,
        })
        sendJson(res, 200, result)
        return
      }

      sendJson(res, 404, { error: `No route for ${req.method} ${path}` })
    } catch (error) {
      sendJson(res, 400, { error: formatError(error) })
    }
  }

  function sendFile(res: ServerResponse, filePath: string): void {
    try {
      const contents = readFileSync(filePath)
      const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
      res.writeHead(200, { "content-type": contentType, "content-length": contents.length })
      res.end(contents)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}/`

  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

export type { AccountState, StateResponse }
