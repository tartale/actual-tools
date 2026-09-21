import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startAppServer } from "./app-server.ts"
import type { RunningServer, StateResponse } from "./app-server.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import { loadActualSession, writeActualSession } from "./actual-session.ts"
import { loadFileDataSourceSession } from "./data-source-session.ts"
import { DEFAULT_DASHBOARD_CONFIG } from "./fire-accounts.ts"
import type { CheckResult } from "./fire-generate.ts"
import type { SuggestionsResult } from "./fire-suggestions.ts"

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
let sessionPath: string
let dataSourceSessionPath: string
let irsLimitsPath: string
let federalTaxBracketsPath: string
let irsLifeExpectancyPath: string
let federalPovertyGuidelinesPath: string
let server: RunningServer | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-server-test-"))
  configPath = join(dir, "config.json")
  sessionPath = join(dir, "session.json")
  dataSourceSessionPath = join(dir, "data-source.json")
  irsLimitsPath = join(dir, "irs-limits.json")
  federalTaxBracketsPath = join(dir, "federal-tax-brackets.json")
  irsLifeExpectancyPath = join(dir, "irs-life-expectancy.json")
  federalPovertyGuidelinesPath = join(dir, "federal-poverty-guidelines.json")
})

afterEach(async () => {
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// Re-booting (a fixture change mid-test, e.g. simulating an account closing between two edits)
// closes any server already running first, so afterEach only ever has one to clean up. Pre-seeds
// the session file with the fixture actualConfig by default -- every existing test here predates
// login/logout and assumes an already-logged-in server, same as when actualConfig was a required
// startup option; the session-specific tests below pass `loggedIn: false` to start logged out
// instead.
async function boot(fixture: FetchFixture = {}, options: { loggedIn?: boolean } = {}): Promise<string> {
  if (server) {
    await server.close()
  }
  vi.stubGlobal("fetch", mockActualFetch(fixture))
  if (options.loggedIn ?? true) {
    writeActualSession(sessionPath, actualConfig)
  }
  server = await startAppServer({ sessionPath, dataSourceSessionPath, configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, federalPovertyGuidelinesPath, uiDir: dir })
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

  it("persists a pinned crossoverExpenseAdjustmentFactor", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseAdjustmentFactor: 0.85 }) })
    expect(res.status).toBe(200)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard).toMatchObject({ crossoverExpenseAdjustmentFactor: 0.85 })
  })

  it("rejects a non-positive crossoverExpenseAdjustmentFactor", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverExpenseAdjustmentFactor: 0 }) })
    expect(res.status).toBe(400)
  })

  it("persists a pinned crossoverSpendHistoryMonths, and reflects it on the next read", async () => {
    const url = await boot()
    const patchRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverSpendHistoryMonths: 6 }) })
    expect(patchRes.status).toBe(200)
    const res = await fetch(`${url}api/retirement/state`)
    const body = await readJson<StateResponse>(res)
    expect(body.dashboard.crossoverSpendHistoryMonths).toBe(6)
  })

  it("rejects a non-positive or non-integer crossoverSpendHistoryMonths", async () => {
    const url = await boot()
    expect((await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverSpendHistoryMonths: 0 }) })).status).toBe(400)
    expect((await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ crossoverSpendHistoryMonths: 3.5 }) })).status).toBe(400)
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

  it("computes a SEPP account's own distribution amount once a method, start age, and the life-expectancy table are all available", async () => {
    // A single-entry table -- lifeExpectancyFactor clamps to whatever's at the end of the array
    // regardless of age, so this fixture doesn't need to be a real, full IRS table to exercise the
    // computation end to end; it only needs one known, controllable factor.
    writeFileSync(irsLifeExpectancyPath, JSON.stringify({ tableRevisionYear: 2022, source: "test", factorByAge: [36.2] }))
    const url = await boot({
      accounts: [{ id: "401k", name: "401k", offbudget: true, closed: false }],
      transactionsByAccount: { "401k": [{ amount: 100000000, transfer_id: null }] }, // $1,000,000
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1976-01-01", retirementAges: [55] }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })
    // seppStartAge below any realistic current age -- projectAccountBalance's own loop (currentAge
    // to targetAge) never runs, leaving the balance exactly $1,000,000 rather than growing it, so
    // the expected amount stays a plain, exact division.
    const res = await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ seppMethod: "rmd", seppStartAge: 1 }) })
    const body = await readJson<StateResponse>(res)
    // $1,000,000 / 36.2 = $27,624.31
    expect(body.accounts[0]?.seppAnnualAmount).toBe(2762431)
  })

  it("leaves a SEPP account's distribution amount null until a method and start age are both set", async () => {
    writeFileSync(irsLifeExpectancyPath, JSON.stringify({ tableRevisionYear: 2022, source: "test", factorByAge: [36.2] }))
    const url = await boot({
      accounts: [{ id: "401k", name: "401k", offbudget: true, closed: false }],
      transactionsByAccount: { "401k": [{ amount: 100000000, transfer_id: null }] },
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1976-01-01", retirementAges: [55] }) })
    const res = await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", seppMethod: "rmd" }) })
    const body = await readJson<StateResponse>(res)
    expect(body.accounts[0]?.seppAnnualAmount).toBeNull()
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

describe("GET /api/retirement/check", () => {
  it("reports the plan's own portfolio total, Rule of 55 boosts, and debt payoffs", async () => {
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
    // amount is the account's $100,000 balance PROJECTED forward from today's age to the boosted
    // access age (55), not the raw current balance -- see projectAccountBalance in fire-analysis.ts.
    expect(body.ruleOf55Boosts).toEqual([{ accountName: "Fidelity 401k", from: 59, to: 55, amount: 12864663.50625 }])
    expect(body.debtPayoffs).toHaveLength(1)
    expect(body.debtPayoffs[0]).toMatchObject({ accountName: "Mortgage", monthlyAmount: 100000 })
    expect(typeof body.debtPayoffs[0]?.payoffAge).toBe("number")
  })

  it("does not report an early-withdrawal-penalty account as a Rule of 55 boost", async () => {
    const url = await boot({
      accounts: [{ id: "roth", name: "E*Trade Roth IRA", offbudget: true, closed: false }],
      transactionsByAccount: { roth: [{ amount: 10000000, transfer_id: null }] }, // $100,000
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    // effectiveAccessAge changes here too (to null, same as a Rule of 55 boost would produce), but
    // it's a different reported figure entirely -- a chosen posture, not an employment exception --
    // and belongs in neither ruleOf55Boosts nor a "Rule of 55, age null" tile.
    await fetch(`${url}api/retirement/accounts/roth`, { method: "PATCH", body: JSON.stringify({ type: "roth-ira", earlyWithdrawalPenalty: true }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.ruleOf55Boosts).toEqual([])
  })

  it("does not report a SEPP-electing account as a Rule of 55 boost either", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      transactionsByAccount: { "401k": [{ amount: 10000000, transfer_id: null }] }, // $100,000
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", seppMethod: "rmd", seppStartAge: 50 }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.ruleOf55Boosts).toEqual([])
  })

  const FEDERAL_TAX_BRACKETS_FIXTURE = {
    taxYear: 2026,
    source: "https://example.com",
    standardDeduction: { single: 1610000, marriedFilingJointly: 3220000, headOfHousehold: 2415000 },
    brackets: {
      single: [{ rate: 0.1, upTo: 1240000 }, { rate: 0.12, upTo: 5040000 }, { rate: 0.22, upTo: null }],
      marriedFilingJointly: [{ rate: 0.1, upTo: null }],
      headOfHousehold: [{ rate: 0.1, upTo: null }],
    },
  }

  it("adds a MAGI finding alongside the funding-status one when filing status and tax brackets are both set", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 100_000_00, transfer_id: null }] },
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single" }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    // One funding-status finding plus one MAGI finding for the single configured retirement age.
    expect(body.bridgeFindings).toHaveLength(2)
    expect(body.bridgeFindings.some((f) => f.title.includes("est. MAGI"))).toBe(true)
  })

  it("estimates $0 tax-deferred withdrawal when the only portfolio account is still locked at the retirement age -- the early-retirement/FIRE case", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { "401k": [{ amount: 500_000_00, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    // Retiring at 51, well before a traditional-401k's own default 59 access age -- the whole
    // portfolio is locked at that age, so the real withdrawal can't be tax-deferred at all.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [51], planToAge: 90, filingStatus: "single" }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.annualSpend).toBeGreaterThan(0) // a real, nonzero withdrawal need -- not a vacuous $0 test
    const magi = body.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magi?.detail[0]).toContain("$0.00 tax-deferred")
  })

  it("respects withdrawalOrder in the MAGI estimate, favoring an ordered-first taxable pot over a proportional blend", async () => {
    const boot0 = {
      accounts: [
        { id: "cash", name: "Brokerage", offbudget: true, closed: false },
        { id: "401k", name: "Fidelity 401k", offbudget: true, closed: false },
      ],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { cash: [{ amount: 50_000_00, transfer_id: null }], "401k": [{ amount: 500_000_00, transfer_id: null }] },
      // $2,000/mo = $24,000/yr -- comfortably covered by the $50,000 taxable pot alone.
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    }
    const url = await boot(boot0)
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [51], planToAge: 90, filingStatus: "single" }) })
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })
    // Accepting the 10% penalty makes the 401k reachable immediately, well before its own default
    // access age -- the exact combination that used to spike this estimate (see allocateWithdrawal's
    // own doc comment): with no order set, the withdrawal is assumed proportional across both
    // reachable pots even though the smaller, untouched cash pot alone could cover it.
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", earlyWithdrawalPenalty: true }) })

    const beforeOrder = await readJson<CheckResult>(await fetch(`${url}api/retirement/check`))
    const magiBefore = beforeOrder.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magiBefore?.detail[0]).not.toContain("$0.00 tax-deferred")

    // Draining the cash pot first (order 0) before ever touching the 401k (order 1) is exactly what
    // Actual's own Monte Carlo widget already does with this same field -- now the bridge/MAGI
    // estimate agrees with it instead of assuming a proportional blend.
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ withdrawalOrder: 0 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ withdrawalOrder: 1 }) })

    const afterOrder = await readJson<CheckResult>(await fetch(`${url}api/retirement/check`))
    const magiAfter = afterOrder.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magiAfter?.detail[0]).toContain("$0.00 tax-deferred")
  })

  const FEDERAL_POVERTY_GUIDELINES_FIXTURE = {
    guidelineYear: 2025,
    source: "https://example.com",
    base: 1565000, // $15,650
    perAdditionalPerson: 550000, // $5,500
    subsidyCliffAt400Pct: true,
  }

  it("finds the ACA cliff crossing where the trajectory actually depletes non-taxable, not where today's un-depleted balance alone would hide it", async () => {
    // Regression: magiInputsAt used to rebuild its own withdrawal allocation from TODAY's real
    // account balances at every age, rather than reading the real trajectory simulateBridge already
    // computed. $300,000 cash comfortably covers any SINGLE year's $96,000 spend on its own, so a
    // fresh one-year check re-run at every age (the old bug) always found the cash pot sufficient and
    // reported $0 tax-deferred forever -- even though the real, cumulative trajectory drains that
    // same $300,000 in a little over 3 years and has to draw six figures a year of tax-deferred money
    // from age 54 on, comfortably over the ACA cliff.
    const url = await boot({
      accounts: [
        { id: "cash", name: "Brokerage", offbudget: true, closed: false },
        { id: "401k", name: "Fidelity 401k", offbudget: true, closed: false },
      ],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { cash: [{ amount: 300_000_00, transfer_id: null }], "401k": [{ amount: 2_000_000_00, transfer_id: null }] },
      // $8,000/mo = $96,000/yr -- well within a single year of the $300,000 cash pot alone, but the
      // cash pot only actually covers a little over 3 years cumulatively.
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -8000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [51], planToAge: 90, filingStatus: "single", householdSize: 1 }),
    })
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ type: "brokerage", withdrawalOrder: 0 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", earlyWithdrawalPenalty: true, withdrawalOrder: 1 }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.acaCliffCrossings).toHaveLength(1)
    // The $300,000 cash pot covers ages 51-53 in full (~$96,000/yr each), running out partway
    // through age 54 -- the rest of that year's spend (and the tax gross-up on withdrawing it)
    // has to come from the 401k, comfortably over 400% of a household-of-1 FPL ($62,600) on its
    // own. The old bug reported this scenario as never crossing at all.
    expect(body.acaCliffCrossings).toEqual([{ retirementAge: 51, crossesAtAge: 54, pctFPL: 902.1 }])
  })

  it("keeps the MAGI finding's tax-deferred draw at $0 once a %FPL ceiling is set, even with no explicit withdrawalOrder", async () => {
    // Regression: an earlier reserve-pacing design (medicareAge-triggered) always spread the WHOLE
    // non-taxable pot evenly across every pre-Medicare year regardless of whether that helped --
    // when non-taxable was small relative to spend, that forced a tax-deferred draw in EVERY year
    // instead of none, moving a real ACA cliff crossing from age 97 to age 53 in live data. This
    // design has no such failure mode: non-taxable is drawn first, fully, uncapped -- exactly the
    // same "prefer non-taxable" behavior withdrawalOrder gives explicitly, but automatic the moment
    // a ceiling is set, since using it never raises MAGI.
    const url = await boot({
      accounts: [
        { id: "cash", name: "Brokerage", offbudget: true, closed: false },
        { id: "401k", name: "Fidelity 401k", offbudget: true, closed: false },
      ],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { cash: [{ amount: 50_000_00, transfer_id: null }], "401k": [{ amount: 500_000_00, transfer_id: null }] },
      // $2,000/mo = $24,000/yr -- comfortably covered by the $50,000 taxable pot alone.
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [51], planToAge: 90, filingStatus: "single", householdSize: 1 }) })
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })
    // Accepting the 10% penalty makes the 401k reachable immediately -- no withdrawalOrder set on
    // either account, so without a ceiling this would fall back to proportional (a blended draw
    // from both, per the withdrawalOrder tests elsewhere in this file).
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", earlyWithdrawalPenalty: true }) })

    const beforeCeiling = await readJson<CheckResult>(await fetch(`${url}api/retirement/check`))
    const magiBefore = beforeCeiling.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magiBefore?.detail[0]).not.toContain("$0.00 tax-deferred")

    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaTargetPctFpl: 300 }) })
    const afterCeiling = await readJson<CheckResult>(await fetch(`${url}api/retirement/check`))
    const magiAfter = afterCeiling.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magiAfter?.detail[0]).toContain("$0.00 tax-deferred")
  })

  it("lets tax-deferred exceed the %FPL ceiling as a last resort, rather than falsely reporting a funding shortfall", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      // No non-taxable pot at all -- the 100% FPL ceiling below ($15,650 for a household of 1)
      // can't possibly be honored against a $60,000/yr need, so the overflow tier has to cover the
      // whole shortfall from tax-deferred anyway.
      transactionsByAccount: { "401k": [{ amount: 1_000_000_00, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -5000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single", householdSize: 1, acaTargetPctFpl: 100 }),
    })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", earlyWithdrawalPenalty: true }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    const bridge = body.bridgeFindings.find((f) => f.title.startsWith("age 65"))
    // Not a false "runs out" -- the cap only limits WHERE the withdrawal nominally comes from, not
    // whether the year actually gets funded.
    expect(bridge?.title).toContain("funds every year until age 90")
    // The ceiling genuinely can't be honored here -- correctly still reported as a crossing, not
    // silently hidden by the cap.
    expect(body.acaCliffCrossings.length).toBeGreaterThan(0)
  })

  it("rejects an ACA floor that isn't strictly below the ceiling", async () => {
    const url = await boot()
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaTargetPctFpl: 100 }) })
    // Equal to the ceiling, not just above it -- also invalid; there'd be no real gap for a
    // conversion to land in.
    const equalRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaFloorPctFpl: 100 }) })
    expect(equalRes.status).toBe(400)
    const aboveRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaFloorPctFpl: 138 }) })
    expect(aboveRes.status).toBe(400)
    expect((await readJson<ErrorBody>(aboveRes)).error).toContain("must be less than")
    // The other direction -- floor already set, then lowering the ceiling underneath it -- is
    // rejected too, since the check re-validates whichever of the two fields this PATCH touches
    // against the other's CURRENT value, not just the field being changed in isolation.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaTargetPctFpl: 300, acaFloorPctFpl: 138 }) })
    const loweredRes = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaTargetPctFpl: 100 }) })
    expect(loweredRes.status).toBe(400)
  })

  it("rejects an acaFloorPctFpl that isn't 100 or 138", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ acaFloorPctFpl: 150 }) })
    expect(res.status).toBe(400)
  })

  it("converts to Roth to keep MAGI at the ACA subsidy floor once non-taxable alone would otherwise leave it at $0", async () => {
    const url = await boot({
      accounts: [
        { id: "cash", name: "Brokerage", offbudget: true, closed: false },
        { id: "401k", name: "401k", offbudget: true, closed: false },
        { id: "roth", name: "Roth IRA", offbudget: true, closed: false },
      ],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      // $300,000 cash comfortably covers $24,000/yr on its own for the whole horizon -- without
      // the floor, MAGI would stay $0.00 the entire time (same reasoning as the "keeps the MAGI
      // finding's tax-deferred draw at $0" test above, just with a floor instead of a ceiling).
      transactionsByAccount: { cash: [{ amount: 300_000_00, transfer_id: null }], "401k": [{ amount: 500_000_00, transfer_id: null }], roth: [{ amount: 0, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single", householdSize: 1, acaFloorPctFpl: 100 }),
    })
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ type: "brokerage", withdrawalOrder: 0 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", withdrawalOrder: 1 }) })
    await fetch(`${url}api/retirement/accounts/roth`, { method: "PATCH", body: JSON.stringify({ type: "roth-ira", withdrawalOrder: 2 }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    const firstYear = body.bridgeResults[0]?.timeline.find((point) => point.age === 65)
    // The real withdrawal alone still needs nothing from tax-deferred -- cash alone covers it.
    expect(firstYear?.grossTaxDeferredWithdrawal).toBe(0)
    // But a real conversion tops MAGI up to the floor anyway -- checked as %FPL (100), not a raw
    // dollar figure, since the guideline itself is inflated forward to age 65's own nominal
    // dollars (inflateGuideline) and a raw-dollar assertion would have to duplicate that same
    // compounding math to know what to expect.
    expect(firstYear?.rothConversionAmount).toBeGreaterThan(0)
    expect(firstYear?.pctFPL).toBeGreaterThan(99)
    expect(firstYear?.pctFPL).toBeLessThanOrEqual(100.1) // binary search converges within a cent or two, never past it
    const magiFinding = body.bridgeFindings.find((f) => f.title.includes("est. MAGI"))
    expect(magiFinding?.detail.some((line) => line.includes("Roth conversion"))).toBe(true)
  })

  it("never converts to Roth once Medicare age is reached -- there's no ACA marketplace coverage left to protect", async () => {
    const url = await boot({
      accounts: [
        { id: "cash", name: "Brokerage", offbudget: true, closed: false },
        // A real tax-deferred source has to exist for this test to actually exercise the
        // medicareAge gate -- otherwise there's nothing to convert FROM regardless of age, and
        // the test would pass for the wrong reason.
        { id: "401k", name: "401k", offbudget: true, closed: false },
        { id: "roth", name: "Roth IRA", offbudget: true, closed: false },
      ],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: {
        cash: [{ amount: 300_000_00, transfer_id: null }],
        "401k": [{ amount: 500_000_00, transfer_id: null }],
        roth: [{ amount: 0, transfer_id: null }],
      },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      // retirementAges=65, medicareAge=65 -- the floor never gets a single year to apply.
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 70, filingStatus: "single", householdSize: 1, acaFloorPctFpl: 100, medicareAge: 65 }),
    })
    await fetch(`${url}api/retirement/accounts/cash`, { method: "PATCH", body: JSON.stringify({ type: "brokerage", withdrawalOrder: 0 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", withdrawalOrder: 1 }) })
    await fetch(`${url}api/retirement/accounts/roth`, { method: "PATCH", body: JSON.stringify({ type: "roth-ira", withdrawalOrder: 2 }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.bridgeResults[0]?.timeline.every((point) => point.rothConversionAmount === undefined)).toBe(true)
  })

  it("marks the age a scenario's MAGI crosses the ACA subsidy cliff", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { ira: [{ amount: 500_000_00, transfer_id: null }] },
      // $10,000/mo = $120,000/yr -- an inherited IRA has no accessAge (always reachable) and is
      // tax-deferred, so the whole withdrawal counts, comfortably clearing 400% of a household-of-1
      // FPL ($62,600).
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single", householdSize: 1 }),
    })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.acaCliffCrossings).toHaveLength(1)
    expect(body.acaCliffCrossings[0]).toMatchObject({ retirementAge: 65, crossesAtAge: 65 })
    expect(body.acaCliffCrossings[0]?.pctFPL).toBeGreaterThan(400)
    // The Bridge table's own per-row magi/pctFPL (added for issue #25) reuse the exact same
    // pipeline the crossing above was computed from -- they can never disagree.
    const crossingYear = body.bridgeResults[0]?.timeline.find((point) => point.age === 65)
    expect(crossingYear?.pctFPL).toBeCloseTo(body.acaCliffCrossings[0]?.pctFPL as number, 1)
    // $120,000/yr net spend, fully tax-deferred -- comfortably over $100,000 gross.
    expect(crossingYear?.magi).toBeGreaterThan(100_000_00)
  })

  it("leaves magi/pctFPL unset on Bridge table rows when filing status or tax brackets aren't loaded", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { ira: [{ amount: 500_000_00, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -10000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    // No FEDERAL_TAX_BRACKETS_FIXTURE/FEDERAL_POVERTY_GUIDELINES_FIXTURE written this time.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.bridgeResults[0]?.timeline.every((point) => point.magi === undefined && point.pctFPL === undefined)).toBe(true)
  })

  it("reports no cliff crossing when a scenario's MAGI stays under 400% FPL the whole way", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      transactionsByAccount: { ira: [{ amount: 500_000_00, transfer_id: null }] },
      // $1,000/mo = $12,000/yr, well under 400% of even a household-of-1 FPL.
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -1000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single", householdSize: 1 }),
    })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.acaCliffCrossings).toEqual([])
  })

  it("doesn't manufacture a crossing decades out purely from nominal inflation on an unchanging real %FPL", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      // Large enough that 30 years of a withdrawal need growing at the plan's own 3% default
      // inflationMean never depletes it -- isolates the guideline-inflation fix from the unrelated
      // depletion-cutoff behavior covered by the test below.
      transactionsByAccount: { ira: [{ amount: 2_000_000_00, transfer_id: null }] },
      // $2,600/mo = $31,200/yr, about 199% of a household-of-1 FPL ($15,650) at retirement -- well
      // under the 400% cliff, and stays exactly that far under it in REAL terms for the plan's whole
      // 30-year horizon (nothing here ever actually changes real affordability). Before the fix, the
      // static (non-inflated) guideline this was compared against made the ratio drift upward by
      // nominal inflation alone, crossing 400% around age 72 despite nothing real having changed.
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2600_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 95, filingStatus: "single", householdSize: 1 }),
    })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.acaCliffCrossings).toEqual([])
  })

  it("never marks a cliff crossing at or after the age the scenario itself runs dry", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: [
        { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
      ],
      // $200,000 against $24,000/yr of spend runs dry at age 75 -- well under 400% FPL on its own
      // (magiInputsAt's own withdrawal-based MAGI never crosses here).
      transactionsByAccount: { ira: [{ amount: 200_000_00, transfer_id: null }] },
      monthCategories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -2000_00, balance: 0, carryover: false }],
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    // A pension starting at 80 -- AFTER the age-75 depletion above -- large enough on its own
    // (766% FPL, confirmed directly against estimateMagi) that without the depletion cutoff this
    // would still mark a crossing at 80, well past the point the chart already shows $0 accessible.
    await fetch(`${url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single", householdSize: 1, pensionStartAge: 80, pensionMonthlyAmount: 10000_00 }),
    })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    const bridge = body.bridgeFindings.find((f) => f.title.startsWith("age 65"))
    expect(bridge?.title).toContain("runs out at age 75")
    expect(body.acaCliffCrossings).toEqual([])
    // The Bridge table's own per-row magi/pctFPL leave the depletion year itself unset -- no real
    // withdrawal was ever computed for it (it never reached the allocation), so there's nothing
    // real to base a MAGI estimate on. The year right before it still gets a real figure.
    const depletionYear = body.bridgeResults[0]?.timeline.find((point) => point.age === 75)
    expect(depletionYear?.magi).toBeUndefined()
    expect(depletionYear?.pctFPL).toBeUndefined()
    const lastFundedYear = body.bridgeResults[0]?.timeline.find((point) => point.age === 74)
    expect(lastFundedYear?.magi).toBeGreaterThan(0)
  })

  it("reports no cliff crossing when household size isn't set, even with poverty guidelines available", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 100_000_00, transfer_id: null }] },
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    writeFileSync(federalPovertyGuidelinesPath, JSON.stringify(FEDERAL_POVERTY_GUIDELINES_FIXTURE))
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single" }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.acaCliffCrossings).toEqual([])
  })

  it("omits the MAGI finding when filing status isn't set, even with tax brackets available", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 100_000_00, transfer_id: null }] },
      dashboardRows: [],
    })
    writeFileSync(federalTaxBracketsPath, JSON.stringify(FEDERAL_TAX_BRACKETS_FIXTURE))
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.bridgeFindings).toHaveLength(1)
    expect(body.bridgeFindings.some((f) => f.title.includes("est. MAGI"))).toBe(false)
  })

  it("omits the MAGI finding when the tax-bracket file isn't available, even with filing status set", async () => {
    const url = await boot({
      accounts: [{ id: "a1", name: "Brokerage", offbudget: true, closed: false }],
      transactionsByAccount: { a1: [{ amount: 100_000_00, transfer_id: null }] },
      dashboardRows: [],
    })
    // No writeFileSync for federalTaxBracketsPath here -- loadFederalTaxBrackets sees a missing file.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1970-01-01", retirementAges: [65], planToAge: 90, filingStatus: "single" }) })
    await fetch(`${url}api/retirement/accounts/a1`, { method: "PATCH", body: JSON.stringify({ type: "brokerage" }) })

    const res = await fetch(`${url}api/retirement/check`)
    expect(res.status).toBe(200)
    const body = await readJson<CheckResult>(res)
    expect(body.bridgeFindings).toHaveLength(1)
    expect(body.bridgeFindings.some((f) => f.title.includes("est. MAGI"))).toBe(false)
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
})

describe("GET /api/retirement/suggestions", () => {
  // Shared across every test below -- a real, nonzero spend need is what makes a locked-until-59
  // account's balance actually matter (a $0 spend need would never deplete anything, locked or
  // not, and every what-if would look identical to baseline).
  const categoryGroupsFixture = [
    { id: "g1", name: "Group", is_income: false, hidden: false, categories: [{ id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1" }] },
  ]
  const monthCategoriesFixture = [
    { id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -4000_00, balance: 0, carryover: false }, // $48,000/yr
  ]

  it("suggests Rule of 55 for an eligible account whose unused early-access option would help", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { "401k": [{ amount: 100_000_00, transfer_id: null }] }, // $100,000
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    // Retiring at 55 -- the 401k's own default access age (59) locks the entire portfolio until
    // then, so the bridge runs dry immediately at retirement unless Rule of 55 unlocks it early.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    expect(res.status).toBe(200)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.targetRetirementAge).toBe(55)
    // A traditional-401k independently qualifies for both mechanisms (Rule of 55 AND SEPP are not
    // mutually exclusive -- see effectiveAccessAge's own doc comment), and unlocking the account
    // either way helps here, so both are suggested. No IRS life-expectancy table is loaded in this
    // test, so the SEPP suggestion's own amounts come back null (absent, not an error).
    expect(body.suggestions).toEqual([
      { kind: "rule-of-55", accountId: "401k", accountName: "Fidelity 401k" },
      {
        kind: "sepp",
        accountId: "401k",
        accountName: "Fidelity 401k",
        methodOptions: [
          { method: "rmd", annualAmount: null },
          { method: "amortization", annualAmount: null },
        ],
      },
    ])
  })

  it("does not suggest Rule of 55 once a separation age is already set", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { "401k": [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    // A separation age is already set -- 57, worse than the 55 this route would otherwise suggest,
    // so this also confirms the route doesn't try to suggest IMPROVING an existing election, only
    // ever electing one that isn't set at all (see generateSuggestions' own gate). SEPP is a
    // separate, independent election (still unset), and DOES still get suggested since electing it
    // would unlock the account even earlier (55) than the existing Rule of 55 setting (57) does.
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k", ruleOf55SeparationAge: 57 }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.suggestions).toEqual([
      {
        kind: "sepp",
        accountId: "401k",
        accountName: "Fidelity 401k",
        methodOptions: [
          { method: "rmd", annualAmount: null },
          { method: "amortization", annualAmount: null },
        ],
      },
    ])
  })

  it("does not suggest Rule of 55 for an account type that isn't eligible for it", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Vanguard IRA", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { ira: [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    // traditional-ira is tax-deferred (so still SEPP-eligible below) but not Rule of 55-eligible --
    // no employer plan to separate from.
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "traditional-ira" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.suggestions.every((s) => s.kind !== "rule-of-55")).toBe(true)
  })

  it("does not suggest SEPP once a method is already elected", async () => {
    const url = await boot({
      accounts: [{ id: "ira", name: "Vanguard IRA", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { ira: [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    // A SEPP election is already made -- start age 58, worse than the 55 this route would otherwise
    // suggest -- so this confirms the route doesn't try to suggest IMPROVING an existing election,
    // same as the Rule of 55 case above (traditional-ira isn't Rule of 55-eligible, so this isolates
    // the SEPP gate specifically -- no other suggestion is possible here either way).
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "traditional-ira", seppMethod: "rmd", seppStartAge: 58 }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.suggestions).toEqual([])
  })

  it("suggests a SEPP election for a tax-deferred account whose unused early-access option would help, with both methods' amounts computed", async () => {
    writeFileSync(irsLifeExpectancyPath, JSON.stringify({ tableRevisionYear: 2022, source: "test", factorByAge: [36.2] }))
    const url = await boot({
      accounts: [{ id: "ira", name: "Vanguard IRA", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { ira: [{ amount: 100_000_000, transfer_id: null }] }, // $1,000,000
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/ira`, { method: "PATCH", body: JSON.stringify({ type: "traditional-ira" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    // $1,000,000 / 36.2 = $27,624.31 -- both methods land on the same figure here since no
    // seppInterestRate is set (amortization's rate defaults to 0, collapsing to the same plain
    // division as RMD).
    expect(body.suggestions).toEqual([
      {
        kind: "sepp",
        accountId: "ira",
        accountName: "Vanguard IRA",
        methodOptions: [
          { method: "rmd", annualAmount: 2762431 },
          { method: "amortization", annualAmount: 2762431 },
        ],
      },
    ])
  })

  it("does not suggest anything for an account with nothing left to unlock", async () => {
    const url = await boot({
      accounts: [{ id: "inh", name: "Inherited IRA", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { inh: [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }) })
    // An inherited IRA has no accessAge at all (unconditionally accessible) -- neither mechanism has
    // anything left to grant.
    await fetch(`${url}api/retirement/accounts/inh`, { method: "PATCH", body: JSON.stringify({ type: "inherited-ira" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.suggestions).toEqual([])
  })

  it("does not suggest anything when the account is already accessible by the target retirement age", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { "401k": [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    // Retiring at 60 -- past the 401k's own default access age (59) already, so there's no locked
    // period left for either mechanism to improve on.
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [60], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.suggestions).toEqual([])
  })

  it("targets only the lowest of multiple configured retirement ages", async () => {
    const url = await boot({
      accounts: [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }],
      categoryGroups: categoryGroupsFixture,
      transactionsByAccount: { "401k": [{ amount: 100_000_00, transfer_id: null }] },
      monthCategories: monthCategoriesFixture,
      dashboardRows: [],
    })
    await fetch(`${url}api/retirement/plan`, { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55, 65], planToAge: 90 }) })
    await fetch(`${url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })

    const res = await fetch(`${url}api/retirement/suggestions`)
    const body = await readJson<SuggestionsResult>(res)
    expect(body.targetRetirementAge).toBe(55)
    // Same independent-eligibility reasoning as the first test in this block above.
    expect(body.suggestions).toEqual([
      { kind: "rule-of-55", accountId: "401k", accountName: "Fidelity 401k" },
      {
        kind: "sepp",
        accountId: "401k",
        accountName: "Fidelity 401k",
        methodOptions: [
          { method: "rmd", annualAmount: null },
          { method: "amortization", annualAmount: null },
        ],
      },
    ])
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

describe("/api/session", () => {
  it("reports logged out when no session has ever been saved", async () => {
    const url = await boot({}, { loggedIn: false })
    const res = await fetch(`${url}api/session`)
    expect(res.status).toBe(200)
    expect(await readJson<{ loggedIn: boolean }>(res)).toEqual({ loggedIn: false })
  })

  it("reports the logged-in server/budget but never the api key", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/session`)
    const body = await readJson<{ loggedIn: boolean; baseUrl: string; budgetId: string }>(res)
    expect(body).toEqual({ loggedIn: true, baseUrl: actualConfig.baseUrl, budgetId: actualConfig.budgetId })
    expect(JSON.stringify(body)).not.toContain(actualConfig.apiKey)
  })

  it("logs in, persists the session, and lets a follow-up route that needs it succeed", async () => {
    const url = await boot({ accounts: [] }, { loggedIn: false })
    const res = await fetch(`${url}api/session`, {
      method: "POST",
      body: JSON.stringify(actualConfig),
    })
    expect(res.status).toBe(200)
    expect(await readJson<{ loggedIn: boolean }>(res)).toEqual({ loggedIn: true, baseUrl: actualConfig.baseUrl, budgetId: actualConfig.budgetId })
    expect(loadActualSession(sessionPath)).toEqual(actualConfig)

    const stateRes = await fetch(`${url}api/retirement/state`)
    expect(stateRes.status).toBe(200)
  })

  it("rejects a login with a blank field before ever calling Actual", async () => {
    const url = await boot({}, { loggedIn: false })
    const res = await fetch(`${url}api/session`, {
      method: "POST",
      body: JSON.stringify({ baseUrl: actualConfig.baseUrl, budgetId: "", apiKey: actualConfig.apiKey }),
    })
    expect(res.status).toBe(400)
    expect(loadActualSession(sessionPath)).toBeNull()
  })

  it("rejects a login whose credentials don't actually work, and saves nothing", async () => {
    const url = await boot({}, { loggedIn: false })
    const res = await fetch(`${url}api/session`, {
      method: "POST",
      // .invalid is reserved (RFC 2606) to never resolve -- exercises the real "Actual didn't
      // answer" failure path with no extra mock needed.
      body: JSON.stringify({ baseUrl: "https://actual-wrong.test.invalid/v1", budgetId: "budget-1", apiKey: "secret-key" }),
    })
    expect(res.status).toBe(400)
    expect(loadActualSession(sessionPath)).toBeNull()
  })

  it("logs out: clears the persisted session and any route that needs it stops working", async () => {
    const url = await boot()
    const res = await fetch(`${url}api/session`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await readJson<{ loggedIn: boolean }>(res)).toEqual({ loggedIn: false })
    expect(loadActualSession(sessionPath)).toBeNull()

    const stateRes = await fetch(`${url}api/retirement/state`)
    expect(stateRes.status).toBe(400)
    expect((await readJson<ErrorBody>(stateRes)).error).toContain("Not logged in")
  })
})

describe("/api/data-source", () => {
  it("reports Actual-sync mode when no file has ever been imported", async () => {
    const url = await boot({}, { loggedIn: false })
    const res = await fetch(`${url}api/data-source`)
    expect(res.status).toBe(200)
    expect(await readJson<{ mode: string }>(res)).toEqual({ mode: "actual" })
  })

  it("imports a file: validates it parses, persists the session, and switches /api/retirement/state to its rows instead of Actual's", async () => {
    const filePath = join(dir, "accounts.csv")
    writeFileSync(filePath, "name,balance\nManual Brokerage,50000.00\n")
    const url = await boot({ accounts: [{ id: "a1", name: "Actual Checking", offbudget: true, closed: false }] }, { loggedIn: false })

    const res = await fetch(`${url}api/data-source`, { method: "POST", body: JSON.stringify({ filePath }) })
    expect(res.status).toBe(200)
    const body = await readJson<{ mode: string; filePath: string; lastLoadedAt: string; available: boolean; error: string | null }>(res)
    expect(body).toMatchObject({ mode: "file", filePath, available: true, error: null })
    expect(typeof body.lastLoadedAt).toBe("string")
    expect(loadFileDataSourceSession(dataSourceSessionPath)).toEqual({ filePath, lastLoadedAt: body.lastLoadedAt })

    const stateRes = await fetch(`${url}api/retirement/state`)
    expect(stateRes.status).toBe(200)
    const state = await readJson<StateResponse>(stateRes)
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]).toMatchObject({ id: "manual-brokerage", name: "Manual Brokerage" })
  })

  it("rejects a file that fails to parse, and saves nothing", async () => {
    const filePath = join(dir, "bad.csv")
    writeFileSync(filePath, "not,the,right,header\n")
    const url = await boot({}, { loggedIn: false })

    const res = await fetch(`${url}api/data-source`, { method: "POST", body: JSON.stringify({ filePath }) })
    expect(res.status).toBe(400)
    expect(loadFileDataSourceSession(dataSourceSessionPath)).toBeNull()
  })

  it("rejects an empty filePath before ever touching the filesystem", async () => {
    const url = await boot({}, { loggedIn: false })
    const res = await fetch(`${url}api/data-source`, { method: "POST", body: JSON.stringify({ filePath: "" }) })
    expect(res.status).toBe(400)
    expect(loadFileDataSourceSession(dataSourceSessionPath)).toBeNull()
  })

  it("GET re-probes the file live and warns (without clearing the session) once it goes missing", async () => {
    const filePath = join(dir, "accounts.csv")
    writeFileSync(filePath, "name,balance\nManual Brokerage,50000.00\n")
    const url = await boot({}, { loggedIn: false })
    const importRes = await fetch(`${url}api/data-source`, { method: "POST", body: JSON.stringify({ filePath }) })
    const imported = await readJson<{ lastLoadedAt: string }>(importRes)

    rmSync(filePath)
    const res = await fetch(`${url}api/data-source`)
    expect(res.status).toBe(200)
    const body = await readJson<{ mode: string; available: boolean; error: string | null; lastLoadedAt: string }>(res)
    expect(body.mode).toBe("file")
    expect(body.available).toBe(false)
    expect(body.error).toBeTruthy()
    // The last KNOWN-GOOD timestamp stays put -- a failed probe never advances it.
    expect(body.lastLoadedAt).toBe(imported.lastLoadedAt)
    expect(loadFileDataSourceSession(dataSourceSessionPath)).toEqual({ filePath, lastLoadedAt: imported.lastLoadedAt })

    // Doesn't interrupt the flow -- /api/retirement/state still resolves an error (currently
    // logged out of Actual, and the file is now unavailable too), not a 500 from something
    // unhandled blowing up the whole request.
    const stateRes = await fetch(`${url}api/retirement/state`)
    expect(stateRes.status).toBe(400)
  })

  it("clears the file session on DELETE, switching back to Actual-sync mode", async () => {
    const filePath = join(dir, "accounts.csv")
    writeFileSync(filePath, "name,balance\nManual Brokerage,50000.00\n")
    const url = await boot({ accounts: [] })
    await fetch(`${url}api/data-source`, { method: "POST", body: JSON.stringify({ filePath }) })

    const res = await fetch(`${url}api/data-source`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await readJson<{ mode: string }>(res)).toEqual({ mode: "actual" })
    expect(loadFileDataSourceSession(dataSourceSessionPath)).toBeNull()

    const stateRes = await fetch(`${url}api/retirement/state`)
    expect(stateRes.status).toBe(200)
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
