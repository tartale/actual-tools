import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startAppServer } from "./app-server.ts"
import type { RunningServer, StateResponse } from "./app-server.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import type { CheckResult, GenerateResult } from "./fire-generate.ts"

interface ErrorBody {
  error: string
}

// Route-level tests: a real node:http server on an ephemeral port, hit with real fetch() calls,
// backed by a real temp config.json/irs-limits.json on disk (loadFireConfig/writeFireConfig are
// plain fs functions -- a temp file exercises them exactly as the real app does, no mocking
// needed there) and a mocked global fetch standing in for Actual's REST API. The mock only
// intercepts calls to the fake Actual host; a call to the local server's own address
// passes straight through to the real fetch implementation, since both share one global.

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

// Node's fetch types Response.json() as Promise<unknown> -- every call site names the concrete
// shape it expects instead of widening to any.
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

interface FetchFixture {
  accounts?: { id: string; name: string; offbudget: boolean; closed: boolean }[]
  categoryGroups?: unknown[]
  transactionsByAccount?: Record<string, { amount: number; transfer_id: string | null }[]>
  monthCategories?: unknown[]
  dashboardRows?: unknown[]
}

function mockActualFetch(fixture: FetchFixture) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") {
      return realFetch(url, init)
    }
    if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: fixture.accounts ?? [] })
    if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: fixture.categoryGroups ?? [] })
    const txMatch = /\/accounts\/([^/]+)\/transactions/.exec(u.pathname)
    if (txMatch) return jsonResponse({ data: fixture.transactionsByAccount?.[txMatch[1] as string] ?? [] })
    if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return jsonResponse({ data: fixture.monthCategories ?? [] })
    if (/\/run-query$/.test(u.pathname)) return jsonResponse({ data: fixture.dashboardRows ?? [] })
    throw new Error(`Unhandled fetch in test: ${u.pathname}`)
  })
}

let dir: string
let configPath: string
let irsLimitsPath: string
let server: RunningServer | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-server-test-"))
  configPath = join(dir, "config.json")
  irsLimitsPath = join(dir, "irs-limits.json")
})

afterEach(async () => {
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// Re-booting (a fixture change mid-test, e.g. simulating an account closing between two edits)
// closes any server already running first, so afterEach only ever has one to clean up.
async function boot(fixture: FetchFixture = {}): Promise<string> {
  if (server) {
    await server.close()
  }
  vi.stubGlobal("fetch", mockActualFetch(fixture))
  server = await startAppServer({ actualConfig, configPath, irsLimitsPath, outputPath: join(dir, "fire-dashboard.json"), uiDir: dir })
  return server.url
}

const IRS_LIMITS = {
  taxYear: 2026,
  source: "test fixture",
  employerPlan: { standard: 2450000, catchUp50: 800000, catchUp60to63: 1125000, annualAdditions: 7200000 },
  ira: { standard: 750000, catchUp50: 110000 },
  hsa: { selfOnly: 440000, family: 875000, catchUp55: 100000 },
}

describe("GET /api/retirement/state", () => {
  it("returns plan defaults and a heuristically classified account when config.json doesn't exist yet", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Fidelity 401k", offbudget: true, closed: false }] })
    const res = await fetch(`${url}api/retirement/state`)
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard).toEqual({ birthDate: null, retirementAges: [], planToAge: 100 })
    expect(body.currentAge).toBeNull()
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts[0]).toMatchObject({ id: "a1", type: "traditional-401k", isPortfolio: true })
  })

  it("includes every AccountType's metadata, keyed for the client's type picker", async () => {
    const url = await boot()
    const body = await readJson<StateResponse>(await fetch(`${url}api/retirement/state`))
    expect(body.accountTypes["roth-ira"]).toMatchObject({ ruleOf55Eligible: false, limitGroup: "ira" })
    expect(body.accountTypes["traditional-401k"]).toMatchObject({ ruleOf55Eligible: true, limitGroup: "employer-plan" })
    expect(body.accountTypes["inherited-ira"].contributionAllowed).toBe(false)
  })
})

describe("PATCH /api/retirement/plan", () => {
  it("persists a birth date and computes currentAge on the next read", async () => {
    const url = await boot()
    const patchRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01" }) })
    expect(patchRes.status).toBe(200)
    const body = await readJson<StateResponse>(patchRes)
    expect(body.dashboard.birthDate).toBe("1980-01-01")
    expect(body.currentAge).toBeGreaterThan(0)
  })

  it("rejects a non-positive planToAge", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ planToAge: -1 }) })
    expect(res.status).toBe(400)
  })

  it("rejects a retirementAges entry that isn't a positive number", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ retirementAges: [55, -3] }) })
    expect(res.status).toBe(400)
  })
})

describe("PATCH /api/retirement/accounts/:id", () => {
  it("creates an override for an account with none yet, and reflects it on the next state read", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Ally Checking", offbudget: false, closed: false }] })
    const res = await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.accounts[0]).toMatchObject({ id: "a1", type: "brokerage", isPortfolio: true })
  })

  it("rejects an unknown type", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Ally Checking", offbudget: false, closed: false }] })
    const res = await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "bogus" }) })
    expect(res.status).toBe(400)
  })

  it("404s for an id that isn't an open account", async () => {
    const url = await boot({ accounts: [] })
    const res = await fetch(`${url}api/retirement/accounts/nope`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })
    expect(res.status).toBe(404)
  })

  it("rejects a monthlyContribution on an inherited IRA", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Inherited IRA", offbudget: true, closed: false }] })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })
    const res = await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ monthlyContribution: 50000 }) })
    expect(res.status).toBe(400)
  })

  it("resolves a \"max\" contribution once a birth date and IRS limits are available", async () => {
    writeFileSync(irsLimitsPath, JSON.stringify(IRS_LIMITS))
    const url = await boot({ accounts: [{ id: "a1", name: "401k", offbudget: true, closed: false }] })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01" }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })
    const res = await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ monthlyContribution: "max" }) })
    const body = await readJson<StateResponse>(res)
    expect(body.accounts[0]?.monthlyContributionIsMax).toBe(true)
    expect(body.accounts[0]?.monthlyContribution).toBe(Math.round(2450000 / 12))
  })

  it("prunes an override whose account has since closed", async () => {
    const firstUrl = await boot({ accounts: [{ id: "a1", name: "Checking", offbudget: false, closed: false }] })
    await fetch(`${firstUrl}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "cash" }) })

    // a1 has since closed; a2 is the only open account left. Editing it is what triggers the
    // prune, once every currently-open account has been fetched again.
    const secondUrl = await boot({ accounts: [{ id: "a2", name: "Savings", offbudget: false, closed: false }] })
    const res = await fetch(`${secondUrl}api/retirement/accounts/a2`, { method: "PATCH", body: JSON.stringify({ type: "cash" }) })
    const body = await readJson<StateResponse>(res)
    expect(body.accounts.map((a) => a.id)).toEqual(["a2"])
  })
})

describe("POST /api/retirement/generate", () => {
  it("errors clearly when the plan isn't configured yet", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(400)
    const body = await readJson<ErrorBody>(res)
    expect(body.error).toContain("birth date")
  })

  it("writes the dashboard file and returns a structured result once accounts and a plan exist", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [{ id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] }],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await readJson<GenerateResult>(res)
    expect(body.portfolioAccountCount).toBe(1)
    expect(body.portfolioTotal).toBe(500000)
    expect(body.widgetTypes).toContain("crossover-card")
  })
})

describe("GET /api/retirement/check", () => {
  it("reports no Monte Carlo widgets found when the dashboard hasn't been imported yet", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }], dashboardRows: [] })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.monteCarloWidgetCount).toBe(0)
    expect(body.driftFindings[0]?.title).toContain("No Monte Carlo widgets")
  })
})

describe("unknown routes", () => {
  it("404s", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/nonexistent`)
    expect(res.status).toBe(404)
  })
})

describe("network binding", () => {
  it("prints a localhost URL but is reachable via 127.0.0.1 directly, proving it isn't loopback-only bound", async () => {
    await boot()
    expect((server as RunningServer).url).toMatch(/^http:\/\/localhost:\d+\/$/)
    const port = new URL((server as RunningServer).url).port
    const res = await fetch(`http://127.0.0.1:${port}/api/retirement/state`)
    expect(res.status).toBe(200)
  })
})
