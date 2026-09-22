import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { extname, join } from "node:path"

import { ACTIONS, ageFromBirthDate, fetchAllOpenAccounts, fetchCategoryGroups, formatError, isAction, parseDollarAmount, validateMonthFormat } from "./actual-helpers.ts"
import type { Action, ActualConfig, CategoryGroup } from "./actual-helpers.ts"
import { actualAccountDataSource } from "./account-data-source.ts"
import type { AccountDataSource } from "./account-data-source.ts"
import { clearActualSession, loadActualSession, writeActualSession } from "./actual-session.ts"
import { accountIdFromName, appendAccountRow, categoryGroupsFromTransactions, fileAccountDataSource, parseAccountRows, parseTransactionRows } from "./file-account-data-source.ts"
import { detachedAccountDataSource } from "./detached-account-data-source.ts"
import type { DetachedAccount } from "./detached-account-data-source.ts"
import { clearFileDataSourceSession, loadFileDataSourceSession, writeFileDataSourceSession } from "./data-source-session.ts"
import type { FileDataSourceSession } from "./data-source-session.ts"
import { fetchBudgetTable, findAnomalies, setBudgetValues, tagAnomalyFindings } from "./budget-tools.ts"
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_TRAITS,
  DEFAULT_FILE_MODE_ANNUAL_EXPENSE,
  MONTE_CARLO_ALLOCATION_PRESETS,
  MONTE_CARLO_ALLOCATION_PRESET_LABELS,
  MONTE_CARLO_RETURN_MODELS,
  MONTE_CARLO_TAX_MODELS,
  MONTE_CARLO_WITHDRAWAL_RULE_TYPES,
  MONTE_CARLO_WITHDRAWAL_STRATEGIES,
  classifyAccounts,
  contributionLimitLines,
  employerContributionSummary,
  findOverride,
  isPortfolioCategory,
  loadFireConfig,
  overrideIndexFor,
  parseFireConfig,
  pruneStaleOverrides,
  writeFireConfig,
} from "./fire-accounts.ts"
import type {
  AccountType,
  ClassifiedAccount,
  ContributionLimitGroup,
  EmployerContributionSummary,
  ExpenseAdjustment,
  FireAccountOverride,
  FireConfig,
  MonteCarloAllocationPreset,
  MonteCarloReturnModel,
  MonteCarloTaxBandMeta,
  MonteCarloTaxModel,
  MonteCarloWithdrawalRuleMeta,
  MonteCarloWithdrawalRuleType,
  MonteCarloWithdrawalStrategy,
} from "./fire-accounts.ts"
import { loadIrsLimits } from "./irs-limits.ts"
import type { IrsLimits } from "./irs-limits.ts"
import { FILING_STATUSES, loadFederalTaxBrackets } from "./federal-tax-brackets.ts"
import type { FederalTaxBrackets } from "./federal-tax-brackets.ts"
import type { FilingStatus } from "./federal-tax-brackets.ts"
import { loadFederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"
import { loadIrsLifeExpectancy } from "./irs-life-expectancy.ts"
import type { IrsLifeExpectancyTable } from "./irs-life-expectancy.ts"
import { SEPP_METHODS, seppAmount } from "./fire-sepp.ts"
import type { SeppMethod } from "./fire-sepp.ts"
import { calculateMortgagePayoff, projectAccountBalance, toBridgeAccounts } from "./fire-analysis.ts"
import type { MortgagePayoff } from "./fire-analysis.ts"
import { annualSpendFromTransactions, checkDashboard } from "./fire-generate.ts"
import { generateSuggestions } from "./fire-suggestions.ts"
import {
  ALLOCATION_PRESET_RETURNS,
  WITHDRAWAL_TAX_RATES,
  expenseAdjustmentFactorWithOverride,
  monteCarloAssumptionsWithOverrides,
  retirementIncomeStreams,
  spendHistoryMonthsWithOverride,
} from "./fire-dashboard.ts"

// A plain node:http server -- no new dependency, matching this repo's zero-runtime-deps
// convention. Routes are namespaced under /api/retirement/ so a future /api/budget/... or
// /api/transactions/... section (see the companion-app north star) is a new prefix, not a rewrite.

export interface AppServerOptions {
  // Where to load/persist the Actual REST credentials entered through the app's own login form
  // (see /api/session below) -- replaces a required actualConfig option; the server now starts
  // fine with nothing logged in yet, same as a missing config.json is fine.
  sessionPath: string
  // Where to load/persist which file (if any) is being imported instead of syncing with Actual --
  // see /api/data-source below. Missing is fine, same as sessionPath -- the app just starts in
  // Actual-sync mode.
  dataSourceSessionPath: string
  configPath: string
  irsLimitsPath: string
  federalTaxBracketsPath: string
  irsLifeExpectancyPath: string
  federalPovertyGuidelinesPath: string
  uiDir: string
  // 0 (the default) asks the OS for an unused port -- see startAppServer's doc comment for why.
  port?: number
  // "linked" (the default) is today's app -- Actual sync and file import both available, exactly
  // as before this option existed. "detached" is issue #38's standalone FIRE calculator: no
  // connection of any kind, ever -- see the MODE gate right at the top of the request handler
  // below, which enforces this server-side (not just by hiding the login UI), since the whole
  // point of detached mode is being safe to deploy somewhere more public later with zero real
  // financial data ever reaching this process at all. Set via the AB_MODE env var (app.ts), not a
  // per-request choice -- which mode a given server is running is fixed for its whole process
  // lifetime, matching the two-separate-deployments plan (linked on one port, detached on another).
  mode?: "linked" | "detached"
}

export interface RunningServer {
  url: string
  // One http://<lan-ip>:<port>/ entry per non-internal network interface -- populated because the
  // server binds every interface (0.0.0.0), not just loopback, so it's reachable from another
  // device on the same network (e.g. viewing the page from a phone or laptop while this runs on a
  // home server). There is no authentication protecting the APP itself -- anyone who can reach one
  // of these addresses can open it, log in with their own Actual credentials (or use whichever
  // are already saved), and read your accounts/edit config.json -- fine on a trusted home LAN, not
  // something to expose past it (e.g. via port forwarding) without adding real auth first.
  networkUrls: string[]
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
  // The account's own override, independent of allocationPreset; null fields mean "not entered."
  customReturnMean: number | null
  customReturnStdDev: number | null
  // What the account's preset implies, so the UI can show/prefill real numbers rather than an
  // empty box -- null only when allocationPreset itself is null (a non-portfolio account).
  defaultReturnMean: number | null
  defaultReturnStdDev: number | null
  // The account's own override, or null if using the type's rough default (see
  // defaultWithdrawalTaxRate for what that default actually is, so the UI can show it as a
  // placeholder rather than an opaque "auto").
  customWithdrawalTaxRate: number | null
  defaultWithdrawalTaxRate: number
  monthlyContribution: number | null
  monthlyContributionIsMax: boolean
  ruleOf55SeparationAge: number | null
  // See ClassifiedAccount's doc comment. Only meaningful for a type with a non-null accessAge --
  // the client only shows the option then, same gating as ruleOf55SeparationAge's own
  // ruleOf55Eligible check.
  earlyWithdrawalPenalty: boolean
  // See ClassifiedAccount's doc comment. seppAnnualAmount is the actually computed distribution
  // (see fire-sepp.ts's seppAmount) for whichever method is selected, projected against the
  // account's own balance at seppStartAge -- null whenever a method/start age isn't fully set, or
  // the inputs it needs (current age, a configured retirement age, the vendored life-expectancy
  // table) aren't available yet, same "can't compute it yet" reasoning as employerContribution.
  seppMethod: SeppMethod | null
  seppStartAge: number | null
  seppInterestRate: number | null
  seppAnnualAmount: number | null
  limitLines: string[]
  // Employer-plan types only; null fields mean "not entered yet," not zero.
  annualSalary: number | null
  employerMatchRate: number | null
  employerMatchCapRate: number | null
  employerContribution: EmployerContributionSummary | null
  // hsa only.
  hsaCoverage: "self" | "family" | null
  // debt only.
  mortgageInterestRate: number | null
  mortgageMonthlyPayment: number | null
  mortgageBalanceAsOfDate: string | null
  mortgageBalanceAsOf: number | null
  mortgageExtraPrincipal: number | null
  mortgagePayoff: MortgagePayoff | { error: string } | null
  // Whole-year age at payoff, same rounding as fire-generate.ts's debtPayoffIncomeStreams (which
  // this mirrors) -- null whenever mortgagePayoff itself is null/an error, or currentAge isn't
  // known yet (no birth date entered).
  mortgagePayoffAge: number | null
  // roth-ira only; null means "not entered." See ClassifiedAccount's doc comment.
  rothBasis: number | null
  // Position in the "drain pots in order" withdrawal strategy; null means unset. See
  // ClassifiedAccount's doc comment. The client only offers drag-to-reorder while the plan's
  // withdrawal strategy is "sequential" -- reordering has no effect on any other strategy.
  withdrawalOrder: number | null
}

// A balance never changes as a side effect of a config edit -- only the data source's own ledger
// changes it -- so re-fetching every account's full history on every single field edit was the
// real cause of "Max feels delayed": a dozen real accounts' full histories, refetched after every
// keystroke. Cached here per server process, keyed by account id; "fresh" (GET
// /api/retirement/state) always refetches everything, "cached" (every mutating route's response)
// reuses what's known and only fetches an account this process has never seen before. "uncached"
// (detached mode's own routes, via buildStateFromConfig) skips this shared cache in BOTH
// directions -- detached mode's own balances are already fully known synchronously from the
// request body (detachedAccountDataSource.fetchAccountBalance does no real I/O at all, so there's
// nothing to gain by caching), and its own account ids are freshly minted per add
// (`detached-${Date.now()}-...`), never reused -- writing them into this cache would just leak
// forever on a long-running detached server, for zero benefit.
const balanceCache = new Map<string, number>()

// Every route a detached server allows through its own MODE gate (below) -- kept as one named Set
// rather than a chain of `path !== "..."` checks, since that chain grows by one comparison every
// time a new detached-mode route ships (three so far) and is easy to get wrong silently (a missing
// `&&` leaves the WHOLE gate open). Static files/dev-build-id/mode/account-types are handled by
// their own earlier routes before the gate is ever reached, so they don't need to be listed here.
const DETACHED_MODE_ALLOWED_PATHS = new Set([
  "/api/retirement/detached/check",
  "/api/retirement/detached/state",
  "/api/retirement/detached/parse-accounts",
  "/api/retirement/detached/expense-categories",
])

async function getBalances(dataSource: AccountDataSource, accounts: readonly { id: string }[], mode: "fresh" | "cached" | "uncached"): Promise<Map<string, number>> {
  if (mode === "uncached") {
    const balances = await Promise.all(accounts.map((account) => dataSource.fetchAccountBalance(account.id)))
    return new Map(accounts.map((account, index) => [account.id, balances[index] as number]))
  }
  const needsFetch = mode === "fresh" ? accounts : accounts.filter((account) => !balanceCache.has(account.id))
  if (needsFetch.length > 0) {
    const fetched = await Promise.all(needsFetch.map((account) => dataSource.fetchAccountBalance(account.id)))
    needsFetch.forEach((account, index) => balanceCache.set(account.id, fetched[index] as number))
  }
  return new Map(accounts.map((account) => [account.id, balanceCache.get(account.id) ?? 0]))
}

interface StateResponse {
  dashboard: FireConfig["dashboard"]
  currentAge: number | null
  irsLimitsAvailable: boolean
  federalTaxBracketsAvailable: boolean
  irsLifeExpectancyAvailable: boolean
  accountTypes: Record<AccountType, AccountTypeInfo>
  allocationPresets: { value: MonteCarloAllocationPreset; label: string }[]
  accounts: AccountState[]
}

// Function to build the one JSON snapshot both GET /api/retirement/state and every mutating route
// return after persisting a change -- so the client always renders from the same shape and never
// has to separately recompute what a "max" contribution resolves to or which fields a type implies.
//
// Thin now -- loads everything from its own path options, then hands off to buildStateFromConfig
// for the actual computation. Split out (2026-09-22, detached mode's own unification pass) so
// detached mode's own stateless routes can produce the exact same StateResponse shape from a
// request body's own FireConfig instead of one read off disk, and share every line of the
// classification/mortgage-payoff/SEPP/contribution-limit logic below rather than a second copy of
// it that could quietly drift from this one.
async function buildState(
  dataSource: AccountDataSource,
  configPath: string,
  irsLimitsPath: string,
  federalTaxBracketsPath: string,
  irsLifeExpectancyPath: string,
  balanceMode: "fresh" | "cached" | "uncached",
): Promise<StateResponse> {
  const { config: fireConfig } = loadFireConfig(configPath)
  const irsLimits = loadIrsLimits(irsLimitsPath)
  const federalTaxBrackets = loadFederalTaxBrackets(federalTaxBracketsPath)
  const irsLifeExpectancy = loadIrsLifeExpectancy(irsLifeExpectancyPath)
  return buildStateFromConfig(dataSource, fireConfig, irsLimits, federalTaxBrackets, irsLifeExpectancy, balanceMode)
}

async function buildStateFromConfig(
  dataSource: AccountDataSource,
  fireConfig: FireConfig,
  irsLimits: IrsLimits | null,
  federalTaxBrackets: FederalTaxBrackets | null,
  irsLifeExpectancy: IrsLifeExpectancyTable | null,
  balanceMode: "fresh" | "cached" | "uncached",
): Promise<StateResponse> {
  const birthDate = fireConfig.dashboard.birthDate
  const currentAge = birthDate === null ? null : ageFromBirthDate(birthDate)
  // SEPP amounts are reported against the latest configured retirement age, same convention as
  // ruleOf55Boosts (fire-generate.ts) -- effectiveAccessAge only gets easier to satisfy as
  // retirementAge grows, so an account's own projected balance at its SEPP start age doesn't
  // depend on which scenario is asking.
  const latestRetirementAge = fireConfig.dashboard.retirementAges.length > 0 ? Math.max(...fireConfig.dashboard.retirementAges) : null

  const rawAccounts = await dataSource.fetchAccounts()
  const classified = classifyAccounts(rawAccounts, fireConfig, birthDate, irsLimits)
  const balanceById = await getBalances(dataSource, rawAccounts, balanceMode)

  const accounts: AccountState[] = classified.map((account) => {
    const override = findOverride(account, fireConfig)
    const mortgagePayoff =
      account.mortgageInterestRate != null && account.mortgageMonthlyPayment != null && account.mortgageBalanceAsOfDate != null && account.mortgageBalanceAsOf != null
        ? calculateMortgagePayoff({
            interestRate: account.mortgageInterestRate,
            monthlyPayment: account.mortgageMonthlyPayment,
            balanceAsOfDate: account.mortgageBalanceAsOfDate,
            balanceAsOf: account.mortgageBalanceAsOf,
            extraMonthlyPrincipal: account.mortgageExtraPrincipal ?? undefined,
          })
        : null
    const mortgagePayoffAge = mortgagePayoff && !("error" in mortgagePayoff) && currentAge !== null ? currentAge + Math.round(mortgagePayoff.monthsRemaining / 12) : null
    const presetReturns = account.allocationPreset != null ? ALLOCATION_PRESET_RETURNS[account.allocationPreset] : null
    // The actual distribution amount a SEPP election computes to -- the account's own balance,
    // projected forward (same reasoning as ruleOf55Boosts: what will actually be there BY the
    // start age, not what's in it today) to seppStartAge, run through whichever method is
    // selected. Null whenever the election isn't fully set, or an input it needs isn't available
    // yet (no birth date, no retirement age configured, the vendored table missing).
    const seppAnnualAmount =
      account.seppMethod != null && account.seppStartAge != null && currentAge !== null && latestRetirementAge !== null && irsLifeExpectancy !== null
        ? seppAmount(
            account.seppMethod,
            projectAccountBalance(
              toBridgeAccounts(
                [account],
                new Map([[account.id, balanceById.get(account.id) ?? 0]]),
                new Map([[account.id, (account.monthlyContribution ?? 0) * 12]]),
                latestRetirementAge,
              ),
              currentAge,
              account.seppStartAge,
            ),
            account.seppStartAge,
            account.seppInterestRate,
            irsLifeExpectancy,
          )
        : null
    return {
      id: account.id,
      name: account.name,
      offbudget: account.offbudget,
      balance: balanceById.get(account.id) ?? 0,
      type: account.type,
      isPortfolio: isPortfolioCategory(account.category),
      accessAge: account.accessAge,
      allocationPreset: account.allocationPreset,
      customReturnMean: account.customReturnMean,
      customReturnStdDev: account.customReturnStdDev,
      defaultReturnMean: presetReturns?.mean ?? null,
      defaultReturnStdDev: presetReturns?.stdDev ?? null,
      customWithdrawalTaxRate: account.customWithdrawalTaxRate,
      defaultWithdrawalTaxRate: WITHDRAWAL_TAX_RATES[account.taxTreatment],
      monthlyContribution: account.monthlyContribution,
      monthlyContributionIsMax: override?.monthlyContribution === "max",
      ruleOf55SeparationAge: account.ruleOf55SeparationAge,
      earlyWithdrawalPenalty: account.earlyWithdrawalPenalty,
      seppMethod: account.seppMethod,
      seppStartAge: account.seppStartAge,
      seppInterestRate: account.seppInterestRate,
      seppAnnualAmount,
      limitLines: contributionLimitLines(account.type, irsLimits, account.hsaCoverage ?? "self"),
      annualSalary: account.annualSalary,
      employerMatchRate: account.employerMatchRate,
      employerMatchCapRate: account.employerMatchCapRate,
      employerContribution: currentAge === null || irsLimits === null ? null : employerContributionSummary(account, currentAge, irsLimits),
      hsaCoverage: account.hsaCoverage,
      mortgageInterestRate: account.mortgageInterestRate,
      mortgageMonthlyPayment: account.mortgageMonthlyPayment,
      mortgageBalanceAsOfDate: account.mortgageBalanceAsOfDate,
      mortgageBalanceAsOf: account.mortgageBalanceAsOf,
      mortgageExtraPrincipal: account.mortgageExtraPrincipal,
      mortgagePayoff,
      mortgagePayoffAge,
      rothBasis: account.rothBasis,
      withdrawalOrder: account.withdrawalOrder,
    }
  })
  // Sorted the same way buildMonteCarloWidget orders its pots (withdrawalOrder ascending, unset
  // accounts keeping their natural order and sorting last) -- so the list the user drags to reorder
  // already reflects the order that actually matters, whether or not "sequential" is the current
  // withdrawal strategy.
  accounts.sort((a, b) => {
    if (a.withdrawalOrder == null && b.withdrawalOrder == null) return 0
    if (a.withdrawalOrder == null) return 1
    if (b.withdrawalOrder == null) return -1
    return a.withdrawalOrder - b.withdrawalOrder
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
    federalTaxBracketsAvailable: federalTaxBrackets !== null,
    irsLifeExpectancyAvailable: irsLifeExpectancy !== null,
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

// Function to parse a /api/budget/... request's action field -- one of the named actions, or a
// plain dollar-amount string (e.g. "249.99"), same two forms the CLI's own positional ACTION
// argument accepts (see set-budget.ts's parseArguments).
function parseBudgetAction(value: unknown): Action | number {
  if (typeof value !== "string") {
    throw new Error("action is required.")
  }
  if (isAction(value)) {
    return value
  }
  const amount = parseDollarAmount(value)
  if (amount === null) {
    throw new Error(`Unknown action "${value}". Use one of ${ACTIONS.join(", ")}, or a plain dollar amount.`)
  }
  return amount
}

function parseBudgetCategories(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("categories must be an array of strings.")
  }
  return value as string[]
}

function parseBudgetMonth(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required.`)
  }
  validateMonthFormat(value)
  return value
}

// Defaults to dry-run/safe -- only an explicit `dryRun: false` in the request body ever writes
// anything, matching every other risky action in this app (Generate/Check, the Rule of 55
// checkbox, ...) never firing on an assumed default.
function parseDryRun(value: unknown): boolean {
  return value !== false
}

// Function to require the dashboard config a generate/check run needs, throwing the same clear
// messages the old CLI's usage() calls gave for a missing birth date/retirement age/planToAge.
function requirePlan(fireConfig: FireConfig): {
  currentAge: number
  retirementAges: number[]
  planToAge: number
  incomeStreams: ReturnType<typeof retirementIncomeStreams>
  monteCarloAssumptions: ReturnType<typeof monteCarloAssumptionsWithOverrides>
  crossoverExpenseCategoryIds: string[] | null
  expenseAdjustmentFactor: number
  spendHistoryMonths: number
  filingStatus: FilingStatus | null
  householdSize: number | null
  acaTargetPctFpl: number | null
  medicareAge: number | null
  acaFloorPctFpl: 100 | 138 | null
  expenseAdjustments: ExpenseAdjustment[]
} {
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
  return {
    currentAge,
    retirementAges: fireConfig.dashboard.retirementAges,
    planToAge: fireConfig.dashboard.planToAge,
    incomeStreams: retirementIncomeStreams(fireConfig.dashboard),
    monteCarloAssumptions: monteCarloAssumptionsWithOverrides(fireConfig.dashboard),
    crossoverExpenseCategoryIds: fireConfig.dashboard.crossoverExpenseCategoryIds,
    expenseAdjustmentFactor: expenseAdjustmentFactorWithOverride(fireConfig.dashboard),
    spendHistoryMonths: spendHistoryMonthsWithOverride(fireConfig.dashboard),
    filingStatus: fireConfig.dashboard.filingStatus,
    householdSize: fireConfig.dashboard.householdSize,
    acaTargetPctFpl: fireConfig.dashboard.acaTargetPctFpl,
    medicareAge: fireConfig.dashboard.medicareAge,
    acaFloorPctFpl: fireConfig.dashboard.acaFloorPctFpl,
    expenseAdjustments: fireConfig.dashboard.expenseAdjustments,
  }
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
  if ("customReturnMean" in patch) {
    const value = patch.customReturnMean
    if (value === null) {
      delete next.customReturnMean
    } else if (typeof value === "number" && Number.isFinite(value)) {
      next.customReturnMean = value
    } else {
      throw new Error("customReturnMean must be a number or null.")
    }
  }
  if ("customReturnStdDev" in patch) {
    const value = patch.customReturnStdDev
    if (value === null) {
      delete next.customReturnStdDev
    } else if (typeof value === "number" && value >= 0) {
      next.customReturnStdDev = value
    } else {
      throw new Error("customReturnStdDev must be a non-negative number or null.")
    }
  }
  if ("customWithdrawalTaxRate" in patch) {
    const value = patch.customWithdrawalTaxRate
    if (value === null) {
      delete next.customWithdrawalTaxRate
    } else if (typeof value === "number" && value >= 0) {
      next.customWithdrawalTaxRate = value
    } else {
      throw new Error("customWithdrawalTaxRate must be a non-negative number or null.")
    }
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
  if ("earlyWithdrawalPenalty" in patch) {
    const value = patch.earlyWithdrawalPenalty
    if (typeof value !== "boolean") {
      throw new Error(`earlyWithdrawalPenalty must be a boolean.`)
    }
    if (value) {
      next.earlyWithdrawalPenalty = true
    } else {
      delete next.earlyWithdrawalPenalty
    }
  }
  if ("seppMethod" in patch) {
    const value = patch.seppMethod
    if (value !== null && !SEPP_METHODS.includes(value as SeppMethod)) {
      throw new Error(`seppMethod must be one of ${SEPP_METHODS.join(", ")}, or null.`)
    }
    next.seppMethod = value as SeppMethod | null
  }
  if ("seppStartAge" in patch) {
    const value = patch.seppStartAge
    if (value === null) {
      next.seppStartAge = null
    } else if (typeof value === "number" && value > 0) {
      next.seppStartAge = value
    } else {
      throw new Error(`seppStartAge must be a positive number or null.`)
    }
  }
  if ("seppInterestRate" in patch) {
    const value = patch.seppInterestRate
    if (value === null) {
      next.seppInterestRate = null
    } else if (typeof value === "number" && value >= 0) {
      next.seppInterestRate = value
    } else {
      throw new Error(`seppInterestRate must be a non-negative number or null.`)
    }
  }

  // Function to apply one "a positive number, or null to clear it" field -- the shape shared by
  // every optional numeric field below. zeroBehavior handles the one real fork in what "0" ought
  // to mean: for most of these fields a literal 0 is indistinguishable from "not entered" (a $0
  // extra principal IS no extra principal), so typing 0 to clear a field -- a natural thing to do,
  // and the exact gap that used to reject it outright -- clears it the same as an empty field
  // would. mortgageBalanceAsOf is the one exception: a $0 balance is a real, meaningful, DIFFERENT
  // fact from "not entered" (the mortgage is paid off, not that no one ever recorded a balance),
  // so it opts into "allow" to store the literal 0 instead of clearing it.
  const applyPositiveOrNull = (field: keyof FireAccountOverride, label: string, zeroBehavior: "clear" | "allow" = "clear"): void => {
    if (!(field in patch)) {
      return
    }
    const value = patch[field]
    if (value === null || (value === 0 && zeroBehavior === "clear")) {
      delete next[field]
    } else if (typeof value === "number" && (value > 0 || (value === 0 && zeroBehavior === "allow"))) {
      ;(next as unknown as Record<string, unknown>)[field] = value
    } else {
      throw new Error(`${label} must be a positive number or null.`)
    }
  }
  applyPositiveOrNull("annualSalary", "annualSalary")
  applyPositiveOrNull("employerMatchRate", "employerMatchRate")
  applyPositiveOrNull("employerMatchCapRate", "employerMatchCapRate")
  applyPositiveOrNull("mortgageMonthlyPayment", "mortgageMonthlyPayment")
  applyPositiveOrNull("mortgageBalanceAsOf", "mortgageBalanceAsOf", "allow")
  applyPositiveOrNull("mortgageExtraPrincipal", "mortgageExtraPrincipal")
  applyPositiveOrNull("rothBasis", "rothBasis")

  if ("mortgageInterestRate" in patch) {
    const value = patch.mortgageInterestRate
    if (value === null) {
      delete next.mortgageInterestRate
    } else if (typeof value === "number" && value >= 0) {
      next.mortgageInterestRate = value
    } else {
      throw new Error("mortgageInterestRate must be a non-negative number or null.")
    }
  }
  if ("mortgageBalanceAsOfDate" in patch) {
    const value = patch.mortgageBalanceAsOfDate
    if (value === null) {
      delete next.mortgageBalanceAsOfDate
    } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      next.mortgageBalanceAsOfDate = value
    } else {
      throw new Error("mortgageBalanceAsOfDate must be a YYYY-MM-DD string or null.")
    }
  }
  if ("hsaCoverage" in patch) {
    if (patch.hsaCoverage !== "self" && patch.hsaCoverage !== "family") {
      throw new Error('hsaCoverage must be "self" or "family".')
    }
    next.hsaCoverage = patch.hsaCoverage
  }
  if ("withdrawalOrder" in patch) {
    const value = patch.withdrawalOrder
    if (value === null) {
      next.withdrawalOrder = null
    } else if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      next.withdrawalOrder = value
    } else {
      throw new Error("withdrawalOrder must be a non-negative integer or null.")
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

// Function to persist a full drag-and-drop reorder in one write: every id in orderedIds gets
// withdrawalOrder = its position (0, 1, 2, ...), upserting an override for any account that didn't
// have one yet. Reusing applyAccountPatch per-id would work too, but would mean N separate reads/
// writes of config.json for one drop -- a single combined write is both simpler and avoids any
// chance of a torn intermediate order if a request landed mid-drag.
function applyAccountOrder(fireConfig: FireConfig, configPath: string, orderedIds: readonly string[], openAccounts: readonly { id: string; name: string }[]): void {
  const accounts = [...fireConfig.accounts]
  orderedIds.forEach((accountId, position) => {
    const openAccount = openAccounts.find((candidate) => candidate.id === accountId)
    if (!openAccount) {
      return
    }
    const index = overrideIndexFor(accounts, openAccount)
    const existing: FireAccountOverride = index === -1 ? { match: openAccount.id, type: "other" } : (accounts[index] as FireAccountOverride)
    const next: FireAccountOverride = { ...existing, withdrawalOrder: position }
    if (index === -1) {
      accounts.push(next)
    } else {
      accounts[index] = next
    }
  })
  writeFireConfig(configPath, { ...fireConfig, accounts })
}

// Function to start the local companion-app server: serves the static UI, and everything under
// /api/retirement/ that the Retirement section needs. Returns immediately once listening.
export async function startAppServer(options: AppServerOptions): Promise<RunningServer> {
  const { sessionPath, dataSourceSessionPath, configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, federalPovertyGuidelinesPath, uiDir, mode = "linked" } = options

  // Mutable, unlike every other *Path option above: login/logout (see /api/session below) change
  // this at runtime, so route handlers below always read the CURRENT value via requireActualConfig
  // rather than a value captured once at server start.
  let actualConfig: ActualConfig | null = loadActualSession(sessionPath)

  // Function to get the current Actual credentials or throw a clearly-tagged "not logged in" error
  // -- every route below that talks to Actual calls this first, instead of assuming actualConfig
  // is always present the way it could when it was a required startup option.
  function requireActualConfig(): ActualConfig {
    if (actualConfig === null) {
      throw new Error("Not logged in to Actual yet.")
    }
    return actualConfig
  }

  // Mutable for the same reason actualConfig is -- see /api/data-source below. Independent of
  // actualConfig (both can be on file at once): switching from file mode back to Actual mode
  // shouldn't force re-entering credentials that are still sitting there valid, and vice versa.
  let fileDataSourceSession: FileDataSourceSession | null = loadFileDataSourceSession(dataSourceSessionPath)

  // Function to get whichever AccountDataSource is actually active right now -- file mode (when
  // set) takes priority over Actual, matching the login screen's own mutually-exclusive radio
  // choice (see issue #35). Every Retirement route that used to construct
  // currentAccountDataSource() directly now goes through this instead, so switching modes doesn't
  // require touching each one individually. Unlike Actual mode, this never touches disk or the
  // network -- the session already holds the file's own content (see data-source-session.ts's own
  // doc comment on the 2026-09-21 redesign), so there's nothing left to re-fetch/re-persist here.
  function currentAccountDataSource(): AccountDataSource {
    if (fileDataSourceSession === null) {
      return actualAccountDataSource(requireActualConfig())
    }
    return fileAccountDataSource(fileDataSourceSession.fileName, fileDataSourceSession.content)
  }

  // Function to compute file mode's own spend figure -- see CheckOptions.fileModeSpend and
  // checkDashboard's own doc comment for the source precedence. spendSource is the dashboard's own
  // fileModeSpendSource, an EXPLICIT choice once the person has touched the Manual/Transactions
  // radio (see its own doc comment in fire-accounts.ts):
  //   - "manual": the transactions file (even if one's uploaded) is ignored entirely.
  //   - "transactions": trusted as-is, including a real 0 for a window with nothing in it -- never
  //      silently substitutes the manual figure just because the computed result happens to be 0.
  //   - null (never touched -- the original default, before this radio existed): a transactions
  //      file's real spend when one's been imported AND it comes back nonzero, else the manual
  //      figure -- unchanged from before, so an existing plan that's never seen this field keeps
  //      behaving exactly as it did.
  // fileModeAnnualExpense defaults to DEFAULT_FILE_MODE_ANNUAL_EXPENSE so a freshly-imported plan
  // always has a real number to project from. Callers only invoke this once they already know
  // fileDataSourceSession is non-null.
  function fileModeSpend(
    session: FileDataSourceSession,
    expenseAdjustmentFactor: number,
    spendHistoryMonths: number,
    fileModeAnnualExpense: number | null,
    crossoverExpenseCategoryIds: readonly string[] | null,
    spendSource: "manual" | "transactions" | null,
  ): { annualSpend: number; basis: string | null } {
    const manual = { annualSpend: fileModeAnnualExpense ?? DEFAULT_FILE_MODE_ANNUAL_EXPENSE, basis: null }
    if (spendSource === "manual") {
      return manual
    }
    if (session.transactions != null) {
      const delimiter = session.transactions.fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
      const rows = parseTransactionRows(session.transactions.content, delimiter)
      const fromTransactions = annualSpendFromTransactions(rows, spendHistoryMonths, expenseAdjustmentFactor, crossoverExpenseCategoryIds)
      if (spendSource === "transactions" || fromTransactions.annualSpend > 0) {
        return fromTransactions
      }
    }
    return manual
  }

  // A fresh id per process start -- the page polls this (see app.js's hot-reload polling) and
  // reloads itself the moment it changes, so restarting the server (e.g. after an edit to server
  // code, which static files alone can't hot-swap -- sendFile below already re-reads those from
  // disk on every request, no restart needed for those) auto-refreshes any tab left open on it,
  // instead of the developer having to remember to hit refresh by hand.
  const buildId = randomUUID()

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
      if (req.method === "GET" && path === "/api/dev/build-id") {
        sendJson(res, 200, { buildId })
        return
      }

      // Plain reference data (account type -> its display label) -- no session, config, or IRS
      // limits file needed, unlike buildState's own richer accountTypes map (contribution limit
      // lines, ruleOf55Eligible, ...), which needs all three. Detached mode is the one caller: its
      // own account-add form needs a type dropdown before ANY login has happened yet, since
      // detached mode has no login step at all to piggyback a state fetch onto the way Actual/file
      // mode's post-login GET /api/retirement/state already does.
      if (req.method === "GET" && path === "/api/account-types") {
        sendJson(res, 200, Object.fromEntries(ACCOUNT_TYPES.map((type) => [type, { label: ACCOUNT_TYPE_TRAITS[type].label }])))
        return
      }

      // Tells the client which mode this server is running in, so it knows whether to show the
      // Actual/file login screen at all or go straight to the detached-mode page -- see
      // AppServerOptions.mode's own doc comment. Static/dev-build-id/account-types above stay
      // reachable in either mode (the app shell, hot-reload, and detached mode's own account-type
      // dropdown all need them); everything else is gated right below, by an ALLOWLIST rather than
      // a blocklist -- a new route added later is unreachable in detached mode by default unless
      // explicitly added to it, not exposed by default and only caught if someone remembers to gate
      // it. This is a real server-side boundary, not just a client-side UI choice: issue #38's own
      // "safe to deploy somewhere more public later" claim for detached mode depends on THIS
      // actually blocking every Actual/file/config-backed route, not merely hiding their buttons.
      if (req.method === "GET" && path === "/api/mode") {
        sendJson(res, 200, { mode })
        return
      }
      if (mode === "detached" && !DETACHED_MODE_ALLOWED_PATHS.has(path)) {
        sendJson(res, 404, { error: `Detached mode has no connection of any kind -- ${req.method} ${path} isn't available on this server.` })
        return
      }

      // Never echoes apiKey back -- the client has no legitimate use for reading it again once
      // it's been entered, so there's no reason to put it back on the wire.
      if (req.method === "GET" && path === "/api/session") {
        sendJson(res, 200, actualConfig === null ? { loggedIn: false } : { loggedIn: true, baseUrl: actualConfig.baseUrl, budgetId: actualConfig.budgetId })
        return
      }
      if (req.method === "POST" && path === "/api/session") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
        const budgetId = typeof body.budgetId === "string" ? body.budgetId.trim() : ""
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!baseUrl || !budgetId || !apiKey) {
          throw new Error("baseUrl, budgetId, and apiKey are all required.")
        }
        const candidate: ActualConfig = { baseUrl, budgetId, apiKey }
        // Proves the three actually work TOGETHER (a typo'd budgetId against a valid server/key
        // fails here, not on the first real page load after login) before persisting anything.
        await fetchAllOpenAccounts(candidate)
        writeActualSession(sessionPath, candidate)
        actualConfig = candidate
        sendJson(res, 200, { loggedIn: true, baseUrl, budgetId })
        return
      }
      if (req.method === "DELETE" && path === "/api/session") {
        clearActualSession(sessionPath)
        actualConfig = null
        sendJson(res, 200, { loggedIn: false })
        return
      }

      // The file-import counterpart to /api/session above -- issue #35, redesigned 2026-09-21 (see
      // data-source-session.ts's own doc comment). GET just reports the persisted session -- no
      // live probe any more, since there's no external file left that could go missing/change
      // underneath the app between requests. Also reports the OPTIONAL transactions import (issue
      // #34/#35's follow-up) alongside it, rather than a separate GET route, since the client
      // always wants both at once (see refreshDataSourceChip in app.js).
      if (req.method === "GET" && path === "/api/data-source") {
        sendJson(
          res,
          200,
          fileDataSourceSession === null
            ? { mode: "actual" }
            : {
                mode: "file",
                fileName: fileDataSourceSession.fileName,
                lastLoadedAt: fileDataSourceSession.lastLoadedAt,
                transactionsFileName: fileDataSourceSession.transactions?.fileName ?? null,
                transactionsLastLoadedAt: fileDataSourceSession.transactions?.lastLoadedAt ?? null,
              },
        )
        return
      }
      if (req.method === "POST" && path === "/api/data-source") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
        const content = typeof body.content === "string" ? body.content : ""
        if (!fileName || !content) {
          throw new Error("fileName and content are both required.")
        }
        // An OPTIONAL transactions file bundled into the SAME request -- the login screen's own
        // combined picker (issue #34/#35's follow-up, 2026-09-22) submits both at once. Still a
        // logically separate file (see FileDataSourceSession's own doc comment); this is just a
        // convenience for the common case of setting both together. Validated (and rejected)
        // alongside the accounts file -- all or nothing, so a bad transactions file never leaves a
        // half-applied import.
        const rawTransactions = body.transactions as { fileName?: unknown; content?: unknown } | null | undefined
        const transactionsFileName = typeof rawTransactions?.fileName === "string" ? rawTransactions.fileName.trim() : ""
        const transactionsContent = typeof rawTransactions?.content === "string" ? rawTransactions.content : ""
        if (rawTransactions != null && (!transactionsFileName || !transactionsContent)) {
          throw new Error("transactions.fileName and transactions.content are both required when transactions is provided.")
        }
        // Proves the content actually parses (same "prove it works before persisting anything"
        // pattern POST /api/session already uses for Actual credentials) before switching modes --
        // a malformed file fails here, with a real error message, not on the first page load after
        // "connecting".
        await fileAccountDataSource(fileName, content).fetchAccounts()
        let transactions: FileDataSourceSession["transactions"] = null
        if (rawTransactions != null) {
          const delimiter = transactionsFileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
          parseTransactionRows(transactionsContent, delimiter)
          transactions = { fileName: transactionsFileName, content: transactionsContent, lastLoadedAt: new Date().toISOString() }
        }
        // A fresh accounts file with NO bundled transactions starts with none at all -- even if one
        // was already imported, it may well describe a completely different plan/set of accounts
        // now, so carrying it over silently risks a spend figure that doesn't match. Re-upload it
        // after (or bundle it this time), same as the very first time.
        const session: FileDataSourceSession = { fileName, content, lastLoadedAt: new Date().toISOString(), transactions }
        writeFileDataSourceSession(dataSourceSessionPath, session)
        fileDataSourceSession = session
        sendJson(res, 200, { mode: "file", fileName, lastLoadedAt: session.lastLoadedAt, transactionsFileName: transactions?.fileName ?? null, transactionsLastLoadedAt: transactions?.lastLoadedAt ?? null })
        return
      }
      if (req.method === "DELETE" && path === "/api/data-source") {
        clearFileDataSourceSession(dataSourceSessionPath)
        fileDataSourceSession = null
        sendJson(res, 200, { mode: "actual" })
        return
      }

      // The OPTIONAL transactions import (issue #34/#35's follow-up, 2026-09-21) -- lets a
      // file-mode plan compute real spend (see fire-generate.ts's annualSpendFromTransactions)
      // instead of the flat manual fileModeAnnualExpense. A SEPARATE upload from the accounts file
      // above, not bundled into it (see FileDataSourceSession's own doc comment) -- requires an
      // accounts file to already be imported (file mode active) first. This is also what updates an
      // ALREADY-bundled transactions file (POST /api/data-source above) later on, e.g. from the
      // Retirement page's own Transactions file section, or Refresh's file picker.
      if (req.method === "POST" && path === "/api/data-source/transactions") {
        if (fileDataSourceSession === null) {
          throw new Error("Import an accounts file first -- there's no file-mode session to attach a transactions file to.")
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
        const content = typeof body.content === "string" ? body.content : ""
        if (!fileName || !content) {
          throw new Error("fileName and content are both required.")
        }
        // Same "prove it parses before persisting" pattern as the accounts file above.
        const delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
        parseTransactionRows(content, delimiter)
        const transactions = { fileName, content, lastLoadedAt: new Date().toISOString() }
        fileDataSourceSession = { ...fileDataSourceSession, transactions }
        writeFileDataSourceSession(dataSourceSessionPath, fileDataSourceSession)
        sendJson(res, 200, { mode: "file", fileName: fileDataSourceSession.fileName, lastLoadedAt: fileDataSourceSession.lastLoadedAt, transactionsFileName: fileName, transactionsLastLoadedAt: transactions.lastLoadedAt })
        return
      }
      if (req.method === "DELETE" && path === "/api/data-source/transactions") {
        if (fileDataSourceSession !== null) {
          fileDataSourceSession = { ...fileDataSourceSession, transactions: null }
          writeFileDataSourceSession(dataSourceSessionPath, fileDataSourceSession)
        }
        sendJson(res, 200, { mode: "file", transactionsFileName: null })
        return
      }

      // Adding an account directly through the UI (issue #34/#35's follow-up, 2026-09-22) --
      // file mode's own counterpart to "add an account in Actual and it shows up here": there's no
      // live account list to reflect, so this appends a real row to the accounts file's own content
      // instead (see appendAccountRow), fully persisted from then on -- indistinguishable from one
      // that came from the original import.
      if (req.method === "POST" && path === "/api/data-source/accounts") {
        if (fileDataSourceSession === null) {
          throw new Error("Import an accounts file first -- there's no file-mode session to add an account to.")
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const name = typeof body.name === "string" ? body.name.trim() : ""
        const balance = typeof body.balance === "number" ? body.balance : null
        if (!name || balance === null) {
          throw new Error("name and balance are both required.")
        }
        const delimiter = fileDataSourceSession.fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
        const existing = await fileAccountDataSource(fileDataSourceSession.fileName, fileDataSourceSession.content).fetchAccounts()
        if (existing.some((account) => account.id === accountIdFromName(name))) {
          throw new Error(`An account named "${name}" already exists.`)
        }
        const content = appendAccountRow(fileDataSourceSession.content, delimiter, name, balance)
        // Proves the appended content actually round-trips (same "prove it works before persisting"
        // discipline as every other file-mode write) before persisting it.
        const accounts = await fileAccountDataSource(fileDataSourceSession.fileName, content).fetchAccounts()
        fileDataSourceSession = { ...fileDataSourceSession, content, lastLoadedAt: new Date().toISOString() }
        writeFileDataSourceSession(dataSourceSessionPath, fileDataSourceSession)
        sendJson(res, 200, { mode: "file", fileName: fileDataSourceSession.fileName, lastLoadedAt: fileDataSourceSession.lastLoadedAt, accountCount: accounts.length })
        return
      }

      if (req.method === "GET" && path === "/api/retirement/state") {
        sendJson(res, 200, await buildState(currentAccountDataSource(), configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, "fresh"))
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
        if ("filingStatus" in body) {
          if (body.filingStatus !== null && !FILING_STATUSES.includes(body.filingStatus as FilingStatus)) {
            throw new Error(`filingStatus must be one of ${FILING_STATUSES.join(", ")}, or null.`)
          }
          dashboard.filingStatus = body.filingStatus as FilingStatus | null
        }
        if ("householdSize" in body) {
          if (body.householdSize !== null && (typeof body.householdSize !== "number" || body.householdSize <= 0)) {
            throw new Error("householdSize must be a positive number or null.")
          }
          dashboard.householdSize = body.householdSize
        }
        if ("acaTargetPctFpl" in body) {
          if (body.acaTargetPctFpl !== null && (typeof body.acaTargetPctFpl !== "number" || body.acaTargetPctFpl <= 0)) {
            throw new Error("acaTargetPctFpl must be a positive number or null.")
          }
          dashboard.acaTargetPctFpl = body.acaTargetPctFpl
        }
        if ("medicareAge" in body) {
          if (body.medicareAge !== null && (typeof body.medicareAge !== "number" || body.medicareAge <= 0)) {
            throw new Error("medicareAge must be a positive number or null.")
          }
          dashboard.medicareAge = body.medicareAge
        }
        if ("acaFloorPctFpl" in body) {
          if (body.acaFloorPctFpl !== null && body.acaFloorPctFpl !== 100 && body.acaFloorPctFpl !== 138) {
            throw new Error("acaFloorPctFpl must be 100, 138, or null.")
          }
          dashboard.acaFloorPctFpl = body.acaFloorPctFpl
        }
        // Checked here (a write-boundary cross-field validation), not in fire-accounts.ts's own
        // parse/merge validation, which only ever looks at one field at a time -- only fires when
        // this PATCH actually touches one of the two fields, so a pre-existing config saved before
        // this check existed can never block an unrelated field update because of it.
        // rothConversionAmountAt (fire-generate.ts) relies on this invariant already holding by the
        // time it runs: converting up to the floor should never risk crossing the ceiling.
        if (("acaTargetPctFpl" in body || "acaFloorPctFpl" in body) && dashboard.acaFloorPctFpl != null && dashboard.acaTargetPctFpl != null && dashboard.acaFloorPctFpl >= dashboard.acaTargetPctFpl) {
          throw new Error(`acaFloorPctFpl (${dashboard.acaFloorPctFpl}) must be less than acaTargetPctFpl (${dashboard.acaTargetPctFpl}) when both are set.`)
        }
        if ("pensionStartAge" in body) {
          if (body.pensionStartAge !== null && (typeof body.pensionStartAge !== "number" || body.pensionStartAge <= 0)) {
            throw new Error("pensionStartAge must be a positive number or null.")
          }
          dashboard.pensionStartAge = body.pensionStartAge
        }
        if ("pensionMonthlyAmount" in body) {
          if (body.pensionMonthlyAmount !== null && (typeof body.pensionMonthlyAmount !== "number" || body.pensionMonthlyAmount <= 0)) {
            throw new Error("pensionMonthlyAmount must be a positive number or null.")
          }
          dashboard.pensionMonthlyAmount = body.pensionMonthlyAmount
        }
        if ("socialSecurityClaimingAge" in body) {
          if (body.socialSecurityClaimingAge !== null && ![62, 67, 70].includes(body.socialSecurityClaimingAge as number)) {
            throw new Error("socialSecurityClaimingAge must be 62, 67, 70, or null.")
          }
          dashboard.socialSecurityClaimingAge = body.socialSecurityClaimingAge as 62 | 67 | 70 | null
        }
        for (const field of ["socialSecurityMonthlyAt62", "socialSecurityMonthlyAt67", "socialSecurityMonthlyAt70"] as const) {
          if (field in body) {
            const value = body[field]
            if (value !== null && (typeof value !== "number" || value <= 0)) {
              throw new Error(`${field} must be a positive number or null.`)
            }
            dashboard[field] = value
          }
        }
        if ("expenseAdjustments" in body) {
          const adjustments = body.expenseAdjustments
          if (!Array.isArray(adjustments)) {
            throw new Error("expenseAdjustments must be an array.")
          }
          for (const adjustment of adjustments as unknown[]) {
            const a = adjustment as { id?: unknown; name?: unknown; annualAmount?: unknown; startAge?: unknown; endAge?: unknown; inflate?: unknown }
            if (
              typeof a !== "object" ||
              a === null ||
              typeof a.id !== "string" ||
              typeof a.name !== "string" ||
              typeof a.annualAmount !== "number" ||
              typeof a.startAge !== "number" ||
              (a.endAge !== null && typeof a.endAge !== "number") ||
              typeof a.inflate !== "boolean"
            ) {
              throw new Error("Each expenseAdjustments entry must have a string id/name, numeric annualAmount/startAge, endAge (number or null), and boolean inflate.")
            }
          }
          dashboard.expenseAdjustments = adjustments as ExpenseAdjustment[]
        }
        if ("monteCarloWithdrawalStrategy" in body) {
          if (body.monteCarloWithdrawalStrategy !== null && !MONTE_CARLO_WITHDRAWAL_STRATEGIES.includes(body.monteCarloWithdrawalStrategy as MonteCarloWithdrawalStrategy)) {
            throw new Error(`monteCarloWithdrawalStrategy must be one of ${MONTE_CARLO_WITHDRAWAL_STRATEGIES.join(", ")}, or null.`)
          }
          dashboard.monteCarloWithdrawalStrategy = body.monteCarloWithdrawalStrategy as MonteCarloWithdrawalStrategy | null
        }
        if ("monteCarloReturnModel" in body) {
          if (body.monteCarloReturnModel !== null && !MONTE_CARLO_RETURN_MODELS.includes(body.monteCarloReturnModel as MonteCarloReturnModel)) {
            throw new Error(`monteCarloReturnModel must be one of ${MONTE_CARLO_RETURN_MODELS.join(", ")}, or null.`)
          }
          dashboard.monteCarloReturnModel = body.monteCarloReturnModel as MonteCarloReturnModel | null
        }
        if ("monteCarloTaxModel" in body) {
          if (body.monteCarloTaxModel !== null && !MONTE_CARLO_TAX_MODELS.includes(body.monteCarloTaxModel as MonteCarloTaxModel)) {
            throw new Error(`monteCarloTaxModel must be one of ${MONTE_CARLO_TAX_MODELS.join(", ")}, or null.`)
          }
          dashboard.monteCarloTaxModel = body.monteCarloTaxModel as MonteCarloTaxModel | null
        }
        for (const field of ["monteCarloInflationMean", "monteCarloInflationStdDev"] as const) {
          if (field in body) {
            const value = body[field]
            if (value !== null && (typeof value !== "number" || value < 0)) {
              throw new Error(`${field} must be a non-negative number or null.`)
            }
            dashboard[field] = value
          }
        }
        if ("monteCarloMinimumWithdrawal" in body) {
          const value = body.monteCarloMinimumWithdrawal
          if (value !== null && (typeof value !== "number" || value < 0)) {
            throw new Error("monteCarloMinimumWithdrawal must be a non-negative number or null.")
          }
          dashboard.monteCarloMinimumWithdrawal = value
        }
        if ("monteCarloSimulationCount" in body) {
          const value = body.monteCarloSimulationCount
          if (value !== null && (typeof value !== "number" || value <= 0)) {
            throw new Error("monteCarloSimulationCount must be a positive number or null.")
          }
          dashboard.monteCarloSimulationCount = value
        }
        if ("crossoverExpenseCategoryIds" in body) {
          const value = body.crossoverExpenseCategoryIds
          if (value !== null && (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== "string"))) {
            throw new Error("crossoverExpenseCategoryIds must be a non-empty array of category id strings, or null.")
          }
          dashboard.crossoverExpenseCategoryIds = value as string[] | null
        }
        if ("crossoverExpenseAdjustmentFactor" in body) {
          const value = body.crossoverExpenseAdjustmentFactor
          if (value !== null && (typeof value !== "number" || value <= 0)) {
            throw new Error("crossoverExpenseAdjustmentFactor must be a positive number or null.")
          }
          dashboard.crossoverExpenseAdjustmentFactor = value
        }
        if ("crossoverSpendHistoryMonths" in body) {
          const value = body.crossoverSpendHistoryMonths
          if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
            throw new Error("crossoverSpendHistoryMonths must be a positive integer or null.")
          }
          dashboard.crossoverSpendHistoryMonths = value
        }
        if ("fileModeAnnualExpense" in body) {
          const value = body.fileModeAnnualExpense
          if (value !== null && (typeof value !== "number" || value < 0)) {
            throw new Error("fileModeAnnualExpense must be a non-negative number or null.")
          }
          dashboard.fileModeAnnualExpense = value
        }
        if ("fileModeSpendSource" in body) {
          const value = body.fileModeSpendSource
          if (value !== null && value !== "manual" && value !== "transactions") {
            throw new Error('fileModeSpendSource must be "manual", "transactions", or null.')
          }
          dashboard.fileModeSpendSource = value
        }
        if ("monteCarloWithdrawalRule" in body) {
          const rule = body.monteCarloWithdrawalRule
          if (rule !== null) {
            if (typeof rule !== "object" || Array.isArray(rule) || !MONTE_CARLO_WITHDRAWAL_RULE_TYPES.includes((rule as { type?: unknown }).type as MonteCarloWithdrawalRuleType)) {
              throw new Error(`monteCarloWithdrawalRule.type must be one of ${MONTE_CARLO_WITHDRAWAL_RULE_TYPES.join(", ")}.`)
            }
            for (const [key, value] of Object.entries(rule)) {
              if (key !== "type" && typeof value !== "number") {
                throw new Error(`monteCarloWithdrawalRule.${key} must be a number.`)
              }
            }
          }
          dashboard.monteCarloWithdrawalRule = rule as MonteCarloWithdrawalRuleMeta | null
        }
        if ("monteCarloTaxBands" in body) {
          const bands = body.monteCarloTaxBands
          if (bands !== null) {
            if (!Array.isArray(bands)) {
              throw new Error("monteCarloTaxBands must be an array, or null.")
            }
            for (const band of bands as unknown[]) {
              const b = band as { id?: unknown; from?: unknown; rate?: unknown }
              if (typeof b !== "object" || b === null || typeof b.id !== "string" || (b.from !== undefined && typeof b.from !== "number") || (b.rate !== undefined && typeof b.rate !== "number")) {
                throw new Error("Each monteCarloTaxBands entry must have a string id and numeric from/rate.")
              }
            }
          }
          dashboard.monteCarloTaxBands = bands as MonteCarloTaxBandMeta[] | null
        }
        writeFireConfig(configPath, { ...fireConfig, dashboard })
        sendJson(res, 200, await buildState(currentAccountDataSource(), configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, "cached"))
        return
      }

      if (req.method === "PATCH" && path === "/api/retirement/accounts/order") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== "string")) {
          sendJson(res, 400, { error: "orderedIds must be an array of account id strings." })
          return
        }
        const { config: fireConfig } = loadFireConfig(configPath)
        const rawAccounts = await currentAccountDataSource().fetchAccounts()
        applyAccountOrder(fireConfig, configPath, body.orderedIds as string[], rawAccounts)
        sendJson(res, 200, await buildState(currentAccountDataSource(), configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, "cached"))
        return
      }

      // NOTE: matched only after the more specific /accounts/order route above -- "order" would
      // otherwise be captured here as an account id.
      const accountMatch = /^\/api\/retirement\/accounts\/([^/]+)$/.exec(path)
      if (req.method === "PATCH" && accountMatch) {
        const accountId = decodeURIComponent(accountMatch[1] as string)
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const { config: fireConfig } = loadFireConfig(configPath)
        const rawAccounts = await currentAccountDataSource().fetchAccounts()
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
        sendJson(res, 200, await buildState(currentAccountDataSource(), configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, "cached"))
        return
      }

      if (req.method === "GET" && path === "/api/retirement/check") {
        const { config: fireConfig } = loadFireConfig(configPath)
        const plan = requirePlan(fireConfig)
        const dataSource = currentAccountDataSource()
        const rawAccounts = await dataSource.fetchAccounts()
        const irsLimits = loadIrsLimits(irsLimitsPath)
        const federalTaxBrackets = loadFederalTaxBrackets(federalTaxBracketsPath)
        const federalPovertyGuidelines = loadFederalPovertyGuidelines(federalPovertyGuidelinesPath)
        const accounts: ClassifiedAccount[] = classifyAccounts(rawAccounts, fireConfig, fireConfig.dashboard.birthDate, irsLimits)
        const result = await checkDashboard(fileDataSourceSession === null ? requireActualConfig() : null, dataSource, accounts, {
          ...plan,
          fallbackInflationMean: 0.03,
          federalTaxBrackets,
          federalPovertyGuidelines,
          fileModeSpend: fileDataSourceSession === null ? null : fileModeSpend(fileDataSourceSession, plan.expenseAdjustmentFactor, plan.spendHistoryMonths, fireConfig.dashboard.fileModeAnnualExpense, plan.crossoverExpenseCategoryIds, fireConfig.dashboard.fileModeSpendSource),
        })
        sendJson(res, 200, result)
        return
      }

      // Function to turn a detached-mode request body's own "accounts" array (each entry the same
      // shape the real Accounts card already edits -- id/name/balance plus every FireAccountOverride
      // field, keyed by id instead of match) into the two shapes the rest of the app already works
      // with: a raw account list (for detachedAccountDataSource) and a FireAccountOverride list (for
      // a synthetic FireConfig). Shared by both detached routes below so their own request-body
      // handling can't drift apart from each other. Per-override field validation (unknown type,
      // bad allocationPreset, ...) is NOT duplicated here -- parseFireConfig, called by both callers
      // right after this, already does it, identically to a real config.json's own accounts.
      function detachedAccountsFromBody(rawAccounts: unknown): { detachedAccounts: DetachedAccount[]; overrides: FireAccountOverride[] } {
        if (!Array.isArray(rawAccounts)) {
          throw new Error("accounts must be an array.")
        }
        const detachedAccounts: DetachedAccount[] = []
        const overrides: FireAccountOverride[] = []
        rawAccounts.forEach((raw, index) => {
          const account = raw as Record<string, unknown>
          if (typeof account.id !== "string" || !account.id) {
            throw new Error(`accounts[${index}].id must be a non-empty string.`)
          }
          if (typeof account.name !== "string" || !account.name.trim()) {
            throw new Error(`accounts[${index}].name must be a non-empty string.`)
          }
          if (typeof account.balance !== "number") {
            throw new Error(`accounts[${index}].balance must be a number (cents).`)
          }
          detachedAccounts.push({ id: account.id, name: account.name.trim(), balance: account.balance })
          // Spreads the WHOLE account (id/name/balance included) -- the extra fields ride along
          // harmlessly (nothing reads .id/.name/.balance off a FireAccountOverride, only .match,
          // set explicitly right after), simpler than destructuring three fields out just to
          // discard them.
          overrides.push({ ...account, match: account.id })
        })
        return { detachedAccounts, overrides }
      }

      // Function to turn a detached-mode request body's own optional "transactions" field into the
      // FileDataSourceSession-shaped object fileModeSpend/categoryGroupsFromTransactions already
      // expect -- both only ever read the .transactions field off that shape, so this is the only
      // glue needed to reuse them completely unchanged for detached mode's own stateless routes
      // below; there's no real session to build, just this one field wrapped to match.
      function detachedTransactionsFromBody(raw: unknown): FileDataSourceSession["transactions"] {
        if (raw == null) {
          return null
        }
        const body = raw as Record<string, unknown>
        const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
        const content = typeof body.content === "string" ? body.content : ""
        if (!fileName || !content) {
          throw new Error("transactions.fileName and transactions.content are both required when transactions is provided.")
        }
        return { fileName, content, lastLoadedAt: new Date().toISOString() }
      }

      // Issue #38: detached mode's own stateless counterpart to GET /api/retirement/check above --
      // fully ephemeral by design (see the issue's own "Design" section), so this reads NOTHING
      // from disk and writes NOTHING to disk. The entire plan and account list travel in the
      // request body itself, every time; the server holds none of it between requests (unlike
      // Actual/file mode's own actualConfig/fileDataSourceSession module-level state) -- "data
      // lives only in the browser for that session" is a real architectural property here, not
      // just a UI framing. Reuses requirePlan/classifyAccounts/checkDashboard/parseFireConfig
      // unchanged, fed from a synthetic, in-memory-only FireConfig instead of one loadFireConfig
      // read off config.json -- same validation and derivation logic as every other mode, zero
      // duplicated business logic. Also reachable from a linked-mode server (not just a detached
      // deployment) -- the MODE gate above only blocks the reverse (a detached server can't reach
      // linked-only routes); nothing about this route itself depends on which server it's running on.
      if (req.method === "POST" && path === "/api/retirement/detached/check") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const { detachedAccounts, overrides } = detachedAccountsFromBody(body.accounts)
        const syntheticFireConfig = parseFireConfig({ version: 1, accounts: overrides, dashboard: body.dashboard ?? {} }, "detached mode request")
        const plan = requirePlan(syntheticFireConfig)
        const dataSource = detachedAccountDataSource(detachedAccounts)
        const rawAccounts = await dataSource.fetchAccounts()
        const accounts: ClassifiedAccount[] = classifyAccounts(rawAccounts, syntheticFireConfig, syntheticFireConfig.dashboard.birthDate, null)
        const federalTaxBrackets = loadFederalTaxBrackets(federalTaxBracketsPath)
        const federalPovertyGuidelines = loadFederalPovertyGuidelines(federalPovertyGuidelinesPath)
        // Same Manual/Transactions precedence file mode's own fileModeSpend helper resolves --
        // reused completely unchanged (it only ever reads the .transactions field off whatever
        // session-shaped object it's given), fed a synthetic one built from this request's own
        // optional "transactions" field instead of a real, server-held FileDataSourceSession.
        const fileModeSpendResult = fileModeSpend(
          { fileName: "", content: "", lastLoadedAt: "", transactions: detachedTransactionsFromBody(body.transactions) },
          plan.expenseAdjustmentFactor,
          plan.spendHistoryMonths,
          syntheticFireConfig.dashboard.fileModeAnnualExpense,
          plan.crossoverExpenseCategoryIds,
          syntheticFireConfig.dashboard.fileModeSpendSource,
        )
        const result = await checkDashboard(null, dataSource, accounts, {
          ...plan,
          fallbackInflationMean: 0.03,
          federalTaxBrackets,
          federalPovertyGuidelines,
          fileModeSpend: fileModeSpendResult,
        })
        sendJson(res, 200, result)
        return
      }

      // Detached mode's own stateless counterpart to GET /api/retirement/state -- same "everything
      // travels in the request body, nothing touches disk" design as /detached/check above, just
      // returning the fuller StateResponse shape (classified accounts, account-type info, ...) the
      // real Plan/Expense Projection/Accounts cards need to render themselves, rather than a check
      // result. Reuses buildStateFromConfig unchanged -- this route's whole job is producing a
      // synthetic FireConfig + AccountDataSource for it to run against, nothing more.
      if (req.method === "POST" && path === "/api/retirement/detached/state") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const { detachedAccounts, overrides } = detachedAccountsFromBody(body.accounts)
        const syntheticFireConfig = parseFireConfig({ version: 1, accounts: overrides, dashboard: body.dashboard ?? {} }, "detached mode request")
        const dataSource = detachedAccountDataSource(detachedAccounts)
        const irsLimits = loadIrsLimits(irsLimitsPath)
        const federalTaxBrackets = loadFederalTaxBrackets(federalTaxBracketsPath)
        const irsLifeExpectancy = loadIrsLifeExpectancy(irsLifeExpectancyPath)
        const result = await buildStateFromConfig(dataSource, syntheticFireConfig, irsLimits, federalTaxBrackets, irsLifeExpectancy, "uncached")
        sendJson(res, 200, result)
        return
      }

      // Issue #38 phase 3: parses a CSV/TSV accounts file the same strict schema/parser file
      // mode's own import already uses (parseAccountRows -- issue #34's), but returns the parsed
      // rows directly instead of writing anything to disk or remembering the file. Detached mode's
      // account list is entirely client-held (see DETACHED_DRAFT in app.js) -- this is a one-shot
      // "seed my account list from this file" convenience, not a real data source the way file
      // mode's own POST /api/data-source is (no session, nothing re-read later). Not gated to a
      // detached SERVER specifically (same as /detached/check|state above) -- reachable from a
      // linked server too, since nothing about parsing a file depends on which mode is running.
      if (req.method === "POST" && path === "/api/retirement/detached/parse-accounts") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
        const content = typeof body.content === "string" ? body.content : ""
        if (!fileName || !content) {
          throw new Error("fileName and content are both required.")
        }
        const delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
        const accounts = parseAccountRows(content, delimiter)
        sendJson(res, 200, { accounts })
        return
      }

      // Detached mode's own stateless counterpart to GET /api/budget/context's file-mode branch --
      // the Expense categories picker needs real category groups derived from a transactions file
      // the same way file mode's own does (categoryGroupsFromTransactions), but there's no
      // server-held session here to read one from, so the file's content travels in the request
      // body instead, same pattern as every other detached route. Returns [] (not an error) when no
      // transactions were given, matching file mode's own "nothing to derive from yet" behavior.
      if (req.method === "POST" && path === "/api/retirement/detached/expense-categories") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const transactions = detachedTransactionsFromBody(body.transactions)
        if (transactions == null) {
          sendJson(res, 200, { categoryGroups: [] })
          return
        }
        const syntheticFireConfig = parseFireConfig({ version: 1, accounts: [], dashboard: body.dashboard ?? {} }, "detached mode request")
        const delimiter = transactions.fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
        const rows = parseTransactionRows(transactions.content, delimiter)
        const groups = categoryGroupsFromTransactions(rows, spendHistoryMonthsWithOverride(syntheticFireConfig.dashboard))
        // Same income-category exclusion GET /api/budget/context already applies -- never a valid
        // set-values/anomalies target, so the picker shouldn't offer one here either.
        const categoryGroups = groups
          .filter((group) => !group.is_income)
          .map((group) => ({ ...group, categories: group.categories.filter((category) => !category.is_income) }))
        sendJson(res, 200, { categoryGroups })
        return
      }

      // Issue #28: "you're eligible for an early-access option you haven't set, and it would
      // help" suggestions (Rule of 55 / SEPP) -- see fire-suggestions.ts's own doc comment for
      // the full reasoning. Same input assembly as /api/retirement/check above (this route runs
      // several extra what-if checkDashboard calls internally, so it's kept separate rather than
      // folded into that response -- a plain check shouldn't pay for this every time).
      if (req.method === "GET" && path === "/api/retirement/suggestions") {
        const { config: fireConfig } = loadFireConfig(configPath)
        const plan = requirePlan(fireConfig)
        const dataSource = currentAccountDataSource()
        const rawAccounts = await dataSource.fetchAccounts()
        const irsLimits = loadIrsLimits(irsLimitsPath)
        const federalTaxBrackets = loadFederalTaxBrackets(federalTaxBracketsPath)
        const federalPovertyGuidelines = loadFederalPovertyGuidelines(federalPovertyGuidelinesPath)
        const irsLifeExpectancy = loadIrsLifeExpectancy(irsLifeExpectancyPath)
        const accounts: ClassifiedAccount[] = classifyAccounts(rawAccounts, fireConfig, fireConfig.dashboard.birthDate, irsLimits)
        const result = await generateSuggestions(
          fileDataSourceSession === null ? requireActualConfig() : null,
          dataSource,
          accounts,
          {
            ...plan,
            fallbackInflationMean: 0.03,
            federalTaxBrackets,
            federalPovertyGuidelines,
            fileModeSpend: fileDataSourceSession === null ? null : fileModeSpend(fileDataSourceSession, plan.expenseAdjustmentFactor, plan.spendHistoryMonths, fireConfig.dashboard.fileModeAnnualExpense, plan.crossoverExpenseCategoryIds, fireConfig.dashboard.fileModeSpendSource),
          },
          irsLifeExpectancy,
        )
        sendJson(res, 200, result ?? { targetRetirementAge: null, suggestions: [] })
        return
      }

      // File mode (with a transactions file imported) derives category groups locally instead of
      // fetching them from Actual -- issue #34/#35's follow-up (2026-09-21). Only the Expense
      // Categories picker calls this route in file mode (the Budget tab it otherwise also serves is
      // disabled entirely there -- see applyDataSourceMode in app.js), so branching here is safe.
      if (req.method === "GET" && path === "/api/budget/context") {
        let groups: CategoryGroup[]
        if (fileDataSourceSession !== null) {
          if (fileDataSourceSession.transactions == null) {
            groups = []
          } else {
            const { config: fireConfig } = loadFireConfig(configPath)
            const delimiter = fileDataSourceSession.transactions.fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
            const rows = parseTransactionRows(fileDataSourceSession.transactions.content, delimiter)
            groups = categoryGroupsFromTransactions(rows, spendHistoryMonthsWithOverride(fireConfig.dashboard))
          }
        } else {
          groups = await fetchCategoryGroups(requireActualConfig())
        }
        // Income categories/groups are never a valid set-values/anomalies target (see
        // findIncomeFilterMatches in actual-helpers.ts) -- excluded here so the picker can't even
        // offer one, rather than letting the request round-trip into a thrown error.
        const categoryGroups = groups
          .filter((group) => !group.is_income)
          .map((group) => ({ ...group, categories: group.categories.filter((category) => !category.is_income) }))
        sendJson(res, 200, { categoryGroups })
        return
      }

      if (req.method === "POST" && path === "/api/budget/table") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const startMonth = parseBudgetMonth(body.startMonth, "startMonth")
        const table = await fetchBudgetTable(requireActualConfig(), startMonth, parseBudgetMonth(body.endMonth ?? startMonth, "endMonth"))
        sendJson(res, 200, table)
        return
      }

      if (req.method === "POST" && path === "/api/budget/set-values") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const startMonth = parseBudgetMonth(body.startMonth, "startMonth")
        const categories = parseBudgetCategories(body.categories)
        // setBudgetValues itself still treats an empty filter as "every category" -- that is the
        // CLI's own documented unfiltered sweep (`set-values` with no -c). Over the web the picker
        // is a checkbox per category, where an empty selection reads as "nothing picked yet"
        // rather than "sweep everything", so the route refuses it outright.
        if (categories.length === 0) {
          throw new Error("Pick at least one category to update.")
        }
        const months = await setBudgetValues(requireActualConfig(), {
          action: parseBudgetAction(body.action),
          startMonth,
          endMonth: parseBudgetMonth(body.endMonth ?? startMonth, "endMonth"),
          categories,
          dryRun: parseDryRun(body.dryRun),
        })
        sendJson(res, 200, { months })
        return
      }

      if (req.method === "POST" && path === "/api/budget/anomalies") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const startMonth = parseBudgetMonth(body.startMonth, "startMonth")
        const findings = await findAnomalies(requireActualConfig(), {
          categories: parseBudgetCategories(body.categories),
          startMonth,
          endMonth: parseBudgetMonth(body.endMonth ?? startMonth, "endMonth"),
        })
        sendJson(res, 200, { findings })
        return
      }

      if (req.method === "POST" && path === "/api/budget/anomalies/tag") {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const startMonth = parseBudgetMonth(body.startMonth, "startMonth")
        const endMonth = parseBudgetMonth(body.endMonth ?? startMonth, "endMonth")
        const findings = await findAnomalies(requireActualConfig(), { categories: parseBudgetCategories(body.categories), startMonth, endMonth })
        const tagResults = await tagAnomalyFindings(requireActualConfig(), findings, startMonth, parseDryRun(body.dryRun))
        sendJson(res, 200, { findings, tagResults })
        return
      }

      sendJson(res, 404, { error: `No route for ${req.method} ${path}` })
    } catch (error) {
      sendJson(res, 400, { error: formatError(error) })
    }
  }

  // Read from disk per request and explicitly never cached. Without a Cache-Control (or even an
  // ETag/Last-Modified to revalidate against) a browser is free to apply heuristic freshness and
  // reuse app.js/style.css without asking -- Firefox notably does. That silently defeats the whole
  // hot-reload path below: the page dutifully reloads on a new build id and is then handed the same
  // stale assets it already had. Worse, the two cache independently, so a fresh app.js against a
  // stale style.css produces markup whose styling rules simply aren't there. There is no bandwidth
  // argument against no-store for a handful of local files served over loopback.
  function sendFile(res: ServerResponse, filePath: string): void {
    try {
      const contents = readFileSync(filePath)
      const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
      res.writeHead(200, { "content-type": contentType, "content-length": contents.length, "cache-control": "no-store, must-revalidate" })
      res.end(contents)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
  }

  // Binds every interface, not just loopback, so the page is reachable from another device on the
  // same network -- see RunningServer.networkUrls' doc comment for the real security tradeoff that
  // comes with this.
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "0.0.0.0", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const url = `http://localhost:${port}/`
  const networkUrls = Object.values(networkInterfaces())
    .flat()
    .filter((info): info is NonNullable<typeof info> => info !== undefined && info.family === "IPv4" && !info.internal)
    .map((info) => `http://${info.address}:${port}/`)

  return {
    url,
    networkUrls,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

export type { AccountState, StateResponse }
