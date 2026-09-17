import { describe, expect, it } from "vitest"

import {
  bridgeFinding,
  calculateMortgagePayoff,
  monteCarloFinding,
  simulateBridge,
  toBridgeAccounts,
} from "./fire-analysis.ts"
import type { BridgeAccount, BridgeResult } from "./fire-analysis.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import type { RetirementIncomeStream } from "./fire-dashboard.ts"
import type { MonteCarloSummary } from "./fire-monte-carlo.ts"

// Function to build a bridge account with inert defaults -- no growth, no contributions, no tax --
// so each test only has to state the one dimension it is actually exercising.
function bridgeAccount(overrides: Partial<BridgeAccount> & Pick<BridgeAccount, "id" | "balance">): BridgeAccount {
  return {
    name: "Some Account",
    accessAge: null,
    annualContribution: 0,
    returnMean: 0,
    withdrawalTaxRate: 0,
    earlyWithdrawalPenaltyUntilAge: null,
    ...overrides,
  }
}

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

describe("simulateBridge", () => {
  it("depletes the year after the reachable pool is spent down", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0)
    expect(result.depletionAge).toBe(60)
    expect(result.nextUnlockAge).toBeNull()
  })

  it("reports no depletion when the pool outlasts the plan", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 100000 })], 50, 50, 100, 100, 0)
    expect(result.depletionAge).toBeNull()
  })

  it("ignores locked money while it is still locked, and reports when it unlocks", () => {
    const accounts = [
      bridgeAccount({ id: "reachable", balance: 200 }),
      bridgeAccount({ id: "locked", balance: 1000, accessAge: 59 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 100, 100, 0)
    expect(result.accessibleAtRetirement).toBe(200)
    expect(result.lockedAtRetirement).toBe(1000)
    expect(result.depletionAge).toBe(52)
    expect(result.nextUnlockAge).toBe(59)
  })

  it("spends locked money once it has unlocked", () => {
    const accounts = [
      bridgeAccount({ id: "reachable", balance: 500 }),
      bridgeAccount({ id: "locked", balance: 500, accessAge: 53 }),
    ]
    // 500 alone would run dry entering 55; the pot unlocking at 53 carries it to 60.
    const result = simulateBridge(accounts, 50, 50, 100, 100, 0)
    expect(result.depletionAge).toBe(60)
  })

  it("still reports a gap when it outlives the first unlock tier but not the second", () => {
    const accounts = [
      bridgeAccount({ id: "reachable", balance: 300 }),
      bridgeAccount({ id: "tier1", balance: 200, accessAge: 53 }),
      bridgeAccount({ id: "tier2", balance: 5000, accessAge: 59 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 100, 100, 0)
    // Survives past the 53 tranche on its 500, then runs dry well before the 59 one opens.
    expect(result.depletionAge).toBe(55)
    expect(result.nextUnlockAge).toBe(53)
    expect(result.nextUnlockAfterDepletion).toBe(59)
    expect(result.lockedAtDepletion).toBe(5000)
    expect(bridgeFinding(result, 100).level).toBe("fail")
  })

  it("records one timeline point per year, ending at zero the year the reachable pool runs dry", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0)
    expect(result.timeline).toEqual([
      { age: 50, accessibleBalance: 1000, lockedBalance: 0, projectedSpend: 100 },
      { age: 51, accessibleBalance: 900, lockedBalance: 0, projectedSpend: 100 },
      { age: 52, accessibleBalance: 800, lockedBalance: 0, projectedSpend: 100 },
      { age: 53, accessibleBalance: 700, lockedBalance: 0, projectedSpend: 100 },
      { age: 54, accessibleBalance: 600, lockedBalance: 0, projectedSpend: 100 },
      { age: 55, accessibleBalance: 500, lockedBalance: 0, projectedSpend: 100 },
      { age: 56, accessibleBalance: 400, lockedBalance: 0, projectedSpend: 100 },
      { age: 57, accessibleBalance: 300, lockedBalance: 0, projectedSpend: 100 },
      { age: 58, accessibleBalance: 200, lockedBalance: 0, projectedSpend: 100 },
      { age: 59, accessibleBalance: 100, lockedBalance: 0, projectedSpend: 100 },
      { age: 60, accessibleBalance: 0, lockedBalance: 0, projectedSpend: 100 },
    ])
    // The first point is exactly the retirement-age split, and the last is the depletion age --
    // the same two facts BridgeResult's own summary fields already assert, restated here as the
    // shape the chart actually draws from.
    expect(result.timeline[0]).toEqual({
      age: result.retirementAge,
      accessibleBalance: result.accessibleAtRetirement,
      lockedBalance: result.lockedAtRetirement,
      projectedSpend: 100,
    })
    expect(result.timeline.at(-1)?.age).toBe(result.depletionAge)
  })

  it("records through planToAge, inclusive, when the scenario never depletes", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 100000 })], 50, 50, 100, 100, 0)
    expect(result.depletionAge).toBeNull()
    expect(result.timeline).toHaveLength(51) // ages 50..100 inclusive
    expect(result.timeline[0]?.age).toBe(50)
    expect(result.timeline.at(-1)?.age).toBe(100)
  })

  it("moves an account's balance from locked to accessible in the timeline the moment it unlocks", () => {
    const accounts = [
      bridgeAccount({ id: "reachable", balance: 500 }),
      bridgeAccount({ id: "locked", balance: 500, accessAge: 53 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 100, 100, 0)
    const byAge = new Map(result.timeline.map((year) => [year.age, year]))
    // The year before it unlocks: still split, locked sitting untouched at its starting balance.
    expect(byAge.get(52)).toEqual({ age: 52, accessibleBalance: 300, lockedBalance: 500, projectedSpend: 100 })
    // The unlock year itself: the whole 500 has moved over, before that year's own withdrawal.
    expect(byAge.get(53)).toEqual({ age: 53, accessibleBalance: 700, lockedBalance: 0, projectedSpend: 100 })
    // Never locked again once unlocked.
    expect(result.timeline.filter((year) => year.age >= 53).every((year) => year.lockedBalance === 0)).toBe(true)
  })

  it("nets a later-starting income stream out of spend before inflating, extending the runway", () => {
    const withoutIncome = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0)
    expect(withoutIncome.depletionAge).toBe(60)

    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 55, annualAmount: 50 }
    const withIncome = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0, [pension])
    expect(withIncome.depletionAge).toBe(65)
  })

  it("never withdraws (and so never depletes) once income alone covers spend", () => {
    const pension: RetirementIncomeStream = { id: "pension", name: "Pension", startAge: 50, annualAmount: 1000 }
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 100 })], 50, 50, 100, 100, 0, [pension])
    expect(result.depletionAge).toBeNull()
  })

  it("grosses withdrawals up for tax, shortening the runway", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 1000, withdrawalTaxRate: 0.5 })], 50, 50, 100, 100, 0)
    // Funding 100 net costs 200 gross, so 1000 lasts five years rather than ten.
    expect(result.depletionAge).toBe(55)
  })

  it("adds the early-withdrawal penalty on top of the flat rate for years before its own cutoff, then drops it", () => {
    const accounts = [bridgeAccount({ id: "a1", balance: 1_000_000, withdrawalTaxRate: 0, earlyWithdrawalPenaltyUntilAge: 52 })]
    const result = simulateBridge(accounts, 50, 50, 53, 100, 0)
    // Age 50->51: funding 100 net at a 10% penalty (no base rate) costs 100/0.9 gross.
    const balanceAfterAge50 = 1_000_000 - 100 / 0.9
    // Age 51->52: same penalty still applies (52 is the cutoff, not yet reached).
    const balanceAfterAge51 = balanceAfterAge50 - 100 / 0.9
    // Age 52->53: the cutoff age itself -- penalty no longer applies, plain 100 net = 100 gross.
    const balanceAfterAge52 = balanceAfterAge51 - 100
    expect(result.timeline.map((point) => point.accessibleBalance)).toEqual([
      expect.closeTo(1_000_000, 5),
      expect.closeTo(balanceAfterAge50, 5),
      expect.closeTo(balanceAfterAge51, 5),
      expect.closeTo(balanceAfterAge52, 5),
    ])
  })

  it("never adds the penalty for an account with no earlyWithdrawalPenaltyUntilAge set", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 1000, withdrawalTaxRate: 0 })], 50, 50, 100, 100, 0)
    expect(result.timeline[1]?.accessibleBalance).toBe(900)
  })

  it("accumulates contributions until retirement, then stops", () => {
    const accounts = [bridgeAccount({ id: "a1", balance: 0, annualContribution: 500 })]
    const result = simulateBridge(accounts, 50, 52, 100, 100, 0)
    expect(result.accessibleAtRetirement).toBe(1000)
    expect(result.depletionAge).toBe(62)
  })

  it("inflates spending against the current age, not the retirement age", () => {
    const flat = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0)
    const inflated = simulateBridge([bridgeAccount({ id: "a1", balance: 1000 })], 50, 50, 100, 100, 0.1)
    expect(inflated.depletionAge).toBeLessThan(flat.depletionAge as number)
  })
})

// Function to build a bridge result with inert defaults -- bridgeFinding reads only the summary
// fields, never the timeline, so these tests never need to fabricate one.
function bridgeResult(overrides: Partial<BridgeResult> & Pick<BridgeResult, "retirementAge">): BridgeResult {
  return {
    accessibleAtRetirement: 0,
    lockedAtRetirement: 0,
    depletionAge: null,
    nextUnlockAge: null,
    lockedAtDepletion: 0,
    nextUnlockAfterDepletion: null,
    timeline: [],
    history: [],
    accumulation: [],
    ...overrides,
  }
}

describe("bridgeFinding", () => {
  it("passes a scenario that funds every year", () => {
    const finding = bridgeFinding(bridgeResult({ retirementAge: 59, accessibleAtRetirement: 100 }), 100)
    expect(finding.level).toBe("ok")
  })

  it("fails a scenario that runs dry before its locked money unlocks", () => {
    const finding = bridgeFinding(
      bridgeResult({ retirementAge: 52, accessibleAtRetirement: 200, lockedAtRetirement: 1000, depletionAge: 54, nextUnlockAge: 59, lockedAtDepletion: 1000, nextUnlockAfterDepletion: 59 }),
      100,
    )
    expect(finding.level).toBe("fail")
    expect(finding.title).toContain("5 yrs before the next")
    expect(finding.title).toContain("unlocks at age 59")
  })

  it("warns, rather than failing, when everything has already unlocked", () => {
    const finding = bridgeFinding(bridgeResult({ retirementAge: 59, accessibleAtRetirement: 1000, depletionAge: 80 }), 100)
    expect(finding.level).toBe("warn")
  })
})

function monteCarloSummary(overrides: Partial<MonteCarloSummary> = {}): MonteCarloSummary {
  return {
    successRate: 1,
    percentileBands: [],
    depletionHistogram: [],
    depletionProbabilityByYear: [],
    medianEndingBalance: 0,
    medianTotalWithdrawn: 0,
    medianDepletionYear: null,
    earliestDepletionYear: null,
    latestDepletionYear: null,
    worstRunPath: [],
    simulationCount: 5000,
    horizonYears: 30,
    ...overrides,
  }
}

describe("monteCarloFinding", () => {
  it("passes a scenario where every simulated run funds the plan", () => {
    const finding = monteCarloFinding(monteCarloSummary({ successRate: 1 }), 60, 65, 90)
    expect(finding.level).toBe("ok")
    expect(finding.title).toContain("every simulated run funds the plan through age 90")
  })

  it("still passes, but with the percentage stated, comfortably above the 90% line", () => {
    const finding = monteCarloFinding(monteCarloSummary({ successRate: 0.95 }), 60, 65, 90)
    expect(finding.level).toBe("ok")
    expect(finding.title).toContain("95%")
  })

  it("warns between 50% and 90% success", () => {
    const finding = monteCarloFinding(monteCarloSummary({ successRate: 0.7 }), 60, 65, 90)
    expect(finding.level).toBe("warn")
    expect(finding.title).toContain("70%")
  })

  it("fails below 50% success, and states the median depletion age", () => {
    const finding = monteCarloFinding(monteCarloSummary({ successRate: 0.3, medianDepletionYear: 12 }), 60, 65, 90)
    expect(finding.level).toBe("fail")
    expect(finding.detail.join(" ")).toContain("around age 72")
  })

  it("always states the median ending balance", () => {
    const finding = monteCarloFinding(monteCarloSummary({ successRate: 1, medianEndingBalance: 123456 }), 60, 65, 90)
    expect(finding.detail.join(" ")).toContain("$1,234.56")
  })
})

describe("toBridgeAccounts", () => {
  it("keeps portfolio accounts only and applies Rule of 55 to the access age", () => {
    const accounts = [
      account({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, ruleOf55SeparationAge: 55, taxTreatment: "tax-deferred", allocationPreset: "equity-80" }),
      account({ id: "a2", category: "debt" }),
    ]
    const built = toBridgeAccounts(accounts, new Map([["a1", 500]]), new Map([["a1", 1200]]), 60)
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ id: "a1", balance: 500, accessAge: 55, annualContribution: 1200, withdrawalTaxRate: 0.22 })
  })

  it("treats a missing balance or contribution as zero and a missing preset as no growth", () => {
    const accounts = [account({ id: "a1", category: "investment-taxable" })]
    const built = toBridgeAccounts(accounts, new Map(), new Map(), 65)
    expect(built[0]).toMatchObject({ balance: 0, annualContribution: 0, returnMean: 0 })
  })

  it("uses the account's own customReturnMean, overriding its preset's own default", () => {
    const accounts = [account({ id: "a1", category: "investment-taxable", allocationPreset: "equity-100", customReturnMean: 0.055 })]
    const built = toBridgeAccounts(accounts, new Map(), new Map(), 65)
    expect(built[0]).toMatchObject({ returnMean: 0.055 })
  })

  it("uses the account's own customWithdrawalTaxRate over the type-wide default", () => {
    const accounts = [account({ id: "a1", category: "retirement-tax-deferred", taxTreatment: "tax-deferred", customWithdrawalTaxRate: 0.3 })]
    const built = toBridgeAccounts(accounts, new Map(), new Map(), 65)
    expect(built[0]).toMatchObject({ withdrawalTaxRate: 0.3 })
  })

  it("splits a roth-ira with a basis into an always-accessible and a locked entry", () => {
    const accounts = [
      account({ id: "a1", name: "Roth", category: "retirement-roth", type: "roth-ira", accessAge: 59, allocationPreset: "equity-80", rothBasis: 300 }),
    ]
    const built = toBridgeAccounts(accounts, new Map([["a1", 1000]]), new Map([["a1", 120]]), 65)
    expect(built).toHaveLength(2)
    const basis = built.find((b) => b.id === "a1-basis")
    const growth = built.find((b) => b.id === "a1-growth")
    expect(basis).toMatchObject({ name: "Roth (basis)", balance: 300, accessAge: null, annualContribution: 120 })
    expect(growth).toMatchObject({ name: "Roth (growth)", balance: 700, accessAge: 59, annualContribution: 0 })
  })

  it("clamps a roth-ira's basis portion to the live balance when the market has dropped below it", () => {
    const accounts = [account({ id: "a1", category: "retirement-roth", type: "roth-ira", accessAge: 59, allocationPreset: "equity-80", rothBasis: 1000 })]
    const built = toBridgeAccounts(accounts, new Map([["a1", 400]]), new Map(), 65)
    expect(built.find((b) => b.id === "a1-basis")).toMatchObject({ balance: 400 })
    expect(built.find((b) => b.id === "a1-growth")).toMatchObject({ balance: 0 })
  })

  it("keeps the growth portion's normal access age (roth-ira is never Rule of 55 eligible)", () => {
    const accounts = [account({ id: "a1", category: "retirement-roth", type: "roth-ira", accessAge: 59, allocationPreset: "equity-80", rothBasis: 100 })]
    const built = toBridgeAccounts(accounts, new Map([["a1", 500]]), new Map(), 65)
    expect(built.find((b) => b.id === "a1-growth")).toMatchObject({ accessAge: 59 })
  })

  it("grants full access and carries the normal accessAge as the penalty cutoff when the penalty option is accepted", () => {
    const accounts = [account({ id: "a1", category: "retirement-tax-deferred", type: "traditional-401k", accessAge: 59, taxTreatment: "tax-deferred", allocationPreset: "equity-80", earlyWithdrawalPenalty: true })]
    const built = toBridgeAccounts(accounts, new Map([["a1", 500]]), new Map(), 65)
    expect(built[0]).toMatchObject({ accessAge: null, earlyWithdrawalPenaltyUntilAge: 59 })
  })

  it("leaves earlyWithdrawalPenaltyUntilAge null for an account with no accessAge to shorten", () => {
    const accounts = [account({ id: "a1", category: "investment-taxable", type: "brokerage", accessAge: null, taxTreatment: "taxable", allocationPreset: "equity-80", earlyWithdrawalPenalty: true })]
    const built = toBridgeAccounts(accounts, new Map([["a1", 500]]), new Map(), 65)
    expect(built[0]).toMatchObject({ accessAge: null, earlyWithdrawalPenaltyUntilAge: null })
  })

  it("applies the penalty cutoff to a roth-ira's growth entry only, never its already-free basis entry", () => {
    const accounts = [
      account({ id: "a1", name: "Roth", category: "retirement-roth", type: "roth-ira", accessAge: 59, allocationPreset: "equity-80", rothBasis: 300, earlyWithdrawalPenalty: true }),
    ]
    const built = toBridgeAccounts(accounts, new Map([["a1", 1000]]), new Map(), 65)
    expect(built.find((b) => b.id === "a1-basis")).toMatchObject({ accessAge: null, earlyWithdrawalPenaltyUntilAge: null })
    expect(built.find((b) => b.id === "a1-growth")).toMatchObject({ accessAge: null, earlyWithdrawalPenaltyUntilAge: 59 })
  })

  it("does not split a roth-ira with no basis entered, or any other account type", () => {
    const noBasis = toBridgeAccounts([account({ id: "a1", category: "retirement-roth", type: "roth-ira", allocationPreset: "equity-80" })], new Map(), new Map(), 65)
    expect(noBasis).toHaveLength(1)
    expect(noBasis[0]?.id).toBe("a1")

    const traditional = toBridgeAccounts(
      [account({ id: "a1", category: "retirement-tax-deferred", type: "traditional-ira", allocationPreset: "equity-80", rothBasis: 300 })],
      new Map(),
      new Map(),
      65,
    )
    expect(traditional).toHaveLength(1)
  })
})

describe("calculateMortgagePayoff", () => {
  it("computes months remaining and a payoff date for a standard amortizing loan", () => {
    const result = calculateMortgagePayoff({ interestRate: 0.06, monthlyPayment: 200000, balanceAsOfDate: "2026-01-01", balanceAsOf: 30000000 })
    expect(result).toEqual({ monthsRemaining: 278, payoffDate: "2049-03-01" })
  })

  it("errors instead of returning a payoff date when the payment doesn't cover the interest", () => {
    // $300,000 at 6% accrues $1,500/mo in interest -- a $1,000/mo payment can never catch up.
    const result = calculateMortgagePayoff({ interestRate: 0.06, monthlyPayment: 100000, balanceAsOfDate: "2026-01-01", balanceAsOf: 30000000 })
    expect("error" in result && result.error).toContain("doesn't cover the interest")
  })

  it("handles a zero-interest loan as simple division", () => {
    const result = calculateMortgagePayoff({ interestRate: 0, monthlyPayment: 50000, balanceAsOfDate: "2026-01-01", balanceAsOf: 500000 })
    expect(result).toEqual({ monthsRemaining: 10, payoffDate: "2026-11-01" })
  })

  it("treats an already-paid-off balance as zero months remaining", () => {
    const result = calculateMortgagePayoff({ interestRate: 0.06, monthlyPayment: 200000, balanceAsOfDate: "2026-01-01", balanceAsOf: 0 })
    expect(result).toEqual({ monthsRemaining: 0, payoffDate: "2026-01-01" })
  })
})
