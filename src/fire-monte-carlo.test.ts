import { describe, expect, it } from "vitest"

import { runRetirementMonteCarlo } from "./fire-monte-carlo.ts"
import type { MonteCarloAssumptions } from "./fire-dashboard.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"

// Mirrors fire-dashboard.test.ts's own account()/MONTE_CARLO_ASSUMPTIONS fixtures, so a widget this
// app would export and a simulation this app runs itself are exercised the same way in tests too.
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

describe("runRetirementMonteCarlo", () => {
  it("uses the account's real live balance, not the vendored engine's own hardcoded pot default", () => {
    // Zero spend and zero return volatility isolates exactly one thing: does the simulated starting
    // balance match the real $12,345.67 in the balances map, or the engine's own 500,000.00 default
    // (createMonteCarloPot's own starting point, used whenever a pot's startingBalance is left
    // unset) -- the real bug this test guards: buildMonteCarloWidget never sets startingBalance
    // itself (Actual resolves that live when the widget is actually displayed), so this app's own
    // adapter has to fill it in, or every simulation silently runs on the wrong money entirely.
    const noVolatility: MonteCarloAssumptions = {
      ...MONTE_CARLO_ASSUMPTIONS,
      inflationMean: null,
    }
    const a1 = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80", customReturnMean: 0, customReturnStdDev: 0 })
    const result = runRetirementMonteCarlo([a1], new Map([["a1", 1234567]]), 60, 60, 61, 0, noVolatility)
    expect(result.percentileBands[0]?.p50).toBe(1234567)
  })

  it("reports a comfortable plan as fully successful and an underfunded one as fully failed", () => {
    const a1 = account({ id: "a1", category: "investment-taxable", allocationPreset: "cash", customReturnMean: 0.03, customReturnStdDev: 0 })

    const comfortable = runRetirementMonteCarlo([a1], new Map([["a1", 500_000_00]]), 60, 60, 70, 1_000_00, MONTE_CARLO_ASSUMPTIONS)
    expect(comfortable.successRate).toBe(1)

    const underfunded = runRetirementMonteCarlo([a1], new Map([["a1", 1_000_00]]), 60, 60, 70, 500_000_00, MONTE_CARLO_ASSUMPTIONS)
    expect(underfunded.successRate).toBe(0)
    expect(underfunded.earliestDepletionYear).toBe(1)
  })

  it("returns one percentile band entry per year of the horizon, run from the current age (not the retirement age) through the target age", () => {
    // The simulation is one continuous timeline from today, not one that starts at retirement:
    // buildMonteCarloWidget stores the person's real currentAge/targetAge on every widget
    // regardless of which retirement age that widget represents (retirementAge only moves where
    // contributions stop and spending starts within that same timeline -- see buildSpendingPhases),
    // and Actual's own getMonteCarloHorizonYears sizes the horizon from currentAge to targetAge
    // accordingly. This app's adapter has to match that or its horizon would disagree with what
    // Actual itself would compute for the exact same widget.
    const a1 = account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-80" })
    const result = runRetirementMonteCarlo([a1], new Map([["a1", 1_000_000_00]]), 60, 65, 90, 40_000_00, MONTE_CARLO_ASSUMPTIONS)
    expect(result.percentileBands).toHaveLength(31) // 90 - 60 + 1 (year 0 through year 30)
    expect(result.horizonYears).toBe(30)
  })
})
