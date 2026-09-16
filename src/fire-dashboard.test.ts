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
  crossoverAssumptionsWithOverrides,
  effectiveAccessAge,
  mergeGeneratedDashboard,
  monteCarloAssumptionsWithOverrides,
  pinnedCrossoverFields,
  pinnedMonteCarloFields,
  portfolioAccountIds,
  retirementIncomeStreams,
  totalMonthlyContribution,
  withdrawalTaxRateFor,
} from "./fire-dashboard.ts"
import type { CrossoverAssumptions, ExistingDashboard, MonteCarloAssumptions, RetirementIncomeStream } from "./fire-dashboard.ts"
import type { ClassifiedAccount, DashboardConfig } from "./fire-accounts.ts"
import { DEFAULT_DASHBOARD_CONFIG } from "./fire-accounts.ts"

// Function to build a classified account with sensible defaults for the fields a test ignores
function account(overrides: Partial<ClassifiedAccount> & Pick<ClassifiedAccount, "id" | "category">): ClassifiedAccount {
  return {
    name: "Some Account",
    offbudget: true,
    type: "other",
    taxTreatment: "none",
    accessAge: null,
    allocationPreset: null,
    customReturnMean: null,
    customReturnStdDev: null,
    monthlyContribution: null,
    ruleOf55SeparationAge: null,
    annualSalary: null,
    employerMatchRate: null,
    employerMatchCapRate: null,
    hsaCoverage: null,
    mortgageInterestRate: null,
    mortgageMonthlyPayment: null,
    mortgageBalanceAsOfDate: null,
    mortgageBalanceAsOf: null,
    mortgageExtraPrincipal: null,
    rothBasis: null,
    customWithdrawalTaxRate: null,
    withdrawalOrder: null,
    source: "heuristic",
    ...overrides,
  }
}

// Fixtures matching Actual's own UI defaults, so tests read the same way the old hardcoded
// defaults used to -- these are now caller-supplied (./actual configure), not baked into the
// builder functions.
const CROSSOVER_ASSUMPTIONS: CrossoverAssumptions = {
  safeWithdrawalRate: 0.04,
  estimatedReturn: null,
  projectionType: "hampel",
  expenseAdjustmentFactor: 1.0,
  showHiddenCategories: false,
}

const MONTE_CARLO_ASSUMPTIONS: MonteCarloAssumptions = {
  withdrawalStrategy: "proportional",
  returnModel: "normal",
  withdrawalRule: { type: "none" },
  minimumWithdrawal: 0,
  inflationMean: 0.03,
  inflationStdDev: 0.02,
  taxModel: "flat",
  taxBands: [],
  simulationCount: 5000,
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

describe("totalMonthlyContribution", () => {
  it("sums contributions across portfolio accounts only", () => {
    const accounts = [
      account({ id: "a1", category: "investment-taxable", monthlyContribution: 50000 }),
      account({ id: "a2", category: "hsa", monthlyContribution: 10000 }),
      account({ id: "a3", category: "cash", monthlyContribution: 99999 }),
    ]
    expect(totalMonthlyContribution(accounts)).toBe(60000)
  })

  it("returns null (not 0) when nothing is configured", () => {
    const accounts = [account({ id: "a1", category: "investment-taxable" })]
    expect(totalMonthlyContribution(accounts)).toBeNull()
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
    const widget = buildCrossoverWidget(0, 2, ["cat-1", "cat-2"], ["acct-1"], CROSSOVER_ASSUMPTIONS, null)
    expect(widget.meta?.expenseCategoryIds).toEqual(["cat-1", "cat-2"])
  })

  it("passes portfolio account ids through as incomeAccountIds, unchanged", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1"], ["acct-1", "acct-2"], CROSSOVER_ASSUMPTIONS, null)
    expect(widget.meta?.incomeAccountIds).toEqual(["acct-1", "acct-2"])
  })

  it("threads the given assumptions through", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1"], ["acct-1"], { ...CROSSOVER_ASSUMPTIONS, safeWithdrawalRate: 0.035 }, null)
    expect(widget.meta).toMatchObject({
      safeWithdrawalRate: 0.035,
      estimatedReturn: null,
      projectionType: "hampel",
      expenseAdjustmentFactor: 1.0,
    })
  })

  it("threads the monthly expectedContribution through", () => {
    const widget = buildCrossoverWidget(0, 2, ["cat-1"], ["acct-1"], CROSSOVER_ASSUMPTIONS, 60000)
    expect(widget.meta?.expectedContribution).toBe(60000)
  })
})

describe("buildFireDashboard", () => {
  it("assembles both widgets on non-overlapping grid coordinates", () => {
    const dashboard = buildFireDashboard(["cat-1"], ["acct-1"], CROSSOVER_ASSUMPTIONS, null)
    expect(dashboard.version).toBe(1)
    expect(dashboard.widgets.map((widget) => widget.type)).toEqual(["net-worth-card", "crossover-card"])

    const [netWorth, crossover] = dashboard.widgets
    // net worth spans the full page width on row 0
    expect(netWorth).toMatchObject({ x: 0, y: 0, width: 12 })
    // crossover sits full-width on the row below
    expect(crossover).toMatchObject({ x: 0, y: 2, width: 12 })
  })

  it("threads the given category and account ids into the crossover widget", () => {
    const dashboard = buildFireDashboard(["cat-1", "cat-2"], ["acct-1"], CROSSOVER_ASSUMPTIONS, null)
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
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" }), 65)
    expect(pot.accountId).toBe("a1")
  })

  it("sets expectedReturnMean/returnStdDev explicitly from the preset, not just the preset label", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" }), 65)
    expect(pot.allocationPreset).toBe("equity-80")
    expect(pot.expectedReturnMean).toBe(ALLOCATION_PRESET_RETURNS["equity-80"].mean)
    expect(pot.returnStdDev).toBe(ALLOCATION_PRESET_RETURNS["equity-80"].stdDev)
  })

  it("carries the account's access age through unchanged", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, allocationPreset: "equity-80" }), 65)
    expect(pot.accessAge).toBe(59)
  })

  it("applies a qualifying Rule of 55 separation age to lower the pot's access age", () => {
    const pot = buildPot(
      portfolioTestAccount({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, ruleOf55SeparationAge: 55, allocationPreset: "equity-80" }),
      55,
    )
    expect(pot.accessAge).toBe(55)
  })

  it("does not apply a separation age that falls after this scenario's own retirement age", () => {
    const pot = buildPot(
      portfolioTestAccount({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, ruleOf55SeparationAge: 55, allocationPreset: "equity-80" }),
      52,
    )
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
      const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", taxTreatment, allocationPreset: "equity-80" }), 65)
      expect(pot.withdrawalTaxRate).toBe(expectedRate)
    }
  })

  it("uses the account's own customReturnMean/customReturnStdDev, overriding its preset's own defaults", () => {
    const pot = buildPot(
      portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-100", customReturnMean: 0.055, customReturnStdDev: 0.09 }),
      65,
    )
    expect(pot.allocationPreset).toBe("equity-100")
    expect(pot.expectedReturnMean).toBe(0.055)
    expect(pot.returnStdDev).toBe(0.09)
  })

  it("overrides only the field that's actually set, keeping the preset's own default for the other", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", allocationPreset: "equity-100", customReturnMean: 0.055 }), 65)
    expect(pot.expectedReturnMean).toBe(0.055)
    expect(pot.returnStdDev).toBe(ALLOCATION_PRESET_RETURNS["equity-100"].stdDev)
  })

  it("uses the account's own customWithdrawalTaxRate over the type-wide default", () => {
    const pot = buildPot(portfolioTestAccount({ id: "a1", category: "investment-taxable", taxTreatment: "tax-deferred", allocationPreset: "equity-80", customWithdrawalTaxRate: 0.3 }), 65)
    expect(pot.withdrawalTaxRate).toBe(0.3)
  })
})

describe("withdrawalTaxRateFor", () => {
  it("falls back to the type-wide default when no override is set", () => {
    expect(withdrawalTaxRateFor({ taxTreatment: "tax-deferred", customWithdrawalTaxRate: null })).toBe(0.22)
  })

  it("uses the override, including an explicit 0, over the default", () => {
    expect(withdrawalTaxRateFor({ taxTreatment: "tax-deferred", customWithdrawalTaxRate: 0.3 })).toBe(0.3)
    expect(withdrawalTaxRateFor({ taxTreatment: "tax-deferred", customWithdrawalTaxRate: 0 })).toBe(0)
  })
})

describe("effectiveAccessAge", () => {
  it("returns the plain accessAge when there's no separation age", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null }, 65)).toBe(59)
  })

  it("overrides to the separation age when it qualifies (55+), is earlier, and is at or before this scenario's retirement age", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55 }, 55)).toBe(55)
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55 }, 60)).toBe(55)
  })

  it("has no effect when the separation age is below 55", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 50 }, 65)).toBe(59)
  })

  it("takes the earlier of the two when the separation age is above the existing accessAge", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 62 }, 65)).toBe(59)
  })

  it("uses the separation age directly when accessAge is null", () => {
    expect(effectiveAccessAge({ accessAge: null, ruleOf55SeparationAge: 56 }, 65)).toBe(56)
  })

  it("does not apply the boost when this scenario retires before the account's own separation age", () => {
    // Retiring at 52 while still asserting employment (and thus separation) at this employer at 55
    // is a contradiction -- this app models "retired" as "no longer working anywhere" -- so the
    // normal accessAge stands for this scenario; a later scenario (e.g. retiring at 55 or 58) still
    // gets the boost, since the two ages don't contradict there.
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55 }, 52)).toBe(59)
    expect(effectiveAccessAge({ accessAge: null, ruleOf55SeparationAge: 56 }, 54)).toBe(null)
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
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
    ])
  })

  it("folds an income stream already active at retirement straight into the base spending figure", () => {
    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 60, annualAmount: 120000 }
    expect(buildSpendingPhases(45, 60, 500000, [pension])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 380000 },
    ])
  })

  it("adds a stepped-down phase for an income stream starting after retirement", () => {
    const socialSecurity: RetirementIncomeStream = { id: "social-security", name: "Social Security", startAge: 67, annualAmount: 240000 }
    expect(buildSpendingPhases(45, 60, 500000, [socialSecurity])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
      { id: "income-social-security", name: "After Social Security", fromAge: 67, annualWithdrawal: 260000 },
    ])
  })

  it("stacks multiple later streams cumulatively, in start-age order regardless of input order", () => {
    const socialSecurity: RetirementIncomeStream = { id: "social-security", name: "Social Security", startAge: 67, annualAmount: 240000 }
    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 63, annualAmount: 100000 }
    expect(buildSpendingPhases(45, 60, 500000, [socialSecurity, pension])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
      { id: "income-pension", name: "After Pension", fromAge: 63, annualWithdrawal: 400000 },
      { id: "income-social-security", name: "After Social Security", fromAge: 67, annualWithdrawal: 160000 },
    ])
  })

  it("floors the withdrawal at 0 rather than going negative when income exceeds spend", () => {
    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 60, annualAmount: 900000 }
    expect(buildSpendingPhases(45, 60, 500000, [pension])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 0 },
    ])
  })
})

describe("retirementIncomeStreams", () => {
  const base: Pick<
    DashboardConfig,
    "pensionStartAge" | "pensionMonthlyAmount" | "socialSecurityClaimingAge" | "socialSecurityMonthlyAt62" | "socialSecurityMonthlyAt67" | "socialSecurityMonthlyAt70"
  > = DEFAULT_DASHBOARD_CONFIG

  it("returns nothing when nothing is configured", () => {
    expect(retirementIncomeStreams(base)).toEqual([])
  })

  it("requires both a pension start age and an amount before counting it", () => {
    expect(retirementIncomeStreams({ ...base, pensionStartAge: 60 })).toEqual([])
    expect(retirementIncomeStreams({ ...base, pensionMonthlyAmount: 100000 })).toEqual([])
    expect(retirementIncomeStreams({ ...base, pensionStartAge: 60, pensionMonthlyAmount: 100000 })).toEqual([
      { id: "pension", name: "Pension", startAge: 60, annualAmount: 1200000 },
    ])
  })

  it("uses whichever of the three SSA figures matches the chosen claiming age", () => {
    const withAllThree = { ...base, socialSecurityMonthlyAt62: 180000, socialSecurityMonthlyAt67: 240000, socialSecurityMonthlyAt70: 300000 }
    expect(retirementIncomeStreams({ ...withAllThree, socialSecurityClaimingAge: 62 })).toEqual([
      { id: "social-security", name: "Social Security", startAge: 62, annualAmount: 2160000 },
    ])
    expect(retirementIncomeStreams({ ...withAllThree, socialSecurityClaimingAge: 70 })).toEqual([
      { id: "social-security", name: "Social Security", startAge: 70, annualAmount: 3600000 },
    ])
  })

  it("doesn't count Social Security when a claiming age is set but that age's own figure is missing", () => {
    expect(retirementIncomeStreams({ ...base, socialSecurityClaimingAge: 67, socialSecurityMonthlyAt62: 180000 })).toEqual([])
  })
})

describe("monteCarloAssumptionsWithOverrides", () => {
  it("falls back to the plain defaults when nothing is pinned", () => {
    expect(monteCarloAssumptionsWithOverrides(DEFAULT_DASHBOARD_CONFIG)).toEqual(MONTE_CARLO_ASSUMPTIONS)
  })

  it("layers only the fields actually set, leaving the rest at their defaults", () => {
    const overridden = monteCarloAssumptionsWithOverrides({
      ...DEFAULT_DASHBOARD_CONFIG,
      monteCarloWithdrawalStrategy: "sequential",
      monteCarloInflationMean: 0.05,
    })
    expect(overridden.withdrawalStrategy).toBe("sequential")
    expect(overridden.inflationMean).toBe(0.05)
    expect(overridden.returnModel).toBe(MONTE_CARLO_ASSUMPTIONS.returnModel)
    expect(overridden.simulationCount).toBe(MONTE_CARLO_ASSUMPTIONS.simulationCount)
  })

  it("layers a pinned taxModel over the default", () => {
    expect(monteCarloAssumptionsWithOverrides({ ...DEFAULT_DASHBOARD_CONFIG, monteCarloTaxModel: "bands" }).taxModel).toBe("bands")
  })
})

describe("pinnedMonteCarloFields", () => {
  it("returns an empty set when nothing is configured", () => {
    expect(pinnedMonteCarloFields(DEFAULT_DASHBOARD_CONFIG)).toEqual(new Set())
  })

  it("names the MonteCarloCardMeta field for each dashboard field that's actually set", () => {
    const pinned = pinnedMonteCarloFields({
      ...DEFAULT_DASHBOARD_CONFIG,
      monteCarloWithdrawalStrategy: "sequential",
      monteCarloSimulationCount: 10000,
    })
    expect(pinned).toEqual(new Set(["withdrawalStrategy", "simulationCount"]))
  })

  it("pins taxModel the same way as every other Simulation setting", () => {
    expect(pinnedMonteCarloFields({ ...DEFAULT_DASHBOARD_CONFIG, monteCarloTaxModel: "bands" })).toEqual(new Set(["taxModel"]))
  })

  it("pins withdrawalRule and taxBands as whole values, same mechanism as the flat scalars", () => {
    const dashboard: DashboardConfig = {
      ...DEFAULT_DASHBOARD_CONFIG,
      monteCarloWithdrawalRule: { type: "guardrails", prosperityTriggerPct: 0.2 },
      monteCarloTaxBands: [{ id: "b1", from: 0, rate: 0.1 }],
    }
    expect(pinnedMonteCarloFields(dashboard)).toEqual(new Set(["withdrawalRule", "taxBands"]))
    expect(monteCarloAssumptionsWithOverrides(dashboard).withdrawalRule).toEqual({ type: "guardrails", prosperityTriggerPct: 0.2 })
    expect(monteCarloAssumptionsWithOverrides(dashboard).taxBands).toEqual([{ id: "b1", from: 0, rate: 0.1 }])
  })

  it("pins an empty taxBands array (a real, non-null pinned value) the same as a populated one", () => {
    const dashboard: DashboardConfig = { ...DEFAULT_DASHBOARD_CONFIG, monteCarloTaxBands: [] }
    expect(pinnedMonteCarloFields(dashboard)).toEqual(new Set(["taxBands"]))
    expect(monteCarloAssumptionsWithOverrides(dashboard).taxBands).toEqual([])
  })
})

describe("crossoverAssumptionsWithOverrides", () => {
  it("falls back to the plain defaults when nothing is pinned", () => {
    expect(crossoverAssumptionsWithOverrides(DEFAULT_DASHBOARD_CONFIG)).toEqual(CROSSOVER_ASSUMPTIONS)
  })

  it("layers only the fields actually set, leaving the rest at their defaults", () => {
    const overridden = crossoverAssumptionsWithOverrides({
      ...DEFAULT_DASHBOARD_CONFIG,
      crossoverSafeWithdrawalRate: 0.035,
      crossoverExpenseAdjustmentFactor: 0.85,
    })
    expect(overridden.safeWithdrawalRate).toBe(0.035)
    expect(overridden.expenseAdjustmentFactor).toBe(0.85)
    expect(overridden.estimatedReturn).toBe(CROSSOVER_ASSUMPTIONS.estimatedReturn)
    expect(overridden.projectionType).toBe(CROSSOVER_ASSUMPTIONS.projectionType)
  })

  it("layers a pinned projectionType over the default", () => {
    expect(crossoverAssumptionsWithOverrides({ ...DEFAULT_DASHBOARD_CONFIG, crossoverProjectionType: "median" }).projectionType).toBe("median")
  })
})

describe("pinnedCrossoverFields", () => {
  it("returns an empty set when nothing is configured", () => {
    expect(pinnedCrossoverFields(DEFAULT_DASHBOARD_CONFIG)).toEqual(new Set())
  })

  it("names the CrossoverCardMeta field for each dashboard field that's actually set", () => {
    const pinned = pinnedCrossoverFields({
      ...DEFAULT_DASHBOARD_CONFIG,
      crossoverSafeWithdrawalRate: 0.035,
      crossoverExpenseAdjustmentFactor: 0.85,
    })
    expect(pinned).toEqual(new Set(["safeWithdrawalRate", "expenseAdjustmentFactor"]))
  })
})

describe("buildMonteCarloWidget", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })
  const nonPortfolioAccount = account({ id: "a2", category: "cash" })

  it("builds one pot per portfolio account, excluding debt/cash/other", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount, nonPortfolioAccount], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.pots).toHaveLength(1)
    expect(widget.meta?.pots?.[0]?.accountId).toBe("a1")
  })

  it("threads the given assumptions, ages, spending phases, and a default name", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 45, 90, 500000, { ...MONTE_CARLO_ASSUMPTIONS, withdrawalStrategy: "sequential" })
    expect(widget.meta).toMatchObject({
      name: "Monte Carlo",
      withdrawalStrategy: "sequential",
      currentAge: 45,
      targetAge: 90,
      taxModel: "flat",
      inflationMean: 0.03,
    })
    expect(widget.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 45, 500000))
  })

  it("threads a future retirement age into the spending phases", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 60, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 60, 500000))
  })

  it("accepts an explicit name override", () => {
    const widget = buildMonteCarloWidget(0, 6, [portfolioAccount], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS, "Retire at 55")
    expect(widget.meta?.name).toBe("Retire at 55")
  })

  it("builds a contribution entry only for accounts with a nonzero monthlyContribution, stopping at retirement", () => {
    const withContribution = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80", monthlyContribution: 50000 })
    const withoutContribution = account({ id: "a2", category: "hsa", allocationPreset: "equity-60" })
    const widget = buildMonteCarloWidget(0, 6, [withContribution, withoutContribution], 45, 60, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.contributions).toHaveLength(1)
    expect(widget.meta?.contributions?.[0]).toMatchObject({ potId: "a1", annualAmount: 600000, toAge: 60 })
  })

  it("stops modeling contributions entirely once already retired at generation time", () => {
    const withContribution = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80", monthlyContribution: 50000 })
    const widget = buildMonteCarloWidget(0, 6, [withContribution], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.contributions).toEqual([])
  })

  it("throws a clear error when a portfolio account has no allocationPreset set", () => {
    const incomplete = account({ id: "a3", category: "hsa", allocationPreset: null })
    expect(() => buildMonteCarloWidget(0, 6, [incomplete], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS)).toThrow(/allocationPreset/)
  })

  it("orders pots by withdrawalOrder, not by input array order -- the order 'sequential' drains in", () => {
    const first = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80", withdrawalOrder: 1 })
    const second = account({ id: "a2", category: "hsa", allocationPreset: "equity-60", withdrawalOrder: 0 })
    const widget = buildMonteCarloWidget(0, 6, [first, second], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.pots?.map((pot) => pot.accountId)).toEqual(["a2", "a1"])
  })

  it("puts accounts with no explicit withdrawalOrder after every explicitly-ordered one, keeping their own relative order", () => {
    const unordered1 = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })
    const ordered = account({ id: "a2", category: "hsa", allocationPreset: "equity-60", withdrawalOrder: 0 })
    const unordered2 = account({ id: "a3", category: "investment-taxable", allocationPreset: "equity-40" })
    const widget = buildMonteCarloWidget(0, 6, [unordered1, ordered, unordered2], 45, 45, 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widget.meta?.pots?.map((pot) => pot.accountId)).toEqual(["a2", "a1", "a3"])
  })
})

describe("buildMonteCarloWidgets", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })

  it("builds one widget with the plain default name for a single retirement age", () => {
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [55], 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widgets).toHaveLength(1)
    expect(widgets[0]?.meta?.name).toBe("Monte Carlo")
    expect(widgets[0]).toMatchObject({ x: 0, y: 6 })
  })

  it("stacks one uniquely-named widget per retirement age, in order", () => {
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [55, 60, 65], 90, 500000, MONTE_CARLO_ASSUMPTIONS)
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
    const widgets = buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [45, 60], 90, 500000, MONTE_CARLO_ASSUMPTIONS)
    expect(widgets[0]?.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 45, 500000))
    expect(widgets[1]?.meta?.spendingPhases).toEqual(buildSpendingPhases(45, 60, 500000))
  })
})

describe("mergeGeneratedDashboard", () => {
  const portfolioAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })

  it("returns the generated dashboard unchanged when there's no existing file", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"], CROSSOVER_ASSUMPTIONS, null)
    expect(mergeGeneratedDashboard(generated, null)).toEqual(generated)
  })

  it("preserves a net-worth-card customization outright -- it has no owned fields", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"], CROSSOVER_ASSUMPTIONS, null)
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [{ type: "net-worth-card", x: 0, y: 0, width: 12, height: 2, meta: { name: "My Net Worth", mode: "stacked" } }],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets[0]?.meta).toEqual({ name: "My Net Worth", mode: "stacked" })
  })

  it("preserves a hand-narrowed category/account selection, not just other assumptions", () => {
    // Actual's own crossover widget lets a person uncheck individual categories/accounts --
    // narrowing that selection is exactly the edit a regenerate must not silently discard.
    const generated = buildFireDashboard(["new-cat", "another-cat"], ["new-acct", "another-acct"], CROSSOVER_ASSUMPTIONS, null)
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
            expenseCategoryIds: ["new-cat"], // hand-narrowed: dropped "another-cat"
            incomeAccountIds: ["new-acct"], // hand-narrowed: dropped "another-acct"
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

  it("prefers the Plan section's own pinned expense-category selection over the existing widget's", () => {
    // The Plan section's own selection (fire-accounts.ts's DashboardConfig.crossoverExpenseCategoryIds)
    // is meant to be authoritative once set -- it should win even over a selection someone
    // separately hand-narrowed inside Actual's own crossover widget UI.
    const generated = buildFireDashboard(["new-cat", "another-cat"], ["new-acct"], CROSSOVER_ASSUMPTIONS, null)
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
            expenseCategoryIds: ["new-cat"], // hand-narrowed inside Actual
            incomeAccountIds: ["new-acct"],
            safeWithdrawalRate: 0.04,
            estimatedReturn: null,
            expectedContribution: null,
            projectionType: "hampel",
            expenseAdjustmentFactor: 1,
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing, new Set(), ["another-cat"])
    const crossover = merged.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({ expenseCategoryIds: ["another-cat"] })
  })

  it("prefers a pinned crossover assumption over the existing widget's own hand-tuned value", () => {
    const generated = buildFireDashboard(["new-cat"], ["new-acct"], { ...CROSSOVER_ASSUMPTIONS, safeWithdrawalRate: 0.035 }, null)
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["new-cat"], incomeAccountIds: ["new-acct"], safeWithdrawalRate: 0.045, estimatedReturn: 0.06 },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing, new Set(), null, new Set(["safeWithdrawalRate"]))
    const crossover = merged.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({ safeWithdrawalRate: 0.035, estimatedReturn: 0.06 }) // unpinned field still preserved
  })

  it("falls back to the existing widget's own selection when nothing is pinned", () => {
    const generated = buildFireDashboard(["new-cat", "another-cat"], ["new-acct"], CROSSOVER_ASSUMPTIONS, null)
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: ["new-cat"], incomeAccountIds: ["new-acct"], safeWithdrawalRate: 0.04 },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing, new Set(), null)
    const crossover = merged.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({ expenseCategoryIds: ["new-cat"] })
  })

  it("falls back to the freshly generated category/account list when the existing selection is empty", () => {
    // Actual's crossover projection zeroes out historical expense data entirely when
    // expenseCategoryIds is empty (silently claiming "already FI"), so an empty existing
    // selection is never worth preserving verbatim.
    const generated = buildFireDashboard(["new-cat"], ["new-acct"], CROSSOVER_ASSUMPTIONS, null)
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "crossover-card",
          x: 0,
          y: 2,
          width: 12,
          height: 4,
          meta: { name: "FIRE Crossover", expenseCategoryIds: [], incomeAccountIds: [], safeWithdrawalRate: 0.04 },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const crossover = merged.widgets.find((widget) => widget.type === "crossover-card")
    expect(crossover?.meta).toMatchObject({ expenseCategoryIds: ["new-cat"], incomeAccountIds: ["new-acct"] })
  })

  it("prefers a pinned withdrawalRule over the existing widget's own hand-tuned rule", () => {
    const generated = {
      version: 1 as const,
      widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000, { ...MONTE_CARLO_ASSUMPTIONS, withdrawalRule: { type: "guardrails", prosperityTriggerPct: 0.2 } }),
    }
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
            spendingPhases: [],
            currentAge: 40,
            targetAge: 90,
            withdrawalRule: { type: "floor-ceiling", floorPct: 0.03, ceilingPct: 0.06 }, // hand-tuned inside Actual
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing, new Set(["withdrawalRule"]))
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    expect(meta.withdrawalRule).toEqual({ type: "guardrails", prosperityTriggerPct: 0.2 })
  })

  it("preserves the existing widget's own withdrawalRule when nothing is pinned", () => {
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000, MONTE_CARLO_ASSUMPTIONS) }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "monte-carlo-card",
          x: 0,
          y: 6,
          width: 12,
          height: 4,
          meta: { name: "Monte Carlo", pots: [], spendingPhases: [], currentAge: 40, targetAge: 90, withdrawalRule: { type: "floor-ceiling", floorPct: 0.03, ceilingPct: 0.06 } },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    expect(meta.withdrawalRule).toEqual({ type: "floor-ceiling", floorPct: 0.03, ceilingPct: 0.06 })
  })

  it("refreshes a pot's account-derived fields but preserves an extra fee field", () => {
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000, MONTE_CARLO_ASSUMPTIONS) }
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
            returnModel: "historical-bootstrap",
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    const pot = (meta.pots as Record<string, unknown>[])[0] as Record<string, unknown>
    expect(pot.allocationPreset).toBe("equity-80") // refreshed from config.json, not the stale existing value
    expect(pot.annualFeeRate).toBe(0.001) // extra field preserved
    expect(meta).toMatchObject({ currentAge: 45, targetAge: 100, withdrawalStrategy: "sequential", returnModel: "historical-bootstrap" })
  })

  it("refreshes an account's contribution from real data but preserves an extra hand-added one", () => {
    const contributingAccount = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80", monthlyContribution: 50000 })
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [contributingAccount], 45, [60], 100, 500000, MONTE_CARLO_ASSUMPTIONS) }
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
            spendingPhases: [],
            contributions: [
              { id: "contribution-a1", potId: "a1", annualAmount: 999 }, // stale -- must be refreshed
              { id: "contribution-extra", potId: "other-pot", annualAmount: 12000 }, // hand-added -- must survive
            ],
          },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    const contributions = meta.contributions as { id: string; annualAmount: number }[]
    expect(contributions).toHaveLength(2)
    expect(contributions.find((c) => c.id === "contribution-a1")?.annualAmount).toBe(600000) // refreshed: 50000 x 12
    expect(contributions.find((c) => c.id === "contribution-extra")?.annualAmount).toBe(12000) // preserved
  })

  it("keeps an extra hand-added spending phase but refreshes the owned ones", () => {
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000, MONTE_CARLO_ASSUMPTIONS) }
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

  it("forces a pinned Monte Carlo field to the generated value, but still preserves an unpinned one", () => {
    const generated = {
      version: 1 as const,
      widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60], 100, 500000, { ...MONTE_CARLO_ASSUMPTIONS, withdrawalStrategy: "sequential", simulationCount: 10000 }),
    }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        {
          type: "monte-carlo-card",
          x: 0,
          y: 6,
          width: 12,
          height: 4,
          meta: { name: "Monte Carlo", pots: [], spendingPhases: [], withdrawalStrategy: "proportional", returnModel: "historical-bootstrap" },
        },
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing, new Set(["withdrawalStrategy", "simulationCount"]))
    const meta = merged.widgets[0]?.meta as Record<string, unknown>
    expect(meta.withdrawalStrategy).toBe("sequential") // pinned -- generated wins over the stale live value
    expect(meta.simulationCount).toBe(10000) // pinned -- generated wins even though existing never set it
    expect(meta.returnModel).toBe("historical-bootstrap") // unpinned -- existing still wins, same as before
  })

  it("drops a monte-carlo-card whose retirement age is no longer requested", () => {
    // both fixtures request 2+ ages, so the "Monte Carlo — Retire at N" naming (see
    // buildMonteCarloWidgets) is identical for the ages that carry over between them
    const generated = { version: 1 as const, widgets: buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [60, 65], 100, 500000, MONTE_CARLO_ASSUMPTIONS) }
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [
        ...(buildMonteCarloWidgets(0, 6, [portfolioAccount], 45, [53, 60, 65], 100, 500000, MONTE_CARLO_ASSUMPTIONS) as unknown as ExistingDashboard["widgets"]),
      ],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets.map((widget) => (widget.meta as { name?: string } | null)?.name)).toEqual([
      "Monte Carlo — Retire at 60",
      "Monte Carlo — Retire at 65",
    ])
  })

  it("carries through untouched a widget of a type it never generates", () => {
    const generated = buildFireDashboard(["cat-1"], ["a1"], CROSSOVER_ASSUMPTIONS, null)
    const existing: ExistingDashboard = {
      version: 1,
      widgets: [{ type: "custom-note-card", x: 0, y: 20, width: 12, height: 2, meta: { text: "hand-added" } }],
    }
    const merged = mergeGeneratedDashboard(generated, existing)
    expect(merged.widgets).toContainEqual({ type: "custom-note-card", x: 0, y: 20, width: 12, height: 2, meta: { text: "hand-added" } })
  })
})
