import { describe, expect, it } from "vitest"

import {
  allocateWithdrawal,
  bridgeFinding,
  calculateMortgagePayoff,
  magiFinding,
  monteCarloFinding,
  simulateBridge,
  toBridgeAccounts,
} from "./fire-analysis.ts"
import type { BridgeAccount, BridgeResult } from "./fire-analysis.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import type { RetirementIncomeStream } from "./fire-dashboard.ts"
import type { MonteCarloSummary } from "./fire-monte-carlo.ts"
import type { FederalTaxBrackets } from "./federal-tax-brackets.ts"
import { federalPovertyGuideline } from "./federal-poverty-guidelines.ts"
import type { FederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"

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
    withdrawalOrder: null,
    isTaxDeferred: false,
    taxTreatment: "none",
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
    // toMatchObject, not toEqual -- this spot-checks the aggregate balance/depletion-timing shape
    // specifically; balancesByAccountId/withdrawalsByAccountId etc. have their own dedicated tests
    // below rather than needing every BridgeYear field enumerated here too.
    expect(result.timeline).toMatchObject([
      { age: 50, accessibleBalance: 1000, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 51, accessibleBalance: 900, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 52, accessibleBalance: 800, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 53, accessibleBalance: 700, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 54, accessibleBalance: 600, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 55, accessibleBalance: 500, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 56, accessibleBalance: 400, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 57, accessibleBalance: 300, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 58, accessibleBalance: 200, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      { age: 59, accessibleBalance: 100, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 },
      // The depletion year itself never reaches the allocation, so grossTaxDeferredWithdrawal stays
      // unset here -- there's no real withdrawal to report for a year that didn't actually fund.
      { age: 60, accessibleBalance: 0, lockedBalance: 0, projectedSpend: 100 },
    ])
    // The first point is exactly the retirement-age split, and the last is the depletion age --
    // the same two facts BridgeResult's own summary fields already assert, restated here as the
    // shape the chart actually draws from.
    expect(result.timeline[0]).toMatchObject({
      age: result.retirementAge,
      accessibleBalance: result.accessibleAtRetirement,
      lockedBalance: result.lockedAtRetirement,
      projectedSpend: 100,
      grossTaxDeferredWithdrawal: 0,
    })
    expect(result.timeline.at(-1)?.age).toBe(result.depletionAge)
  })

  it("records each account's own balance and that year's withdrawal from it, alongside the aggregate split", () => {
    const accounts = [
      bridgeAccount({ id: "cash", balance: 300, isTaxDeferred: false, withdrawalOrder: 0 }),
      bridgeAccount({ id: "401k", balance: 1000, isTaxDeferred: true, withdrawalOrder: 1 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 52, 100, 0)
    const byAge = new Map(result.timeline.map((year) => [year.age, year]))
    // Age 50: cash alone (300) covers the year's 100 need -- fully non-tax-deferred.
    expect(byAge.get(50)?.balancesByAccountId).toEqual({ cash: 300, "401k": 1000 })
    expect(byAge.get(50)?.withdrawalsByAccountId).toEqual({ cash: 100, "401k": 0 })
    expect(byAge.get(50)?.grossTaxDeferredWithdrawal).toBe(0)
    expect(byAge.get(50)?.grossNonTaxDeferredWithdrawal).toBe(100)
    // Age 51: cash has 200 left, still covers the year alone.
    expect(byAge.get(51)?.balancesByAccountId).toEqual({ cash: 200, "401k": 1000 })
    // Age 52 (the final planToAge point): an ending-balance snapshot only -- no withdrawal was
    // ever computed for it, so withdrawalsByAccountId/grossTaxDeferredWithdrawal stay unset, same
    // as the depletion-year case above.
    expect(byAge.get(52)?.balancesByAccountId).toEqual({ cash: 100, "401k": 1000 })
    expect(byAge.get(52)?.withdrawalsByAccountId).toBeUndefined()
  })

  // annualSpend: 0 in every test below isolates the Roth-conversion mechanism (issue #29's ACA
  // subsidy floor) from the ordinary withdrawal tiering already covered above -- with nothing to
  // withdraw, grossTaxDeferredWithdrawal stays 0 and rothConversionAmountAt's own return value is
  // the only thing moving any balance.
  it("converts from a tax-deferred account to a Roth one when rothConversionAmountAt asks for it", () => {
    const accounts = [
      bridgeAccount({ id: "trad", balance: 100000, isTaxDeferred: true, taxTreatment: "tax-deferred" }),
      bridgeAccount({ id: "roth", balance: 5000, isTaxDeferred: false, taxTreatment: "tax-free" }),
    ]
    const result = simulateBridge(accounts, 50, 50, 52, 0, 0, [], undefined, () => 20000)
    expect(result.timeline[0]?.rothConversionAmount).toBe(20000)
    // Start-of-year snapshot, same timing as accessibleBalance/lockedBalance -- before the
    // conversion actually moves anything.
    expect(result.timeline[0]?.balancesByAccountId).toEqual({ trad: 100000, roth: 5000 })
    // trad: 100000 - 20000 converted; roth: 5000 + 20000 received.
    expect(result.timeline[1]?.balancesByAccountId).toEqual({ trad: 80000, roth: 25000 })
  })

  it("clamps the conversion to whatever tax-deferred balance is actually reachable", () => {
    const accounts = [
      bridgeAccount({ id: "trad", balance: 100, isTaxDeferred: true, taxTreatment: "tax-deferred" }),
      bridgeAccount({ id: "roth", balance: 0, isTaxDeferred: false, taxTreatment: "tax-free" }),
    ]
    const result = simulateBridge(accounts, 50, 50, 51, 0, 0, [], undefined, () => 1000)
    expect(result.timeline[0]?.rothConversionAmount).toBe(100)
  })

  it("does nothing when there's no Roth account anywhere in the portfolio to convert into", () => {
    const accounts = [bridgeAccount({ id: "trad", balance: 100000, isTaxDeferred: true, taxTreatment: "tax-deferred" })]
    const result = simulateBridge(accounts, 50, 50, 51, 0, 0, [], undefined, () => 20000)
    expect(result.timeline[0]?.rothConversionAmount).toBeUndefined()
  })

  it("never converts from a still-locked tax-deferred account, the same as an ordinary withdrawal wouldn't", () => {
    const accounts = [
      bridgeAccount({ id: "trad", balance: 100000, isTaxDeferred: true, taxTreatment: "tax-deferred", accessAge: 90 }),
      // A real (nonzero) reachable balance -- otherwise the reachable pool is $0 and the year
      // depletes immediately (see simulateBridge's own reachableTotal check), before ever reaching
      // the conversion logic this test means to exercise at all.
      bridgeAccount({ id: "roth", balance: 50, isTaxDeferred: false, taxTreatment: "tax-free" }),
    ]
    const result = simulateBridge(accounts, 50, 50, 51, 0, 0, [], undefined, () => 20000)
    expect(result.timeline[0]?.rothConversionAmount).toBeUndefined()
  })

  it("still converts INTO a Roth account that's itself locked for withdrawal -- receiving isn't a withdrawal", () => {
    const accounts = [
      bridgeAccount({ id: "trad", balance: 100000, isTaxDeferred: true, taxTreatment: "tax-deferred" }),
      bridgeAccount({ id: "roth", balance: 0, isTaxDeferred: false, taxTreatment: "tax-free", accessAge: 90 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 52, 0, 0, [], undefined, () => 20000)
    expect(result.timeline[0]?.rothConversionAmount).toBe(20000)
    expect(result.timeline[1]?.balancesByAccountId?.roth).toBe(20000)
  })

  it("exposes a slim per-account projection on the result, in the same order as the accounts passed in", () => {
    const accounts = [
      bridgeAccount({ id: "cash", name: "Brokerage", balance: 100, isTaxDeferred: false, taxTreatment: "taxable", accessAge: null }),
      bridgeAccount({ id: "401k", name: "401k", balance: 100, isTaxDeferred: true, taxTreatment: "tax-deferred", accessAge: 59 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 51, 10, 0)
    expect(result.accounts).toEqual([
      { id: "cash", name: "Brokerage", isTaxDeferred: false, taxTreatment: "taxable", accessAge: null },
      { id: "401k", name: "401k", isTaxDeferred: true, taxTreatment: "tax-deferred", accessAge: 59 },
    ])
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
    expect(byAge.get(52)).toMatchObject({ age: 52, accessibleBalance: 300, lockedBalance: 500, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 })
    // The unlock year itself: the whole 500 has moved over, before that year's own withdrawal.
    expect(byAge.get(53)).toMatchObject({ age: 53, accessibleBalance: 700, lockedBalance: 0, projectedSpend: 100, grossTaxDeferredWithdrawal: 0 })
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

  it("drains pots strictly in withdrawalOrder once any account has one set, instead of proportionally", () => {
    const accounts = [
      bridgeAccount({ id: "cheap", balance: 200, withdrawalOrder: 0 }),
      bridgeAccount({ id: "expensive", balance: 10000, withdrawalTaxRate: 0.5, withdrawalOrder: 1 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 53, 100, 0)
    // Ages 50-51: the tax-free "cheap" pot alone funds the full 100/yr net need, no tax owed --
    // spent down 200 -> 100 -> 0, "expensive" untouched. Age 52 onward: "cheap" is empty, so
    // "expensive" starts paying, now owing its own 50% tax (100 net costs 200 gross).
    expect(result.timeline.map((point) => point.accessibleBalance)).toEqual([10200, 10100, 10000, 9800])
  })

  it("sorts an unset withdrawalOrder after every explicitly ordered pot, once any pot has one", () => {
    const accounts = [
      // Listed first, and far larger, but with no order set -- must still be drained LAST.
      bridgeAccount({ id: "unordered", balance: 10000 }),
      bridgeAccount({ id: "ordered", balance: 200, withdrawalOrder: 0 }),
    ]
    const result = simulateBridge(accounts, 50, 50, 53, 100, 0)
    // Same shape as the explicit-order test above -- "ordered" (200) funds ages 50-51 alone, then
    // "unordered" (10000) takes over from age 52.
    expect(result.timeline.map((point) => point.accessibleBalance)).toEqual([10200, 10100, 10000, 9900])
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

  it("caps the tax-deferred draw at taxDeferredWithdrawalCapAt, once non-taxable alone can't cover the need", () => {
    const accounts = [
      bridgeAccount({ id: "cash", balance: 30, isTaxDeferred: false }),
      bridgeAccount({ id: "401k", balance: 1_000_000, withdrawalTaxRate: 0.5, isTaxDeferred: true }),
    ]
    const capped = simulateBridge(accounts, 50, 50, 51, 100, 0, [], () => 40)
    // Age 50: cash (30) covers 30 of the 100 net need, uncapped -- it never raises MAGI, so
    // there's no reason to hold any of it back. The remaining 70 net would ordinarily need 140
    // gross from the 50%-taxed 401k; capped at 40 gross (netting 20), the last 50 net comes from
    // the 401k again, past its own cap, as overflow (100 more gross). Combined balance drops by
    // 30 (cash) + 40 (capped tier) + 100 (overflow) = 170.
    expect(capped.timeline[1]?.accessibleBalance).toBe(1_000_030 - 170)
  })
})

describe("allocateWithdrawal", () => {
  it("never touches tax-deferred at all when non-taxable alone covers the need, regardless of the cap", () => {
    const accounts = [
      { balance: 1000, withdrawalTaxRate: 0, withdrawalOrder: null, isTaxDeferred: false },
      { balance: 1000, withdrawalTaxRate: 0.5, withdrawalOrder: null, isTaxDeferred: true },
    ]
    // The whole point of this design: non-taxable is drawn UNCAPPED, so a cap here (however
    // small) never forces an unnecessary tax-deferred draw the way the earlier reserve-pacing
    // design did.
    const allocation = allocateWithdrawal(accounts, 100, 40)
    expect(allocation.grossByIndex).toEqual([100, 0])
  })

  it("caps tax-deferred at taxDeferredCap once non-taxable alone can't cover the need", () => {
    const accounts = [
      { balance: 30, withdrawalTaxRate: 0, withdrawalOrder: null, isTaxDeferred: false },
      { balance: 1000, withdrawalTaxRate: 0.5, withdrawalOrder: null, isTaxDeferred: true },
    ]
    const allocation = allocateWithdrawal(accounts, 100, 40)
    // 30 from non-taxable (uncapped, all it has). The remaining 70 net would need 140 gross from
    // the 50%-taxed tax-deferred pot -- capped at 40 gross (netting 20) -- the last 50 net comes
    // from tax-deferred again, past its own cap, as overflow (100 more gross): 40 + 100 = 140.
    expect(allocation.grossByIndex).toEqual([30, 140])
  })

  it("doesn't cap tax-deferred when the real need-driven gross already stays under the cap", () => {
    const accounts = [
      { balance: 10, withdrawalTaxRate: 0, withdrawalOrder: null, isTaxDeferred: false },
      { balance: 1000, withdrawalTaxRate: 0.5, withdrawalOrder: null, isTaxDeferred: true },
    ]
    // 10 from non-taxable, remaining 90 net needs 180 gross -- well under a 1000 cap, so this
    // covers the real need normally rather than manufacturing a smaller, capped draw.
    const allocation = allocateWithdrawal(accounts, 100, 1000)
    expect(allocation.grossByIndex).toEqual([10, 180])
  })

  it("allocates proportionally across accounts when no order or cap is given (today's default)", () => {
    const accounts = [
      { balance: 300, withdrawalTaxRate: 0, withdrawalOrder: null, isTaxDeferred: false },
      { balance: 700, withdrawalTaxRate: 0, withdrawalOrder: null, isTaxDeferred: true },
    ]
    const allocation = allocateWithdrawal(accounts, 100)
    expect(allocation.grossByIndex).toEqual([30, 70])
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
    accounts: [],
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

// Same fixture/figures as estimateMagi's own "combines every ordinary-income source" test in
// federal-tax-brackets.test.ts, reused here rather than re-derived -- magiFinding is purely a
// formatting layer over that same function.
const MAGI_TABLE: FederalTaxBrackets = {
  taxYear: 2026,
  source: "https://example.com",
  standardDeduction: { single: 1610000, marriedFilingJointly: 3220000, headOfHousehold: 2415000 },
  brackets: {
    single: [
      { rate: 0.1, upTo: 1240000 },
      { rate: 0.12, upTo: 5040000 },
      { rate: 0.22, upTo: 10570000 },
      { rate: 0.24, upTo: 20177500 },
      { rate: 0.32, upTo: 25622500 },
      { rate: 0.35, upTo: 64060000 },
      { rate: 0.37, upTo: null },
    ],
    marriedFilingJointly: [{ rate: 0.1, upTo: null }],
    headOfHousehold: [{ rate: 0.1, upTo: null }],
  },
}

const POVERTY_TABLE: FederalPovertyGuidelines = {
  guidelineYear: 2025,
  source: "https://example.com",
  base: 1565000, // $15,650
  perAdditionalPerson: 550000, // $5,500
  subsidyCliffAt400Pct: true,
}

describe("magiFinding", () => {
  it("states MAGI, marginal/effective rate, and the withdrawal/pension/SS breakdown", () => {
    const finding = magiFinding(59, 0, 20000_00, 60000_00, 0, "single", MAGI_TABLE, null)
    expect(finding.level).toBe("info")
    // MAGI $77,000, marginal 22% (see estimateMagi's own equivalent test) -- 811000/7700000 = 10.5%.
    expect(finding.title).toBe("age 59 -- est. MAGI $77,000.00 puts you in the 22% federal bracket (10.5% effective).")
    expect(finding.detail[0]).toBe("$60,000.00 tax-deferred, $0.00 pension, $17,000.00 taxable Social Security -- taxable income $60,900.00 after the standard deduction.")
    expect(finding.detail[1]).toContain("not a line from Form 1040")
    expect(finding.detail).toHaveLength(2)
  })

  it("adds %FPL to the title when aca context is given", () => {
    // MAGI $77,000 / $21,150 (household of 2: $15,650 + $5,500) = 364.07% -> 364.1%.
    const finding = magiFinding(59, 0, 20000_00, 60000_00, 0, "single", MAGI_TABLE, { targetGuideline: federalPovertyGuideline(2, POVERTY_TABLE) })
    expect(finding.title).toBe("age 59 -- est. MAGI $77,000.00 (364.1% FPL) puts you in the 22% federal bracket (10.5% effective).")
    // The detail lines are unaffected by aca -- the cliff itself is a chart marker, not text here.
    expect(finding.detail).toHaveLength(2)
  })

  it("adds a detail line when a Roth conversion contributed to MAGI", () => {
    const finding = magiFinding(59, 0, 0, 40000_00, 20000_00, "single", MAGI_TABLE, null)
    expect(finding.detail).toContain("Includes a $20,000.00 Roth conversion to keep MAGI at the ACA subsidy floor.")
    expect(finding.detail).toHaveLength(3)
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
