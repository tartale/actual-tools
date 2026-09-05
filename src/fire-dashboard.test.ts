import { describe, expect, it } from "vitest"

import {
  ALLOCATION_PRESET_RETURNS,
  buildCrossoverWidget,
  buildFireDashboard,
  buildMonteCarloWidget,
  buildNetWorthWidget,
  buildPot,
  buildSpendingPhases,
  buildSpendingWidget,
  portfolioAccountIds,
} from "./fire-dashboard.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"

// Function to build a classified account with sensible defaults for the fields a test ignores
function account(overrides: Partial<ClassifiedAccount> & Pick<ClassifiedAccount, "id" | "category">): ClassifiedAccount {
  return {
    name: "Some Account",
    offbudget: true,
    taxTreatment: "none",
    accessAge: null,
    allocationPreset: null,
    source: "heuristic",
    ...overrides,
  }
}

describe("portfolioAccountIds", () => {
  it("includes every portfolio category", () => {
    const accounts = [
      account({ id: "a1", category: "retirement-tax-deferred" }),
      account({ id: "a2", category: "retirement-roth" }),
      account({ id: "a3", category: "hsa" }),
      account({ id: "a4", category: "investment-taxable" }),
    ]
    expect(portfolioAccountIds(accounts)).toEqual(["a1", "a2", "a3", "a4"])
  })

  it("excludes debt, cash, and other", () => {
    const accounts = [
      account({ id: "a1", category: "debt" }),
      account({ id: "a2", category: "cash" }),
      account({ id: "a3", category: "other" }),
    ]
    expect(portfolioAccountIds(accounts)).toEqual([])
  })

  it("preserves order and returns an empty array for no accounts", () => {
    expect(portfolioAccountIds([])).toEqual([])
  })
})

describe("buildNetWorthWidget", () => {
  it("has no account/category filter", () => {
    const widget = buildNetWorthWidget(0, 0)
    expect(widget).toEqual({
      type: "net-worth-card",
      x: 0,
      y: 0,
      width: 6,
      height: 2,
      meta: { name: "Net Worth", mode: "trend" },
    })
  })
})

describe("buildSpendingWidget", () => {
  it("uses a trailing-12-month average", () => {
    const widget = buildSpendingWidget(6, 0)
    expect(widget.meta).toEqual({
      name: "Trailing 12-Month Spending",
      mode: "average",
      averageRange: { mode: "last-n-months", months: 12 },
    })
  })
})

describe("buildCrossoverWidget", () => {
  it("never leaves expenseCategoryIds empty when given categories", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1", "cat-2"], ["acct-1"])
    expect(widget.meta?.expenseCategoryIds).toEqual(["cat-1", "cat-2"])
  })

  it("passes portfolio account ids through as incomeAccountIds, unchanged", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1"], ["acct-1", "acct-2"])
    expect(widget.meta?.incomeAccountIds).toEqual(["acct-1", "acct-2"])
  })

  it("uses Actual's own UI defaults for the projection fields", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1"], ["acct-1"])
    expect(widget.meta).toMatchObject({
      safeWithdrawalRate: 0.04,
      estimatedReturn: null,
      expectedContribution: null,
      projectionType: "hampel",
      expenseAdjustmentFactor: 1.0,
    })
  })
})

describe("buildFireDashboard", () => {
  it("assembles all three widgets on non-overlapping grid coordinates", () => {
    const dashboard = buildFireDashboard(["cat-1"], ["acct-1"])
    expect(dashboard.version).toBe(1)
    expect(dashboard.widgets.map((widget) => widget.type)).toEqual(["net-worth-card", "spending-card", "crossover-card"])

    const [netWorth, spending, crossover] = dashboard.widgets
    // net worth and spending sit side by side on row 0, each 6 wide (12-column grid)
    expect(netWorth).toMatchObject({ x: 0, y: 0, width: 6 })
    expect(spending).toMatchObject({ x: 6, y: 0, width: 6 })
    expect(netWorth!.x + netWorth!.width).toBe(spending!.x)
    // crossover sits full-width on the row below
    expect(crossover).toMatchObject({ x: 0, y: 2, width: 12 })
  })

  it("threads the given category and account ids into the crossover widget", () => {
    const dashboard = buildFireDashboard(["cat-1", "cat-2"], ["acct-1"])
    const crossover = dashboard.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({ expenseCategoryIds: ["cat-1", "cat-2"], incomeAccountIds: ["acct-1"] })
  })
})

// Function to build a portfolio account with a non-null allocationPreset, narrowed to the type
// buildPot requires -- the account() helper's return type keeps allocationPreset nullable since
// that's correct for ClassifiedAccount in general (non-portfolio accounts always have null there)
function portfolioTestAccount(
  overrides: Partial<ClassifiedAccount> & Pick<ClassifiedAccount, "id" | "category"> & { allocationPreset: NonNullable<ClassifiedAccount["allocationPreset"]> },
) {
  return account(overrides) as ClassifiedAccount & { allocationPreset: NonNullable<ClassifiedAccount["allocationPreset"]> }
}

describe("buildPot", () => {
  it("links the pot to the account's live balance", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" }))
    expect(pot.accountId).toBe("a1")
  })

  it("sets expectedReturnMean/returnStdDev explicitly from the preset, not just the preset label", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" }))
    expect(pot.allocationPreset).toBe("equity-80")
    expect(pot.expectedReturnMean).toBe(ALLOCATION_PRESET_RETURNS["equity-80"].mean)
    expect(pot.returnStdDev).toBe(ALLOCATION_PRESET_RETURNS["equity-80"].stdDev)
  })

  it("carries the account's access age through unchanged", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, allocationPreset: "equity-80" }))
    expect(pot.accessAge).toBe(59)
  })

  it("derives the withdrawal tax rate from tax treatment", () => {
    const cases: [ClassifiedAccount["taxTreatment"], number][] = [
      ["tax-deferred", 0.22],
      ["taxable", 0.15],
      ["tax-free", 0],
      ["none", 0],
    ]
    for (const [taxTreatment, expectedRate] of cases) {
      const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", taxTreatment, allocationPreset: "equity-80" }))
      expect(pot.withdrawalTaxRate).toBe(expectedRate)
    }
  })
})

describe("buildSpendingPhases", () => {
  it("collapses to a single always-on phase when already retired", () => {
    expect(buildSpendingPhases(45, 45, 500000)).toEqual([
      { id: "retirement-spending", name: "Retirement spending", fromAge: null, annualWithdrawal: 500000 },
    ])
    // retiring in the past behaves the same as retiring exactly now
    expect(buildSpendingPhases(45, 40, 500000)).toEqual([
      { id: "retirement-spending", name: "Retirement spending", fromAge: null, annualWithdrawal: 500000 },
    ])
  })

  it("splits into a $0 accumulation phase and a real drawdown phase for a future retirement age", () => {
    expect(buildSpendingPhases(45, 60, 500000)).toEqual([
      { id: "pre-retirement", name: "Pre-retirement", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
    ])
  })
})

describe("buildMonteCarloWidget", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })
  const nonPortfolioAccount = account({ id: "a2", category: "cash" })

  it("builds one pot per portfolio account, excluding debt/cash/other", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount, nonPortfolioAccount], 45, 45, 90, 500000)
    expect(widget.meta?.pots).toHaveLength(1)
    expect(widget.meta?.pots?.[0]?.accountId).toBe("a1")
  })

  it("sets withdrawalStrategy, ages, spending phases, and a flat tax model", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 45, 90, 500000)
    expect(widget.meta).toMatchObject({
      withdrawalStrategy: "proportional",
      currentAge: 45,
      targetAge: 90,
      taxModel: "flat",
      inflationMean: 0.03,
    })
    expect(widget.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 45, 500000))
  })

  it("threads a future retirement age into the spending phases", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 60, 90, 500000)
    expect(widget.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 60, 500000))
  })

  it("throws a clear error when a portfolio account has no allocationPreset set", () => {
    const incomplete = account({ id: "a3", category: "hsa", allocationPreset: null })
    expect(() => buildMonteCarloWidget(0, 6, [incomplete], 45, 45, 90, 500000)).toThrow(/allocationPreset/)
  })
})
