import { describe, expect, it } from "vitest"

import {
  ALLOCATION_PRESET_RETURNS,
  buildCrossoverWidget,
  buildFireDashboard,
  buildMonteCarloWidget,
  buildMonteCarloWidgets,
  buildNetWorthWidget,
  buildPot,
  buildSpendingPhases,
  mergeGeneratedDashboard,
  portfolioAccountIds,
} from "./fire-dashboard.ts"
import type { ExistingDashboard } from "./fire-dashboard.ts"
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
  it("has no account/category filter and spans the full page width", () => {
    const widget = buildNetWorthWidget(0, 0)
    expect(widget).toEqual({
      type: "net-worth-card",
      x: 0,
      y: 0,
      width: 12,
      height: 2,
      meta: { name: "Net Worth", mode: "trend" },
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
  it("assembles both widgets on non-overlapping grid coordinates", () => {
    const dashboard = buildFireDashboard(["cat-1"], ["acct-1"])
    expect(dashboard.version).toBe(1)
    expect(dashboard.widgets.map((widget) => widget.type)).toEqual(["net-worth-card", "crossover-card"])

    const [netWorth, crossover] = dashboard.widgets
    // net worth spans the full page width on row 0
    expect(netWorth).toMatchObject({ x: 0, y: 0, width: 12 })
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

  it("sets withdrawalStrategy, ages, spending phases, a flat tax model, and a default name", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 45, 90, 500000)
    expect(widget.meta).toMatchObject({
      name: "Monte Carlo",
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

  it("accepts an explicit name override", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 45, 90, 500000, "Retire at 55")
    expect(widget.meta?.name).toBe("Retire at 55")
  })

  it("throws a clear error when a portfolio account has no allocationPreset set", () => {
    const incomplete = account({ id: "a3", category: "hsa", allocationPreset: null })
    expect(() => buildMonteCarloWidget(0, 6, [incomplete], 45, 45, 90, 500000)).toThrow(/allocationPreset/)
  })
})

describe("buildMonteCarloWidgets", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })

  it("builds one widget with the plain default name for a single retirement age", () => {
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [55], 90, 500000)
    expect(widgets).toHaveLength(1)
    expect(widgets[0]?.meta?.name).toBe("Monte Carlo")
    expect(widgets[0]).toMatchObject({ x: 0, y: 6 })
  })

  it("stacks one uniquely-named widget per retirement age, in order", () => {
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [55, 60, 65], 90, 500000)
    expect(widgets).toHaveLength(3)
    expect(widgets.map((widget) => widget.meta?.name)).toEqual([
      "Monte Carlo — Retire at 55",
      "Monte Carlo — Retire at 60",
      "Monte Carlo — Retire at 65",
    ])
    // stacked vertically on the same column, each below the last, none overlapping
    expect(widgets.map((widget) => widget.y)).toEqual([6, 10, 14])
    expect(widgets.every((widget) => widget.x === 0)).toBe(true)
  })

  it("gives each widget its own retirement age's spending phases", () => {
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [45, 60], 90, 500000)
    expect(widgets[0]?.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 45, 500000))
    expect(widgets[1]?.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 60, 500000))
  })
})

describe("mergeGeneratedDashboard", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })

  it("returns the generated dashboard unchanged when there's no existing file", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"])
    expect(mergeGeneratedDashboard(generated, null)).toEqual(generated)
  })

  it("preserves a net-worth-card customization outright -- it has no owned fields", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"])
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [{ type: "net-worth-card", x: 0, y: 0, width: 12, height: 2, meta: { name: "My Net Worth", mode: "stacked" } }],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets[0]?.meta).toEqual({ name: "My Net Worth", mode: "stacked" })
  })

  it("always refreshes crossover's account/category ids but preserves a customized assumption", () => {
    const generated = buildFireDashboard(["new-cat"], ["new-acct"])
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: {
            name: "FIRE Crossover",
            expenseCategoryIds: ["stale-cat"],
            incomeAccountIds: ["stale-acct"],
            safeWithdrawalRate: 0.035,
            estimatedReturn: null,
            expectedContribution: null,
            projectionType: "hampel",
            expenseAdjustmentFactor: 1,
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const crossover = merged.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({
      expenseCategoryIds: ["new-cat"],
      incomeAccountIds: ["new-acct"],
      safeWithdrawalRate: 0.035,
    })
  })

  it("refreshes a pot's account-derived fields but preserves an extra fee field", () => {
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000) }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "monte-carlo-card",
          x: 0,
          y: 6,
          width: 12,
          height: 4,
          meta: {
            name: "Monte Carlo",
            pots: [{ id: "a1", accountId: "a1", allocationPreset: "equity-40", annualFeeRate: 0.001 }],
            spendingPhases: [],
            currentAge: 40,
            targetAge: 90,
            withdrawalStrategy: "sequential",
            returnModel: "historical-sample",
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    const pot = (meta.pots as Record<string, unknown>[])[0] as Record<string, unknown>
    expect(pot.allocationPreset).toBe("equity-80") // refreshed from accounts.json, not the stale existing value
    expect(pot.annualFeeRate).toBe(0.001) // extra field preserved
    expect(meta).toMatchObject({ currentAge: 45, targetAge: 100, withdrawalStrategy: "sequential", returnModel: "historical-sample" })
  })

  it("keeps an extra hand-added spending phase but refreshes the owned ones", () => {
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000) }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "monte-carlo-card",
          x: 0,
          y: 6,
          width: 12,
          height: 4,
          meta: {
            name: "Monte Carlo",
            pots: [],
            spendingPhases: [
              { id: "pre-retirement", name: "Pre-retirement", fromAge: null, annualWithdrawal: 999 },
              { id: "downsize", name: "Downsize the house", fromAge: 75, annualWithdrawal: 300000 },
            ],
            currentAge: 45,
            targetAge: 100,
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    const phases = meta.spendingPhases as { id: string; annualWithdrawal: number }[]
    expect(phases.map((phase) => phase.id)).toEqual(["pre-retirement", "retirement-spending", "downsize"])
    expect(phases[0]?.annualWithdrawal).toBe(0) // owned id refreshed, not the stale 999
  })

  it("drops a monte-carlo-card whose retirement age is no longer requested", () => {
    // both fixtures request 2+ ages, so the "Monte Carlo — Retire at N" naming (see
    // buildMonteCarloWidgets) is identical for the ages that carry over between them
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60, 65], 100, 500000) }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        ...(buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [53, 60, 65], 100, 500000) as unknown as ExistingDashboard["widgets"]),
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets.map((widget) => (widget.meta as { name?: string } | null)?.name)).toEqual([
      "Monte Carlo — Retire at 60",
      "Monte Carlo — Retire at 65",
    ])
  })

  it("carries through untouched a widget of a type it never generates", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"])
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [{ type: "custom-note-card", x: 0, y: 20, width: 12, height: 2, meta: { text: "hand-added" } }],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets).toContainEqual({ type: "custom-note-card", x: 0, y: 20, width: 12, height: 2, meta: { text: "hand-added" } })
  })
})
