import { describe, expect, it } from "vitest"

import {
  ALLOCATION_PRESET_RETURNS,
  buildMonteCarloWidget,
  buildPot,
  buildSpendingPhases,
  effectiveAccessAge,
  expenseAdjustmentFactorWithOverride,
  monteCarloAssumptionsWithOverrides,
  portfolioAccountIds,
  retirementIncomeStreams,
  spendHistoryMonthsWithOverride,
  withdrawalTaxRateFor,
} from "./fire-dashboard.ts"
import type { MonteCarloAssumptions, RetirementIncomeStream } from "./fire-dashboard.ts"
import type { ClassifiedAccount, DashboardConfig, ExpenseAdjustment } from "./fire-accounts.ts"
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
    earlyWithdrawalPenalty: false,
    seppMethod: null,
    seppStartAge: null,
    seppInterestRate: null,
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
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 65)).toBe(59)
  })

  it("overrides to the separation age when it qualifies (55+), is earlier, and is at or before this scenario's retirement age", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 55)).toBe(55)
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 60)).toBe(55)
  })

  it("has no effect when the separation age is below 55", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 50, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 65)).toBe(59)
  })

  it("takes the earlier of the two when the separation age is above the existing accessAge", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 62, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 65)).toBe(59)
  })

  it("uses the separation age directly when accessAge is null", () => {
    expect(effectiveAccessAge({ accessAge: null, ruleOf55SeparationAge: 56, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 65)).toBe(56)
  })

  it("does not apply the boost when this scenario retires before the account's own separation age", () => {
    // Retiring at 52 while still asserting employment (and thus separation) at this employer at 55
    // is a contradiction -- this app models "retired" as "no longer working anywhere" -- so the
    // normal accessAge stands for this scenario; a later scenario (e.g. retiring at 55 or 58) still
    // gets the boost, since the two ages don't contradict there.
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 52)).toBe(59)
    expect(effectiveAccessAge({ accessAge: null, ruleOf55SeparationAge: 56, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: null }, 54)).toBe(null)
  })

  it("grants unconditional access when the early-withdrawal-penalty option is accepted", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null, earlyWithdrawalPenalty: true, seppMethod: null, seppStartAge: null }, 65)).toBe(null)
  })

  it("takes priority over Rule of 55, since it's strictly more permissive", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55, earlyWithdrawalPenalty: true, seppMethod: null, seppStartAge: null }, 65)).toBe(null)
  })

  it("grants early access at the SEPP start age when a method is elected", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null, earlyWithdrawalPenalty: false, seppMethod: "rmd", seppStartAge: 50 }, 65)).toBe(50)
  })

  it("ignores a SEPP start age with no method elected alongside it, or vice versa", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null, earlyWithdrawalPenalty: false, seppMethod: null, seppStartAge: 50 }, 65)).toBe(59)
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: null, earlyWithdrawalPenalty: false, seppMethod: "rmd", seppStartAge: null }, 65)).toBe(59)
  })

  it("takes the earlier of Rule of 55 and a SEPP election when both qualify", () => {
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 55, earlyWithdrawalPenalty: false, seppMethod: "rmd", seppStartAge: 50 }, 65)).toBe(50)
    expect(effectiveAccessAge({ accessAge: 59, ruleOf55SeparationAge: 56, earlyWithdrawalPenalty: false, seppMethod: "rmd", seppStartAge: 60 }, 65)).toBe(56)
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

  it("folds an expense adjustment already active at retirement straight into the base spending figure", () => {
    const college: ExpenseAdjustment = { id: "college", name: "College", annualAmount: 100000, startAge: 60, endAge: null, inflate: true }
    expect(buildSpendingPhases(45, 60, 500000, [], [college])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 600000 },
    ])
  })

  it("adds a stepped-up phase for an expense adjustment starting after retirement, and steps back down once it ends", () => {
    const college: ExpenseAdjustment = { id: "college", name: "College", annualAmount: 100000, startAge: 65, endAge: 68, inflate: true }
    expect(buildSpendingPhases(45, 60, 500000, [], [college])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
      { id: "expense-college-start", name: "College", fromAge: 65, annualWithdrawal: 600000 },
      { id: "expense-college-end", name: "College ends", fromAge: 69, annualWithdrawal: 500000 },
    ])
  })

  it("interleaves income and expense-adjustment boundaries in age order, stacking their effects cumulatively", () => {
    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 67, annualAmount: 200000 }
    const carPayment: ExpenseAdjustment = { id: "car", name: "Car payment", annualAmount: 60000, startAge: 63, endAge: null, inflate: false }
    expect(buildSpendingPhases(45, 60, 500000, [pension], [carPayment])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
      { id: "expense-car-start", name: "Car payment", fromAge: 63, annualWithdrawal: 560000 },
      { id: "income-pension", name: "After Pension", fromAge: 67, annualWithdrawal: 360000 },
    ])
  })

  it("a negative (reducing) expense adjustment lowers the withdrawal, same as income does", () => {
    const downsize: ExpenseAdjustment = { id: "downsize", name: "Downsize", annualAmount: -150000, startAge: 70, endAge: null, inflate: true }
    expect(buildSpendingPhases(45, 60, 500000, [], [downsize])).toEqual([
      { id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 },
      { id: "retirement-spending", name: "Retirement spending", fromAge: 60, annualWithdrawal: 500000 },
      { id: "expense-downsize-start", name: "Downsize", fromAge: 70, annualWithdrawal: 350000 },
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


describe("expenseAdjustmentFactorWithOverride", () => {
  it("falls back to the plain default (1.0) when nothing is pinned", () => {
    expect(expenseAdjustmentFactorWithOverride(DEFAULT_DASHBOARD_CONFIG)).toBe(1.0)
  })

  it("uses the pinned value when set", () => {
    expect(expenseAdjustmentFactorWithOverride({ ...DEFAULT_DASHBOARD_CONFIG, crossoverExpenseAdjustmentFactor: 0.85 })).toBe(0.85)
  })
})

describe("spendHistoryMonthsWithOverride", () => {
  it("falls back to the plain default (12) when nothing is pinned", () => {
    expect(spendHistoryMonthsWithOverride(DEFAULT_DASHBOARD_CONFIG)).toBe(12)
  })

  it("uses the pinned value when set", () => {
    expect(spendHistoryMonthsWithOverride({ ...DEFAULT_DASHBOARD_CONFIG, crossoverSpendHistoryMonths: 6 })).toBe(6)
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

