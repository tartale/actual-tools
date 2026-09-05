import { describe, expect, it } from "vitest"

import { buildCrossoverWidget, buildFireDashboard, buildNetWorthWidget, buildSpendingWidget, portfolioAccountIds } from "./fire-dashboard.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"

// Function to build a classified account with sensible defaults for the fields a test ignores
function account(overrides: Partial<ClassifiedAccount> & Pick<ClassifiedAccount, "id" | "category">): ClassifiedAccount {
  return {
    name: "Some Account",
    offbudget: true,
    taxTreatment: "none",
    accessAge: null,
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
