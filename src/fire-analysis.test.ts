import { describe, expect, it } from "vitest"

import { bridgeFinding, calculateMortgagePayoff, detectCrossoverMismatch, detectPotDrift, simulateBridge, toBridgeAccounts } from "./fire-analysis.ts"
import type { BridgeAccount } from "./fire-analysis.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import type { MonteCarloCardMeta } from "./fire-dashboard.ts"

// Function to build a bridge account with inert defaults -- no growth, no contributions, no tax --
// so each test only has to state the one dimension it is actually exercising.
function bridgeAccount(overrides: Partial<BridgeAccount> & Pick<BridgeAccount, "id" | "balance">): BridgeAccount {
  return {
    name: "Some Account",
    accessAge: null,
    annualContribution: 0,
    returnMean: 0,
    withdrawalTaxRate: 0,
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

  it("grosses withdrawals up for tax, shortening the runway", () => {
    const result = simulateBridge([bridgeAccount({ id: "a1", balance: 1000, withdrawalTaxRate: 0.5 })], 50, 50, 100, 100, 0)
    // Funding 100 net costs 200 gross, so 1000 lasts five years rather than ten.
    expect(result.depletionAge).toBe(55)
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

describe("bridgeFinding", () => {
  it("passes a scenario that funds every year", () => {
    const finding = bridgeFinding({ retirementAge: 59, accessibleAtRetirement: 100, lockedAtRetirement: 0, depletionAge: null, nextUnlockAge: null, lockedAtDepletion: 0, nextUnlockAfterDepletion: null }, 100)
    expect(finding.level).toBe("ok")
  })

  it("fails a scenario that runs dry before its locked money unlocks", () => {
    const finding = bridgeFinding({ retirementAge: 52, accessibleAtRetirement: 200, lockedAtRetirement: 1000, depletionAge: 54, nextUnlockAge: 59, lockedAtDepletion: 1000, nextUnlockAfterDepletion: 59 }, 100)
    expect(finding.level).toBe("fail")
    expect(finding.title).toContain("5 yrs before the next")
    expect(finding.title).toContain("unlocks at 59")
  })

  it("warns, rather than failing, when everything has already unlocked", () => {
    const finding = bridgeFinding({ retirementAge: 59, accessibleAtRetirement: 1000, lockedAtRetirement: 0, depletionAge: 80, nextUnlockAge: null, lockedAtDepletion: 0, nextUnlockAfterDepletion: null }, 100)
    expect(finding.level).toBe("warn")
  })
})

describe("toBridgeAccounts", () => {
  it("keeps portfolio accounts only and applies Rule of 55 to the access age", () => {
    const accounts = [
      account({ id: "a1", category: "retirement-tax-deferred", accessAge: 59, ruleOf55SeparationAge: 55, taxTreatment: "tax-deferred", allocationPreset: "equity-80" }),
      account({ id: "a2", category: "debt" }),
    ]
    const built = toBridgeAccounts(accounts, new Map([["a1", 500]]), new Map([["a1", 1200]]))
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ id: "a1", balance: 500, accessAge: 55, annualContribution: 1200, withdrawalTaxRate: 0.22 })
  })

  it("treats a missing balance or contribution as zero and a missing preset as no growth", () => {
    const accounts = [account({ id: "a1", category: "investment-taxable" })]
    const built = toBridgeAccounts(accounts, new Map(), new Map())
    expect(built[0]).toMatchObject({ balance: 0, annualContribution: 0, returnMean: 0 })
  })
})

describe("detectPotDrift", () => {
  const workday = account({ id: "a1", name: "Workday 401k", category: "retirement-tax-deferred", accessAge: 59, ruleOf55SeparationAge: 55 })

  function meta(pots: { accountId: string; accessAge: number | null }[]): MonteCarloCardMeta {
    return { pots: pots.map((pot) => ({ id: pot.accountId, accountId: pot.accountId, accessAge: pot.accessAge })) }
  }

  it("flags a pot whose access age predates a config change", () => {
    const findings = detectPotDrift([meta([{ accountId: "a1", accessAge: 59 }])], [workday])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.level).toBe("warn")
    expect(findings[0]?.title).toContain("dashboard has access age 59, config would generate 55")
  })

  it("stays quiet when the dashboard already matches the config", () => {
    expect(detectPotDrift([meta([{ accountId: "a1", accessAge: 55 }])], [workday])).toEqual([])
  })

  it("flags a portfolio account with no pot at all", () => {
    const findings = detectPotDrift([meta([])], [workday])
    expect(findings[0]?.title).toContain("has no pot in the dashboard")
  })

  it("flags a pot whose account is no longer part of the portfolio", () => {
    const cash = account({ id: "a2", name: "Checking", category: "cash" })
    const findings = detectPotDrift([meta([{ accountId: "a2", accessAge: null }])], [cash])
    expect(findings[0]?.level).toBe("info")
    expect(findings[0]?.title).toContain("no longer a portfolio account")
  })

  it("reports one finding per account even when every scenario's widget repeats the pot", () => {
    const metas = [meta([{ accountId: "a1", accessAge: 59 }]), meta([{ accountId: "a1", accessAge: 59 }]), meta([{ accountId: "a1", accessAge: 59 }])]
    expect(detectPotDrift(metas, [workday])).toHaveLength(1)
  })

  it("ignores pots with no linked account", () => {
    const orphan: MonteCarloCardMeta = { pots: [{ id: "p1", accountId: null, accessAge: 59 }] }
    expect(detectPotDrift([orphan], [])).toEqual([])
  })
})

describe("detectCrossoverMismatch", () => {
  const portfolio = account({ id: "a1", name: "Brokerage", category: "investment-taxable" })
  const cash = account({ id: "a2", name: "Checking", category: "cash" })

  function crossover(incomeAccountIds: string[]) {
    return { expenseCategoryIds: [], incomeAccountIds, safeWithdrawalRate: 0.04, estimatedReturn: null, expectedContribution: null, projectionType: "hampel" as const, expenseAdjustmentFactor: 1 }
  }

  it("stays quiet when both sides hold the same accounts", () => {
    expect(detectCrossoverMismatch([crossover(["a1"])], [portfolio, cash])).toEqual([])
  })

  it("flags an account the crossover counts but the simulation does not model", () => {
    const findings = detectCrossoverMismatch([crossover(["a1", "a2"])], [portfolio, cash])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.title).toContain("Checking is counted by the crossover but is not in the simulation")
  })

  it("flags a simulated account the crossover leaves out", () => {
    const findings = detectCrossoverMismatch([crossover([])], [portfolio])
    expect(findings[0]?.title).toContain("Brokerage is in the simulation but the crossover does not count it")
  })

  it("says nothing when there is no crossover widget to compare against", () => {
    expect(detectCrossoverMismatch([], [portfolio])).toEqual([])
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
