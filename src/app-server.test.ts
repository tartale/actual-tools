import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startAppServer } from "./app-server.ts"
import type { RunningServer, StateResponse } from "./app-server.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import { DEFAULT_DASHBOARD_CONFIG } from "./fire-accounts.ts"
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
    if (init?.method === "PATCH" && (/\/months\/[^/]+\/categories\/[^/]+$/.test(u.pathname) || /\/transactions\/[^/]+$/.test(u.pathname))) {
      return jsonResponse({})
    }
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
    expect(body.dashboard).toEqual(DEFAULT_DASHBOARD_CONFIG)
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

  it("persists a crossoverExpenseCategoryIds selection and reflects it on the next read", async () => {
    const url = await boot()
    const patchRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseCategoryIds: ["cat-a", "cat-b"] }) })
    expect(patchRes.status).toBe(200)
    const body = await readJson<StateResponse>(patchRes)
    expect(body.dashboard.crossoverExpenseCategoryIds).toEqual(["cat-a", "cat-b"])
  })

  it("rejects an empty crossoverExpenseCategoryIds array", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseCategoryIds: [] }) })
    expect(res.status).toBe(400)
  })

  it("accepts null to clear a crossoverExpenseCategoryIds selection", async () => {
    const url = await boot()
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseCategoryIds: ["cat-a"] }) })
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseCategoryIds: null }) })
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard.crossoverExpenseCategoryIds).toBeNull()
  })

  it("persists a full set of pinned crossover assumptions", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ crossoverSafeWithdrawalRate: 0.035, crossoverEstimatedReturn: 0.06, crossoverProjectionType: "median", crossoverExpenseAdjustmentFactor: 0.85 }),
    })
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard).toMatchObject({
      crossoverSafeWithdrawalRate: 0.035,
      crossoverEstimatedReturn: 0.06,
      crossoverProjectionType: "median",
      crossoverExpenseAdjustmentFactor: 0.85,
    })
  })

  it("rejects a non-positive crossoverSafeWithdrawalRate", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverSafeWithdrawalRate: 0 }) })
    expect(res.status).toBe(400)
  })

  it("rejects an unrecognized crossoverProjectionType", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverProjectionType: "bogus" }) })
    expect(res.status).toBe(400)
  })

  it("rejects a non-positive crossoverExpenseAdjustmentFactor", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseAdjustmentFactor: 0 }) })
    expect(res.status).toBe(400)
  })

  it("persists a pinned monteCarloWithdrawalRule", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ monteCarloWithdrawalRule: { type: "guardrails", prosperityTriggerPct: 0.2, prosperityIncreasePct: 0.1 } }),
    })
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard.monteCarloWithdrawalRule).toEqual({ type: "guardrails", prosperityTriggerPct: 0.2, prosperityIncreasePct: 0.1 })
  })

  it("rejects a monteCarloWithdrawalRule with an unrecognized type", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ monteCarloWithdrawalRule: { type: "bogus" } }) })
    expect(res.status).toBe(400)
  })

  it("rejects a monteCarloWithdrawalRule with a non-numeric parameter", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ monteCarloWithdrawalRule: { type: "guardrails", prosperityTriggerPct: "high" } }) })
    expect(res.status).toBe(400)
  })

  it("persists an empty monteCarloTaxBands array as a real pinned value", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ monteCarloTaxBands: [] }) })
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard.monteCarloTaxBands).toEqual([])
  })

  it("persists a real monteCarloTaxBands list", async () => {
    const url = await boot()
    const bands = [{ id: "b1", from: 0, rate: 0.1 }, { id: "b2", from: 5000000, rate: 0.22 }]
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ monteCarloTaxBands: bands }) })
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard.monteCarloTaxBands).toEqual(bands)
  })

  it("rejects a monteCarloTaxBands entry missing an id", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ monteCarloTaxBands: [{ from: 0, rate: 0.1 }] }) })
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
    expect(body.spendBasis).toBeNull() // no live crossover selection yet -- used the plain fallback
  })

  it("uses the live crossover widget's own narrower category selection for spend, not every category", async () => {
    // "cat-a" is the crossover's own (narrower) selection; "cat-b" (a one-time/irregular category
    // someone unchecked in Actual) only shows up in the full category list -- generate must not
    // silently fall back to counting it just because it technically exists.
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [
        {
          id: "g1",
          name: "Group",
          is_income: false,
          hidden: false,
          categories: [
            { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1" },
            { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1" },
          ],
        },
      ],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [
        { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false },
        { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -100000, balance: 0, carryover: false },
      ],
      dashboardRows: [
        {
          id: "page1",
          name: "FIRE",
          dashboard_page_id: "page1",
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["cat-a"], incomeAccountIds: [] },
        },
      ],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await readJson<GenerateResult>(res)
    expect(body.expenseCategoryCount).toBe(2) // both categories exist in the budget...
    expect(body.annualSpend).toBe(120000) // ...but spend only counts the crossover's own selection (10000 x 12)
    expect(body.spendBasis).toContain("1 categories")
  })

  it("prefers the Plan section's own expense-category selection over the live crossover widget's, for both spend and the exported widget", async () => {
    // The whole point of the Plan section's own picker: once set, it's authoritative, so narrowing
    // categories never again requires opening Actual -- even when a crossover widget with its own
    // (different) selection is already live.
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [
        {
          id: "g1",
          name: "Group",
          is_income: false,
          hidden: false,
          categories: [
            { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1" },
            { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1" },
          ],
        },
      ],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [
        { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false },
        { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -100000, balance: 0, carryover: false },
      ],
      dashboardRows: [
        {
          id: "page1",
          name: "FIRE",
          dashboard_page_id: "page1",
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["cat-a"], incomeAccountIds: [] },
        },
      ],
    })
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90, crossoverExpenseCategoryIds: ["cat-b"] }),
    })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await readJson<GenerateResult>(res)
    expect(body.annualSpend).toBe(1200000) // 100000 x 12 -- cat-b, not the live widget's cat-a
    expect(body.spendBasis).toContain("Plan section selection")
    const dashboard = JSON.parse(body.dashboardJson) as { widgets: { type: string; meta: { expenseCategoryIds: string[] } | null }[] }
    const crossover = dashboard.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta?.expenseCategoryIds).toEqual(["cat-b"])
  })

  it("applies a pinned crossoverExpenseAdjustmentFactor to the Plan section's own local-selection spend, and pins it onto the exported widget", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [{ id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] }],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90, crossoverExpenseCategoryIds: ["cat-a"], crossoverExpenseAdjustmentFactor: 0.85 }),
    })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await readJson<GenerateResult>(res)
    expect(body.annualSpend).toBe(102000) // 10000 x 12 x 0.85
    expect(body.spendBasis).toContain("× 85% target income")
    const dashboard = JSON.parse(body.dashboardJson) as { widgets: { type: string; meta: { expenseAdjustmentFactor: number } | null }[] }
    const crossover = dashboard.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta?.expenseAdjustmentFactor).toBe(0.85)
  })

  it("applies the crossover widget's own Target Income % to spend, the same way Actual applies it to its own projection", async () => {
    // Actual calls this field "Target Income (% of expenses)" in its own crossover UI
    // (expenseAdjustmentFactor on the wire) and multiplies its own projected-expense figure by it --
    // never the raw historical series. This app's spend assumption has to apply the same multiplier
    // to the same trailing average, or every simulation built on it (Monte Carlo, Bridge, the
    // Current numbers box) silently answers a different question than Actual's own widget does the
    // moment this is set to anything but 100%.
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [{ id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] }],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false }],
      dashboardRows: [
        {
          id: "page1",
          name: "FIRE",
          dashboard_page_id: "page1",
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["cat-a"], incomeAccountIds: [], expenseAdjustmentFactor: 0.9 },
        },
      ],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/generate`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await readJson<GenerateResult>(res)
    expect(body.annualSpend).toBe(108000) // 10000 x 12 x 0.9
    expect(body.spendBasis).toContain("× 90% target income")
  })
})

describe("GET /api/retirement/check", () => {
  it("has no stale findings when the dashboard hasn't been imported yet -- optional, not something to flag", async () => {
    const url = await boot({ accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }], dashboardRows: [] })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.monteCarloWidgetCount).toBe(0)
    expect(body.staleFindings).toEqual([])
  })

  it("reports the same portfolio total, Rule of 55 boosts, and debt payoffs Generate's own result carries", async () => {
    const url = await boot({
      accounts: [
        { id: "a1", name: "Brokerage", offbudget: true, closed: false },
        { id: "401k", name: "Fidelity 401k", offbudget: true, closed: false },
        { id: "mortgage", name: "Mortgage", offbudget: true, closed: false },
      ],
      transactionsByAccount: {
        a1: [{ amount: 5000000, transfer_id: null }], // $50,000
        "401k": [{ amount: 10000000, transfer_id: null }], // $100,000
      },
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })
    // Standard access age (59) beaten down to 55 by an early separation -- the exact boost the
    // "Current numbers" box exists to surface, so it's worth reading before it happens.
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", ruleOf55SeparationAge: 55 }) })
    await fetch(`${url}api/retirement/accounts/mortgage`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "debt",
        mortgageInterestRate: 0.05,
        mortgageMonthlyPayment: 100000, // $1,000/mo
        mortgageBalanceAsOfDate: "2026-01-01",
        mortgageBalanceAsOf: 1000000, // $10,000 -- a handful of months to pay off
      }),
    })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    // Debt accounts are never part of the simulated portfolio -- only the two real pots count.
    expect(body.portfolioAccountCount).toBe(2)
    expect(body.portfolioTotal).toBe(15000000)
    expect(body.ruleOf55Boosts).toEqual([{ accountName: "Fidelity 401k", from: 59, to: 55, amount: 10000000 }])
    expect(body.debtPayoffs).toHaveLength(1)
    expect(body.debtPayoffs[0]).toMatchObject({ accountName: "Mortgage", monthlyAmount: 100000 })
    expect(typeof body.debtPayoffs[0]?.payoffAge).toBe("number")
  })

  it("runs the in-app Monte Carlo simulation once per retirement age, same order as bridgeResults", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 100_000_00, transfer_id: null }] },
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1965-01-01", retirementAges: [61, 65], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage", allocationPreset: "equity-80" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.monteCarloResults).toHaveLength(2)
    expect(body.monteCarloFindings).toHaveLength(2)
    expect(body.monteCarloResults.map((r) => r.retirementAge)).toEqual([61, 65])
    // No endingBalances/depletionYearBySimulation/totalWithdrawnBySimulation/runDetail on the wire
    // -- see MonteCarloSummary's own doc comment for why (Float64Array/Int32Array serialize as a
    // numeric-keyed object over JSON, not a real array, on top of being needlessly large).
    expect(Object.keys(body.monteCarloResults[0] ?? {}).sort()).toEqual(
      ["depletionHistogram", "depletionProbabilityByYear", "earliestDepletionYear", "horizonYears", "latestDepletionYear", "medianDepletionYear", "medianEndingBalance", "medianTotalWithdrawn", "percentileBands", "retirementAge", "simulationCount", "successRate", "worstRunPath"].sort(),
    )
    expect(body.monteCarloFindings[0]?.title).toContain("age 61")
    expect(body.monteCarloFindings[1]?.title).toContain("age 65")
  })

  it("prefers the Plan section's own expense-category selection over the live crossover widget's, on Check too", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      categoryGroups: [
        {
          id: "g1",
          name: "Group",
          is_income: false,
          hidden: false,
          categories: [
            { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1" },
            { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1" },
          ],
        },
      ],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      monthCategories: [
        { id: "cat-a", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false },
        { id: "cat-b", name: "Once-a-year trip", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -100000, balance: 0, carryover: false },
      ],
      dashboardRows: [
        {
          id: "page1",
          name: "FIRE",
          dashboard_page_id: "page1",
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["cat-a"], incomeAccountIds: [] },
        },
      ],
    })
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1980-01-01", retirementAges: [55], planToAge: 90, crossoverExpenseCategoryIds: ["cat-b"] }),
    })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.annualSpend).toBe(1200000) // 100000 x 12 -- cat-b, not the live widget's cat-a
    expect(body.spendBasis).toContain("Plan section selection")
  })

  it("flags a retirement age added since the dashboard was last generated, even though every account already has a live pot", async () => {
    // The real bug: buildMonteCarloWidgets names a widget bare "Monte Carlo" with exactly one
    // configured age, and "Monte Carlo -- Retire at N" once there's more than one -- so a live
    // dashboard generated back when there was a single age matches NONE of the freshly expected
    // names the moment a second age is added. detectPotDrift alone never catches this: the account
    // already has a live pot (from the one existing widget), so nothing there looks wrong either.
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 500000, transfer_id: null }] },
      dashboardRows: [
        {
          id: "w1",
          dashboard_page_id: "page1",
          type: "monte-carlo-card",
          x: 0,
          y: 0,
          width: 12,
          height: 6,
          meta: { name: "Monte Carlo", pots: [{ accountId: "a1", accessAge: null }] },
        },
      ],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [50, 51], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    const titles = body.staleFindings.map((f) => f.title)
    expect(titles).toContain('Actual has no Monte Carlo widget named "Monte Carlo — Retire at 50" yet.')
    expect(titles).toContain('Actual has no Monte Carlo widget named "Monte Carlo — Retire at 51" yet.')
    expect(titles).toContain('"Monte Carlo" is in Actual but no longer matches a configured retirement age.')
  })
})

describe("GET /api/budget/context", () => {
  it("excludes income categories/groups from the picker entirely", async () => {
    const url = await boot({
      categoryGroups: [
        { id: "g1", name: "Everyday", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] },
        { id: "g2", name: "Income", is_income: true, hidden: false, categories: [{ id: "c2", name: "Paycheck", is_income: true, hidden: false, group_id: "g2" }] },
      ],
    })
    const res = await fetch(`${url}api/budget/context`)
    expect(res.status).toBe(200)
    const body = await readJson<{ categoryGroups: { id: string; categories: { id: string }[] }[] }>(res)
    expect(body.categoryGroups.map((g) => g.id)).toEqual(["g1"])
    expect(body.categoryGroups[0]?.categories.map((c) => c.id)).toEqual(["c1"])
  })
})

describe("POST /api/budget/table", () => {
  it("returns budgeted/spent/balance grouped by category group, income excluded", async () => {
    const url = await boot({
      categoryGroups: [
        { id: "g1", name: "Everyday", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] },
        { id: "g2", name: "Income", is_income: true, hidden: false, categories: [{ id: "c2", name: "Paycheck", is_income: true, hidden: false, group_id: "g2" }] },
      ],
      monthCategories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 50000, spent: -45000, balance: 5000, carryover: false }],
    })
    const res = await fetch(`${url}api/budget/table`, { method: "POST", body: JSON.stringify({ startMonth: "2026-01" }) })
    expect(res.status).toBe(200)
    const body = await readJson<{ months: string[]; groups: { id: string; categories: { id: string; months: Record<string, unknown> }[] }[] }>(res)
    expect(body.months).toEqual(["2026-01"])
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]?.categories[0]?.months["2026-01"]).toEqual({ budgeted: 50000, spent: -45000, balance: 5000 })
  })
})

describe("POST /api/budget/set-values", () => {
  it("previews a change without writing when dryRun isn't explicitly false", async () => {
    const url = await boot({
      monthCategories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: 0, balance: 0, carryover: false }],
    })
    const res = await fetch(`${url}api/budget/set-values`, {
      method: "POST",
      body: JSON.stringify({ action: "250", startMonth: "2026-01", categories: ["c1"] }),
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ months: { month: string; lines: { status: string; newBudgeted: number }[] }[] }>(res)
    expect(body.months[0]?.lines[0]).toMatchObject({ status: "would-update", newBudgeted: 25000 })
  })

  it("applies a change when dryRun is explicitly false", async () => {
    const url = await boot({
      monthCategories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: 0, balance: 0, carryover: false }],
    })
    const res = await fetch(`${url}api/budget/set-values`, {
      method: "POST",
      body: JSON.stringify({ action: "250", startMonth: "2026-01", dryRun: false, categories: ["c1"] }),
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ months: { lines: { status: string }[] }[] }>(res)
    expect(body.months[0]?.lines[0]?.status).toBe("updated")
  })

  it("rejects an empty category selection rather than sweeping every category", async () => {
    const url = await boot({
      monthCategories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: 0, balance: 0, carryover: false }],
    })
    const res = await fetch(`${url}api/budget/set-values`, {
      method: "POST",
      body: JSON.stringify({ action: "250", startMonth: "2026-01", categories: [] }),
    })
    expect(res.status).toBe(400)
    expect((await readJson<ErrorBody>(res)).error).toMatch(/at least one category/i)
  })

  it("rejects an unknown action", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/budget/set-values`, { method: "POST", body: JSON.stringify({ action: "not-a-real-action", startMonth: "2026-01" }) })
    expect(res.status).toBe(400)
  })

  it("rejects a category filter that matches an income category", async () => {
    const url = await boot({
      categoryGroups: [{ id: "g1", name: "Income", is_income: true, hidden: false, categories: [] }],
    })
    const res = await fetch(`${url}api/budget/set-values`, {
      method: "POST",
      body: JSON.stringify({ action: "balance", startMonth: "2026-01", categories: ["Income"] }),
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /api/budget/anomalies", () => {
  it("finds nothing when every month's spend is identical to its own history", async () => {
    const url = await boot({
      monthCategories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000, balance: 0, carryover: false }],
    })
    const res = await fetch(`${url}api/budget/anomalies`, {
      method: "POST",
      body: JSON.stringify({ categories: ["c1"], startMonth: "2026-01" }),
    })
    expect(res.status).toBe(200)
    expect(await readJson<{ findings: unknown[] }>(res)).toEqual({ findings: [] })
  })

  it("requires at least one category", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/budget/anomalies`, { method: "POST", body: JSON.stringify({ categories: [], startMonth: "2026-01" }) })
    expect(res.status).toBe(400)
  })
})

describe("static UI files", () => {
  it("serves them with no-store, so an edit is never masked by a cached copy", async () => {
    // Without this the browser is free to apply heuristic freshness (no Cache-Control, no ETag, no
    // Last-Modified to revalidate against) and reuse app.js/style.css without asking, which also
    // silently defeats hot-reload: the page reloads on a new build id and is handed the same stale
    // assets. app.js and style.css cache independently, so the two can drift apart -- fresh markup
    // against styling rules that aren't there any more.
    writeFileSync(join(dir, "index.html"), "<h1>ui</h1>")
    writeFileSync(join(dir, "app.js"), "// ui")
    writeFileSync(join(dir, "style.css"), "body{}")
    const url = await boot()
    for (const file of ["", "app.js", "style.css"]) {
      const res = await fetch(`${url}${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate")
    }
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
