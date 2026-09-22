import { afterEach, describe, expect, it, vi } from "vitest"

import { annualSpendFromTransactions, checkDashboard } from "./fire-generate.ts"
import type { CheckOptions } from "./fire-generate.ts"
import { categoryIdFromName, fileAccountDataSource } from "./file-account-data-source.ts"
import type { FileTransactionRow } from "./file-account-data-source.ts"
import { actualAccountDataSource } from "./account-data-source.ts"
import { classifyAccounts } from "./fire-accounts.ts"
import { DEFAULT_MONTE_CARLO_ASSUMPTIONS } from "./fire-dashboard.ts"
import type { ActualConfig } from "./actual-helpers.ts"

// checkDashboard itself has no other direct unit tests (it's otherwise only exercised indirectly
// through app-server.test.ts's HTTP-level boot() helper) -- this file exists specifically to cover
// the AccountDataSource seam (issue #33/#34/#35): a file-backed check with no Actual connection at
// all (actualConfig: null, the real file-mode shape as of the 2026-09-21 redesign -- see
// checkDashboard's own doc comment) alongside the Actual-backed regression check below.

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch

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
  fileModeSpend: null,
}

describe("checkDashboard in file mode (actualConfig: null)", () => {
  // Deliberately NO fetch stub in this describe block -- file mode (issue #34/#35's follow-up,
  // 2026-09-21) makes no Actual calls at all (no dashboard-widget import, no category-groups
  // fetch), unlike the earlier #33/#34-era design this replaces, which still required a live Actual
  // connection even for a file-backed AccountDataSource (see checkDashboard's own doc comment on
  // the two things that change when actualConfig is null). An unexpected fetch call here would
  // throw (no stub installed), which is itself the regression check.
  it("runs a real Bridge/Monte Carlo check end to end from a CSV fixture, with no Actual API involved at all", async () => {
    const dataSource = fileAccountDataSource("accounts.csv", "name,balance\nBrokerage,500000.00\n401k,1000000.00\n")
    const rawAccounts = await dataSource.fetchAccounts()
    // in-app account editor works the same regardless of data source (issue #22's own resolved
    // design) -- classifyAccounts' heuristic runs on the file-sourced accounts exactly as it
    // would on Actual-sourced ones.
    const accounts = classifyAccounts(rawAccounts, { accounts: [] }, "1970-01-01", null)

    const result = await checkDashboard(null, dataSource, accounts, { ...baseOptions, fileModeSpend: { annualSpend: 50000_00, basis: null } })

    // $500,000 + $1,000,000 -- the exact figures the fixture file supplies, proving the balance
    // actually flowed through fetchAccountBalance rather than defaulting to 0/failing silently.
    expect(result.portfolioTotal).toBe(1_500_000_00)
    expect(result.annualSpend).toBe(50000_00)
    expect(result.bridgeResults).toHaveLength(1)
    expect((result.bridgeResults[0]?.accessibleAtRetirement ?? 0) + (result.bridgeResults[0]?.lockedAtRetirement ?? 0)).toBeGreaterThan(0)
    // No transaction ledger for a file source -- fetchAccountHistory always returns empty (see
    // its own doc comment), so there's nothing for the chart's lookback window to draw.
    expect(result.bridgeResults[0]?.history).toEqual([])
    // No Monte Carlo widget to import in file mode -- falls back to fallbackInflationMean, the
    // same "nothing imported yet" state a fresh Actual budget with no widget would produce.
    expect(result.inflationMean).toBe(baseOptions.fallbackInflationMean)
  })

  it("throws when fileModeSpend is missing -- there's nothing else it could fall back to", async () => {
    const dataSource = fileAccountDataSource("accounts.csv", "name,balance\nBrokerage,500000.00\n")
    const accounts = classifyAccounts(await dataSource.fetchAccounts(), { accounts: [] }, "1970-01-01", null)
    await expect(checkDashboard(null, dataSource, accounts, { ...baseOptions, fileModeSpend: null })).rejects.toThrow(/fileModeSpend is required/)
  })

  it("rejects a malformed fixture file with a clear error before ever reaching the simulation", () => {
    // Parsing is eager now (content is already in memory, no disk read to defer) -- the malformed
    // row throws right from construction, not from a later fetchAccounts() call.
    expect(() => fileAccountDataSource("bad.csv", "name,balance\nBrokerage,not-a-number\n")).toThrow(/isn't a valid dollar amount/)
  })
})

// Dates relative to "now" (not hardcoded) -- the trailing window itself is anchored to the real
// current month (see annualSpendFromTransactions's own doc comment), so a fixed date would drift
// out of the window over time and make these tests flaky.
function monthsAgo(n: number): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}

describe("annualSpendFromTransactions", () => {
  it("sums outflow rows within the trailing window, annualized", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
      { date: monthsAgo(2), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
    ]
    // $3,000 spent over a 3-month trailing window -> $1,000/mo average -> $12,000/yr.
    const { annualSpend, basis } = annualSpendFromTransactions(rows, 3, 1, null)
    expect(annualSpend).toBe(12000_00)
    expect(basis).toContain("trailing 3 months")
  })

  it("excludes rows outside the trailing window", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 },
      { date: monthsAgo(13), categoryGroup: "Bills", category: "Rent", amount: -1000_00 }, // outside a 12-month window
    ]
    const { annualSpend } = annualSpendFromTransactions(rows, 12, 1, null)
    expect(annualSpend).toBe(1000_00)
  })

  it("excludes Income-group rows (case-insensitive), even though they're positive amounts already", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "income", category: "Paycheck", amount: 5000_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 },
    ]
    const { annualSpend } = annualSpendFromTransactions(rows, 1, 1, null)
    expect(annualSpend).toBe(12000_00)
  })

  // Regression (2026-09-21): an earlier version discarded positive rows outright instead of
  // netting them, overcounting a real household's spend by ~$51K/yr once refunds/returns were
  // added back correctly (found comparing against Actual's own live "spent" figure for the same
  // data).
  it("nets a positive (refund/return) row against the same category's own outflows, rather than discarding it", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: 200_00 }, // a partial refund
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 },
    ]
    const { annualSpend } = annualSpendFromTransactions(rows, 1, 1, null)
    // Net $800 spent this month -> $9,600/yr, not $12,000 (the refund isn't just discarded).
    expect(annualSpend).toBe(9600_00)
  })

  it("returns annualSpend 0 (not negative) when refunds net out to more than the outflows in the window", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: 1000_00 }, // a big refund
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -200_00 },
    ]
    expect(annualSpendFromTransactions(rows, 1, 1, null)).toEqual({ annualSpend: 0, basis: null })
  })

  it("applies the adjustment factor, and names it in the basis", () => {
    const rows: FileTransactionRow[] = [{ date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 }]
    const { annualSpend, basis } = annualSpendFromTransactions(rows, 1, 1.1, null)
    expect(annualSpend).toBe(Math.round(1000_00 * 12 * 1.1))
    expect(basis).toContain("110%")
  })

  it("returns annualSpend 0 with a null basis when nothing qualifies -- the caller falls back to the manual figure", () => {
    const rows: FileTransactionRow[] = [{ date: monthsAgo(1), categoryGroup: "income", category: "Paycheck", amount: 5000_00 }]
    expect(annualSpendFromTransactions(rows, 1, 1, null)).toEqual({ annualSpend: 0, basis: null })
  })

  // Regression (2026-09-21): a real export's transfers (between the person's own accounts) and
  // split-transaction parent rows both carry an empty Category_Group/Category -- these are NOT
  // spend, and summing them inflated a real household's figure to $1.4M/yr.
  it("excludes rows with an empty category group or category -- transfers/split-parent rows, not real spend", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "", category: "", amount: -50000_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "", amount: -50000_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 },
    ]
    expect(annualSpendFromTransactions(rows, 1, 1, null).annualSpend).toBe(12000_00)
  })

  it("only counts rows whose category is in the selection, once one is given", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 },
      { date: monthsAgo(1), categoryGroup: "Long-Term Savings", category: "401k", amount: -2000_00 },
    ]
    const selection = [categoryIdFromName("Bills", "Rent")]
    expect(annualSpendFromTransactions(rows, 1, 1, selection).annualSpend).toBe(12000_00)
  })

  it("falls back to every non-empty-category row when the selection is empty (never customized)", () => {
    const rows: FileTransactionRow[] = [{ date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1000_00 }]
    expect(annualSpendFromTransactions(rows, 1, 1, []).annualSpend).toBe(12000_00)
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
