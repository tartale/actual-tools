import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { checkDashboard } from "./fire-generate.ts"
import type { CheckOptions } from "./fire-generate.ts"
import { fileAccountDataSource } from "./file-account-data-source.ts"
import { actualAccountDataSource } from "./account-data-source.ts"
import { classifyAccounts } from "./fire-accounts.ts"
import { DEFAULT_MONTE_CARLO_ASSUMPTIONS } from "./fire-dashboard.ts"
import type { ActualConfig } from "./actual-helpers.ts"

// checkDashboard itself has no other direct unit tests (it's otherwise only exercised indirectly
// through app-server.test.ts's HTTP-level boot() helper) -- this file exists specifically to
// cover the new AccountDataSource seam (issue #33/#34), calling checkDashboard directly rather
// than through the HTTP layer, since routing an HTTP request to the file-backed data source isn't
// wired up yet (that's issue #35, a separate future PR).

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch

// checkDashboard still calls fetchDashboardWidgets directly (an Actual-only, live-dashboard
// concept -- see account-data-source.ts's own doc comment on why this stays out of the
// AccountDataSource abstraction) regardless of which AccountDataSource is otherwise in play, so
// even a file-sourced check still needs this one Actual endpoint mocked -- empty dashboard rows
// means "no Monte Carlo widget imported yet," falling back to fallbackInflationMean below, same
// as a real fresh Actual budget with nothing imported.
function mockDashboardWidgetsFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") return realFetch(url)
    if (/\/run-query$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
    if (/\/categorygroups$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
    if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
    throw new Error(`Unhandled fetch in test: ${u.pathname}`)
  })
}

const baseOptions: CheckOptions = {
  currentAge: 55,
  retirementAges: [55],
  planToAge: 85,
  fallbackInflationMean: 0.03,
  incomeStreams: [],
  monteCarloAssumptions: DEFAULT_MONTE_CARLO_ASSUMPTIONS,
  crossoverExpenseCategoryIds: null,
  expenseAdjustmentFactor: 1,
  spendHistoryMonths: 12,
  filingStatus: null,
  federalTaxBrackets: null,
  householdSize: null,
  federalPovertyGuidelines: null,
  acaTargetPctFpl: null,
  medicareAge: null,
  acaFloorPctFpl: null,
  expenseAdjustments: [],
}

describe("checkDashboard with a file-backed AccountDataSource", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fire-generate-test-"))
    vi.stubGlobal("fetch", mockDashboardWidgetsFetch())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs a real Bridge/Monte Carlo check end to end from a CSV fixture, with no Actual accounts API involved", async () => {
    const filePath = join(dir, "accounts.csv")
    writeFileSync(filePath, "name,balance\nBrokerage,500000.00\n401k,1000000.00\n")

    const dataSource = fileAccountDataSource(filePath)
    const rawAccounts = await dataSource.fetchAccounts()
    // in-app account editor works the same regardless of data source (issue #22's own resolved
    // design) -- classifyAccounts' heuristic runs on the file-sourced accounts exactly as it
    // would on Actual-sourced ones.
    const accounts = classifyAccounts(rawAccounts, { accounts: [] }, "1970-01-01", null)

    const result = await checkDashboard(actualConfig, dataSource, accounts, baseOptions)

    // $500,000 + $1,000,000 -- the exact figures the fixture file supplies, proving the balance
    // actually flowed through fetchAccountBalance rather than defaulting to 0/failing silently.
    expect(result.portfolioTotal).toBe(1_500_000_00)
    expect(result.bridgeResults).toHaveLength(1)
    expect((result.bridgeResults[0]?.accessibleAtRetirement ?? 0) + (result.bridgeResults[0]?.lockedAtRetirement ?? 0)).toBeGreaterThan(0)
    // No transaction ledger for a file source -- fetchAccountHistory always returns empty (see
    // its own doc comment), so there's nothing for the chart's lookback window to draw.
    expect(result.bridgeResults[0]?.history).toEqual([])
  })

  it("rejects a malformed fixture file with a clear error before ever reaching the simulation", async () => {
    const filePath = join(dir, "bad.csv")
    writeFileSync(filePath, "name,balance\nBrokerage,not-a-number\n")
    const dataSource = fileAccountDataSource(filePath)
    await expect(dataSource.fetchAccounts()).rejects.toThrow(/isn't a valid dollar amount/)
  })
})

describe("checkDashboard with the Actual-backed AccountDataSource (regression: #33 must be a pure refactor)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("still produces the exact same portfolioTotal it did before the DataSource abstraction existed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = new URL(url)
        if (u.hostname !== "actual.test") return realFetch(url)
        if (/\/run-query$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
        if (/\/categorygroups$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
        if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response
        if (/\/accounts\/[^/]+\/transactions/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ data: [{ amount: 250_000_00 }] }) } as Response
        throw new Error(`Unhandled fetch in test: ${u.pathname}`)
      }),
    )
    const dataSource = actualAccountDataSource(actualConfig)
    const rawAccount = { id: "a1", name: "Brokerage", offbudget: true, closed: false }
    const accounts = classifyAccounts([rawAccount], { accounts: [] }, "1970-01-01", null)

    const result = await checkDashboard(actualConfig, dataSource, accounts, baseOptions)
    expect(result.portfolioTotal).toBe(250_000_00)
  })
})
