import { addMonthsToDate, formatUsd } from "./actual-helpers.ts"
import { isPortfolioCategory } from "./fire-accounts.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { ALLOCATION_PRESET_RETURNS, EARLY_WITHDRAWAL_PENALTY_RATE, effectiveAccessAge, withdrawalTaxRateFor } from "./fire-dashboard.ts"
import type { RetirementIncomeStream } from "./fire-dashboard.ts"
import type { MonteCarloSummary } from "./fire-monte-carlo.ts"
import { estimateMagi } from "./federal-tax-brackets.ts"
import type { FederalTaxBrackets, FilingStatus } from "./federal-tax-brackets.ts"
import { federalPovertyGuideline } from "./federal-poverty-guidelines.ts"
import type { FederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"

export type FindingLevel = "fail" | "warn" | "info" | "ok"

export interface Finding {
  level: FindingLevel
  title: string
  detail: string[]
}

export interface MortgageDetails {
  // Decimal, e.g. 0.065 for 6.5% -- matches this repo's convention for rates everywhere else
  // (safeWithdrawalRate, ALLOCATION_PRESET_RETURNS, ...).
  interestRate: number
  monthlyPayment: number
  balanceAsOfDate: string
  balanceAsOf: number
  // Extra paid toward principal every month, on top of monthlyPayment. Entirely fungible with it
  // for this formula's purposes -- interest accrues on the declining balance regardless of which
  // "bucket" a dollar came from, so it's simply added to the payment below.
  extraMonthlyPrincipal?: number
}

export interface MortgagePayoff {
  monthsRemaining: number
  payoffDate: string
}

// Function to project a standard amortizing loan forward from its own stated balance/date (not
// Actual's ledger balance for the account -- a real mortgage servicer's payoff balance often isn't
// what a synced or manually-tracked Actual account reflects, so this is deliberately its own
// independent anchor point) to a payoff date, using the standard fixed-payment amortization
// formula. Returns an error, not a nonsensical date, when the payment doesn't even cover the
// interest accruing each month -- the balance would grow forever, not reach zero.
export function calculateMortgagePayoff(details: MortgageDetails): MortgagePayoff | { error: string } {
  const monthlyRate = details.interestRate / 12
  // Extra principal is just more cash applied to the same declining balance every month -- the
  // amortization math below has no notion of "scheduled" vs. "extra," so the two are summed once
  // here rather than threaded through separately.
  const payment = details.monthlyPayment + (details.extraMonthlyPrincipal ?? 0)
  if (details.balanceAsOf <= 0) {
    return { monthsRemaining: 0, payoffDate: details.balanceAsOfDate }
  }
  if (monthlyRate === 0) {
    if (payment <= 0) {
      return { error: "Monthly payment must be greater than zero." }
    }
    const monthsRemaining = Math.ceil(details.balanceAsOf / payment)
    return { monthsRemaining, payoffDate: addMonthsToDate(details.balanceAsOfDate, monthsRemaining) }
  }
  const monthlyInterest = details.balanceAsOf * monthlyRate
  if (payment <= monthlyInterest) {
    return { error: "Payment doesn't cover the interest accruing each month -- the balance would grow, not shrink." }
  }
  const monthsRemaining = Math.ceil(-Math.log(1 - (details.balanceAsOf * monthlyRate) / payment) / Math.log(1 + monthlyRate))
  return { monthsRemaining, payoffDate: addMonthsToDate(details.balanceAsOfDate, monthsRemaining) }
}

// One portfolio account reduced to just what the bridge projection needs. accessAge here is
// already Rule-of-55 adjusted (see effectiveAccessAge) -- this type deliberately has no notion of
// why an age is what it is.
export interface BridgeAccount {
  id: string
  name: string
  balance: number
  accessAge: number | null
  annualContribution: number
  returnMean: number
  withdrawalTaxRate: number
  // The account's own normal accessAge (pre-Rule-of-55, pre-early-withdrawal-penalty) -- when set,
  // a withdrawal from this account in a year before this age owes EARLY_WITHDRAWAL_PENALTY_RATE on
  // top of withdrawalTaxRate; from this age on, withdrawalTaxRate alone applies, same as if this
  // were never set. Null for an account that isn't using the early-withdrawal-penalty option (or
  // has no accessAge to begin with). See simulateBridge's own withdrawal-phase loop for where this
  // is actually applied, and fire-dashboard.ts's effectiveAccessAge for what grants the early
  // access this prices.
  earlyWithdrawalPenaltyUntilAge: number | null
  // Same field, same meaning, as ClassifiedAccount's own withdrawalOrder (see fire-accounts.ts) --
  // reused here rather than re-invented so setting an order once (in the account editor) governs
  // both Actual's own Monte Carlo widget AND this app's bridge/MAGI simulation, instead of the two
  // silently disagreeing about draw order. See allocateWithdrawal below for how this is applied.
  withdrawalOrder: number | null
}

// Function to split one year's net withdrawal need across a set of already-reachable (accessible)
// accounts -- shared by simulateBridge's own withdrawal-phase loop (which uses this to actually
// decrement balances) and fire-generate.ts's MAGI/ACA estimate (which uses this to work out how
// much of a hypothetical withdrawal would come from which account, without re-simulating a whole
// trajectory), so the two can never disagree about where a dollar came from the way they used to
// (accessibleTaxDeferredShare used to guess a tax-deferred SHARE of the accessible balance instead
// of asking this same allocation, which is exactly why enabling the early-withdrawal-penalty option
// on a large 401(k) could spike the MAGI estimate even with a smaller, untouched taxable/cash pot
// still sitting there -- simulateBridge itself drew from both proportionally, by balance, with no
// way to prefer one pot over another).
//
// Sequential (drain pots strictly in withdrawalOrder, ascending, with any unset order sorting last)
// the moment ANY given account carries a withdrawalOrder -- otherwise proportional, today's
// long-standing default (each pot contributes its balance-weighted share), so a plan that's never
// touched the withdrawal-order UI keeps behaving exactly as it always has.
export interface WithdrawalAllocation {
  // Parallel to the accounts array passed in -- how much GROSS money (before its own tax rate) came
  // out of each account this year.
  grossByIndex: number[]
  // Total NET money these accounts could produce if fully drained -- the same figure regardless of
  // allocation order (it only depends on which accounts are reachable and their own balance/rate),
  // so this is what the caller compares the year's net need against to detect depletion.
  totalNetCapacity: number
}
export function allocateWithdrawal(
  accounts: readonly { balance: number; withdrawalTaxRate: number; withdrawalOrder: number | null }[],
  netNeed: number,
): WithdrawalAllocation {
  const totalNetCapacity = accounts.reduce((total, account) => total + account.balance * (1 - account.withdrawalTaxRate), 0)
  if (accounts.some((account) => account.withdrawalOrder != null)) {
    const order = accounts.map((account, index) => ({ account, index })).sort((a, b) => (a.account.withdrawalOrder ?? Infinity) - (b.account.withdrawalOrder ?? Infinity))
    const grossByIndex: number[] = accounts.map(() => 0)
    let remaining = netNeed
    for (const { account, index } of order) {
      if (remaining <= 0) break
      const capacity = account.balance * (1 - account.withdrawalTaxRate)
      if (capacity <= remaining) {
        // Drain this pot completely and move to the next one in order.
        grossByIndex[index] = account.balance
        remaining -= capacity
      } else {
        // This pot alone covers what's left -- withdraw exactly enough gross to net it, then stop.
        grossByIndex[index] = account.withdrawalTaxRate < 1 ? remaining / (1 - account.withdrawalTaxRate) : account.balance
        remaining = 0
      }
    }
    return { grossByIndex, totalNetCapacity }
  }
  const total = accounts.reduce((sum, account) => sum + account.balance, 0)
  const netPerGross = total > 0 ? accounts.reduce((sum, account) => sum + (account.balance / total) * (1 - account.withdrawalTaxRate), 0) : 0
  const gross = netPerGross > 0 ? netNeed / netPerGross : 0
  const grossByIndex = accounts.map((account) => (total > 0 ? gross * (account.balance / total) : 0))
  return { grossByIndex, totalNetCapacity }
}

// Function to resolve one account's ACTUAL withdrawal tax rate for a specific age -- its flat
// withdrawalTaxRate, plus EARLY_WITHDRAWAL_PENALTY_RATE on top for any age before
// earlyWithdrawalPenaltyUntilAge (unset for an account not using that option, in which case this
// is just withdrawalTaxRate itself, every year). Age-dependent, so this can't be baked into
// BridgeAccount as a single number the way withdrawalTaxRate itself is -- resolved fresh each year
// inside simulateBridge's own withdrawal-phase loop, and again by fire-generate.ts's MAGI/ACA
// estimate (see allocateWithdrawal above), which needs the SAME per-account rate at a given age to
// stay consistent with what simulateBridge itself would actually do.
export function withdrawalTaxRateAt(account: BridgeAccount, age: number): number {
  const penalty = account.earlyWithdrawalPenaltyUntilAge != null && age < account.earlyWithdrawalPenaltyUntilAge ? EARLY_WITHDRAWAL_PENALTY_RATE : 0
  return account.withdrawalTaxRate + penalty
}

// Balances are whole cents, but the proportional split across pots is floating-point, so a year's
// funding check can land a hair under its target purely from rounding. Treat anything within a
// cent as funded -- without this, a scenario reports depleting a year earlier than it does.
const FUNDING_TOLERANCE_CENTS = 1

export interface BridgeResult {
  retirementAge: number
  accessibleAtRetirement: number
  lockedAtRetirement: number
  // The age at which the accessible pool can no longer fund a full year of spending, or null if it
  // funds every year through planToAge.
  depletionAge: number | null
  // The earliest age at which any money locked at retirement becomes available, or null if nothing
  // is locked. This is the first tranche, not necessarily all of it.
  nextUnlockAge: number | null
  // How much was still locked at the moment the reachable pool ran dry, and when the next tranche
  // of it would have opened. Access ages come in tiers (Rule of 55 at 55, everything else at 59),
  // so surviving past the *first* unlock proves nothing -- these two are what separate a real
  // bridging gap from having simply outspent a fully-unlocked portfolio.
  lockedAtDepletion: number
  nextUnlockAfterDepletion: number | null
  // One point per simulated year from retirementAge onward, for charting the burndown -- not a
  // reinterpretation of the simulation, just what it already computes at each step, exposed.
  // Ends at depletionAge (whatever is left the moment it can't cover a full year) when the
  // scenario depletes, or at planToAge when it doesn't; never continues past either. accessible +
  // locked at the first point always equals accessibleAtRetirement + lockedAtRetirement above.
  timeline: BridgeYear[]
  // Real (not simulated) accessible/locked balances for up to a few years before currentAge --
  // see historicalBridgeYear below. A separate array, not a prefix spliced onto timeline, because
  // it's real history, unlike accumulation right below. Empty when the accounts don't have that
  // much transaction history to look back on. Its own last point and accumulation's own first
  // point always agree (both are just "today"), so a chart can join them into one line.
  history: BridgeYear[]
  // One point per year from currentAge through retirementAge (inclusive of both ends), tracking
  // the same accessible/locked split as history/timeline but PROJECTED forward -- contributions
  // and mean growth, no withdrawals yet -- rather than read off real transactions. This is what
  // connects history's real "now" to timeline's own first point (retirementAge) instead of a gap:
  // the same reasoning as the rest of this file, that mean returns with no volatility is a
  // deliberately optimistic story worth showing, not a real forecast. Its last point always equals
  // timeline's own first one exactly (both are accessibleAtRetirement/lockedAtRetirement), so a
  // chart can join the two into one line the same way. A single point (nothing to connect) when
  // retirementAge equals currentAge.
  accumulation: BridgeYear[]
}

export interface BridgeYear {
  age: number
  accessibleBalance: number
  lockedBalance: number
  // The plan's own cost of living that age -- inflation applied, but income (pension/Social
  // Security/debt payoff) NOT netted out, so this reads as a stable, ever-growing expenses figure
  // rather than one that mysteriously drops the moment a pension starts (or, for an age before
  // currentAge, the same formula run backward -- what expenses were worth in this plan's terms back
  // then, not a claim about what was really spent). Income still reduces the portfolio withdrawal
  // that drives the balance line itself -- see simulateBridge's own netAnnualSpend -- this field
  // just isn't where that reduction shows up. Set on every point going forward from
  // simulateBridge/historicalBridgeYear alike; optional only because a caller that never passes
  // one (a test fixture, say) shouldn't be forced to fabricate a figure it doesn't have.
  projectedSpend?: number
}

// Function to split a one-shot snapshot of accounts (a historical balance as of some past age, or
// any other static balance figure) into accessible/locked totals -- the same accessAge rule
// simulateBridge's own internal splitAt applies to its year-by-year MUTATED balances, but usable
// here against toBridgeAccounts' plain, unchanging balance snapshot instead. projectedSpend is
// passed in rather than computed here (unlike simulateBridge's own inline version) since this
// function has no notion of annualSpend/inflationMean/incomeStreams of its own -- see this
// BridgeYear field's own doc comment for what the figure means for an age before currentAge.
export function historicalBridgeYear(accounts: readonly BridgeAccount[], age: number, projectedSpend?: number): BridgeYear {
  let accessibleBalance = 0
  let lockedBalance = 0
  for (const account of accounts) {
    if (account.accessAge == null || age >= account.accessAge) {
      accessibleBalance += account.balance
    } else {
      lockedBalance += account.balance
    }
  }
  return { age, accessibleBalance, lockedBalance, projectedSpend }
}

// Function to project one or more accounts' balances forward from currentAge to targetAge --
// contributions then mean growth, every year, no withdrawals -- the exact same per-year model
// simulateBridge's own accumulation phase applies, just for an arbitrary single age rather than a
// whole scenario's timeline. Used for a figure like a Rule of 55 boost's dollar amount: how much
// will actually be in this account by the age it unlocks, not what's in it today.
export function projectAccountBalance(accounts: readonly BridgeAccount[], currentAge: number, targetAge: number): number {
  return accounts.reduce((total, account) => {
    let value = account.balance
    for (let age = currentAge; age < targetAge; age++) {
      value = (value + account.annualContribution) * (1 + account.returnMean)
    }
    return total + value
  }, 0)
}

// Function to project a single retirement-age scenario forward at mean returns with no
// volatility, tracking only whether the *accessible* pool can fund each year -- the same
// accessible-only funding rule Actual's own Monte Carlo engine applies, minus the randomness.
// That makes this a best case: a scenario that depletes here depletes in essentially every
// simulated run, which is what makes it worth reporting without re-implementing the simulation.
export function simulateBridge(
  accounts: readonly BridgeAccount[],
  currentAge: number,
  retirementAge: number,
  planToAge: number,
  annualSpend: number,
  inflationMean: number,
  incomeStreams: readonly RetirementIncomeStream[] = [],
): BridgeResult {
  const balances = accounts.map((account) => account.balance)
  const isAccessible = (account: BridgeAccount, age: number): boolean => account.accessAge == null || age >= account.accessAge
  // Shared by the retirement-age split below and the timeline recording further down, so the two
  // never disagree about what "accessible at this age" means.
  const splitAt = (age: number): { accessible: number; locked: number } => {
    let accessible = 0
    let locked = 0
    accounts.forEach((account, index) => {
      if (isAccessible(account, age)) {
        accessible += balances[index] as number
      } else {
        locked += balances[index] as number
      }
    })
    return { accessible, locked }
  }
  const timeline: BridgeYear[] = []
  // See BridgeResult's own doc comment on this field -- one point per year of the accumulation
  // phase, ending on retirementAge itself so it shares that exact point with timeline's own first
  // one (both come from the same splitAt(retirementAge)).
  const accumulation: BridgeYear[] = []

  let accessibleAtRetirement = 0
  let lockedAtRetirement = 0
  let capturedSplit = false
  let depletionAge: number | null = null
  let lockedAtDepletion = 0
  let nextUnlockAfterDepletion: number | null = null

  const recordDepletion = (age: number): void => {
    depletionAge = age
    lockedAtDepletion = accounts.reduce(
      (total, account, index) => total + (isAccessible(account, age) ? 0 : (balances[index] as number)),
      0,
    )
    const pending = accounts.filter((account) => account.accessAge != null && account.accessAge > age).map((account) => account.accessAge as number)
    nextUnlockAfterDepletion = pending.length > 0 ? Math.min(...pending) : null
  }

  for (let age = currentAge; age < planToAge; age++) {
    // Pension/Social Security are entered as today's-dollars figures, same as annualSpend, so the
    // offset is netted out before inflating the result rather than after -- keeps guaranteed
    // income growing in step with spend under this same inflation assumption, rather than fixed in
    // nominal terms and shrinking in real value every year. Computed for every age, not just once
    // withdrawals start -- living expenses (and a stream that starts before retirement, like an
    // early debt payoff) are still real pre-retirement, just funded by a paycheck instead of the
    // portfolio. `spend` (net of income) is what actually drives the withdrawal below -- the
    // portfolio only needs to cover what income doesn't -- while `grossSpend` is the figure every
    // point recorded this iteration (the capturedSplit snapshot below included) carries as its own
    // projectedSpend (see BridgeYear's own doc comment for why that one stays gross).
    const incomeAtAge = incomeStreams.filter((stream) => stream.startAge <= age).reduce((sum, stream) => sum + stream.annualAmount, 0)
    const netAnnualSpend = Math.max(0, annualSpend - incomeAtAge)
    const inflationFactor = Math.pow(1 + inflationMean, age - currentAge)
    const spend = netAnnualSpend * inflationFactor
    const grossSpend = annualSpend * inflationFactor

    if (!capturedSplit && age >= retirementAge) {
      const split = splitAt(age)
      accessibleAtRetirement = split.accessible
      lockedAtRetirement = split.locked
      accumulation.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked, projectedSpend: grossSpend })
      capturedSplit = true
    }

    // Recorded every year of the withdrawal phase, not just at the moments the summary fields
    // above care about -- this is the actual line the chart draws.
    if (age >= retirementAge) {
      const split = splitAt(age)
      timeline.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked, projectedSpend: grossSpend })
    } else {
      const split = splitAt(age)
      accumulation.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked, projectedSpend: grossSpend })
    }

    if (age < retirementAge) {
      accounts.forEach((account, index) => {
        balances[index] = (balances[index] as number) + account.annualContribution
      })
    } else {
      const reachable = accounts.map((account, index) => index).filter((index) => isAccessible(accounts[index] as BridgeAccount, age))
      const reachableTotal = reachable.reduce((total, index) => total + (balances[index] as number), 0)
      if (reachableTotal <= FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      // See allocateWithdrawal's own doc comment -- proportional (today's long-standing default) or
      // sequential (drain pots in withdrawalOrder), depending on whether any reachable account has
      // an order set.
      const allocation = allocateWithdrawal(
        reachable.map((index) => {
          const account = accounts[index] as BridgeAccount
          return { balance: balances[index] as number, withdrawalTaxRate: withdrawalTaxRateAt(account, age), withdrawalOrder: account.withdrawalOrder }
        }),
        spend,
      )
      if (allocation.totalNetCapacity < spend - FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      reachable.forEach((index, position) => {
        balances[index] = (balances[index] as number) - (allocation.grossByIndex[position] as number)
      })
    }

    accounts.forEach((account, index) => {
      balances[index] = (balances[index] as number) * (1 + account.returnMean)
    })
  }

  const unlockAges = accounts
    .filter((account) => account.accessAge != null && account.accessAge > retirementAge)
    .map((account) => account.accessAge as number)

  // Only when the plan was funded through to the end -- a depleted scenario's timeline already
  // ends exactly where the simulation itself stopped, and extending it past that would be drawing
  // a year the simulation never actually ran.
  if (depletionAge === null) {
    const split = splitAt(planToAge)
    timeline.push({ age: planToAge, accessibleBalance: split.accessible, lockedBalance: split.locked })
  }

  return {
    retirementAge,
    accessibleAtRetirement,
    lockedAtRetirement,
    depletionAge,
    nextUnlockAge: unlockAges.length > 0 ? Math.min(...unlockAges) : null,
    lockedAtDepletion,
    nextUnlockAfterDepletion,
    timeline,
    accumulation,
    // Real transaction history isn't available in here (simulateBridge only ever sees a single
    // snapshot balance per account) -- the caller (checkDashboard) fills this in itself, the same
    // way it already attaches retirementAge-independent data like ruleOf55Boosts.
    history: [],
  }
}

// Function to turn a bridge projection into a reportable finding. A scenario that never depletes
// passes; one that depletes before its locked money unlocks is the real failure this whole
// analysis exists to catch; one that depletes after everything has already unlocked is a plain
// "you ran out", not a bridging problem.
export function bridgeFinding(result: BridgeResult, planToAge: number): Finding {
  const total = result.accessibleAtRetirement + result.lockedAtRetirement
  const share = total > 0 ? Math.round((result.accessibleAtRetirement / total) * 1000) / 10 : 0
  const split = [
    `${formatUsd(result.accessibleAtRetirement)} reachable at retirement (${share}%)` +
      (result.lockedAtRetirement > 0 && result.nextUnlockAge != null
        ? `, ${formatUsd(result.lockedAtRetirement)} locked (earliest unlock at age ${result.nextUnlockAge})`
        : ""),
  ]

  if (result.depletionAge === null) {
    return { level: "ok", title: `age ${result.retirementAge} -- funds every year until age ${planToAge}.`, detail: split }
  }
  if (result.nextUnlockAfterDepletion != null) {
    const gap = result.nextUnlockAfterDepletion - result.depletionAge
    return {
      level: "fail",
      title: `age ${result.retirementAge} -- reachable money runs out at age ${result.depletionAge}, ${gap} yr${gap === 1 ? "" : "s"} before the next ${formatUsd(result.lockedAtDepletion)} unlocks at age ${result.nextUnlockAfterDepletion}.`,
      detail: [...split, "This is already the best case -- mean returns, no volatility -- so simulations will also likely fail at this age."],
    }
  }
  return {
    level: "warn",
    title: `age ${result.retirementAge} -- runs out at age ${result.depletionAge}, short of age ${planToAge}.`,
    detail: [...split, "Everything has unlocked by then, so this is a shortfall, not a bridging problem."],
  }
}

// Function to turn one retirement age's estimated MAGI into prose, read alongside bridgeFinding's
// own funding-status finding for the same age (checkDashboard appends this right after it). Always
// "info" -- IRMAA thresholds aren't vendored, so this never passes or fails anything on its own,
// just states the estimate. `aca`, when given, adds this same point-in-time MAGI's own %FPL to the
// title -- NOT whether/when it crosses the 400% subsidy cliff, which is inherently a "when does
// this happen" fact across a scenario's whole trajectory, not a single point in time the way this
// finding is, so THAT lives as a chart marker instead (see acaCliffCrossings in fire-generate.ts and
// renderBridgeChart in app.js). grossTaxDeferredWithdrawal is the caller's own estimate (see
// checkDashboard in fire-generate.ts): the withdrawal need for the year, times whatever share of
// the ACCESSIBLE portfolio at this age is tax-deferred -- a 401(k) still locked behind its own
// accessAge contributes nothing, the same accessibility rule simulateBridge itself applies, so this
// doesn't overstate MAGI for the early-retirement/FIRE case this app is built around (tax-deferred
// money routinely still locked at the chosen retirement age). Not grossed up for the tax itself
// (that would be circular with the rate being estimated here) -- still an approximation, not an
// exact figure, and says so in its own detail text.
export function magiFinding(
  retirementAge: number,
  pensionIncome: number,
  socialSecurityBenefit: number,
  grossTaxDeferredWithdrawal: number,
  filingStatus: FilingStatus,
  table: FederalTaxBrackets,
  aca: { householdSize: number; guidelines: FederalPovertyGuidelines } | null,
): Finding {
  const estimate = estimateMagi({ grossTaxDeferredWithdrawal, rothConversionAmount: 0, pensionIncome, socialSecurityBenefit }, filingStatus, table)
  const marginalPct = Math.round(estimate.marginalRate * 1000) / 10
  const effectivePct = Math.round(estimate.effectiveRate * 1000) / 10
  const fplNote = aca ? ` (${Math.round((estimate.magi / federalPovertyGuideline(aca.householdSize, aca.guidelines)) * 1000) / 10}% FPL)` : ""
  return {
    level: "info",
    title: `age ${retirementAge} -- est. MAGI ${formatUsd(estimate.magi)}${fplNote} puts you in the ${marginalPct}% federal bracket (${effectivePct}% effective).`,
    detail: [
      `${formatUsd(grossTaxDeferredWithdrawal)} tax-deferred, ${formatUsd(pensionIncome)} pension, ${formatUsd(estimate.taxableSocialSecurity)} taxable Social Security -- taxable income ${formatUsd(estimate.taxableIncome)} after the standard deduction.`,
      "A rough estimate, not a line from Form 1040: excludes still-locked accounts, doesn't gross up for the tax itself.",
    ],
  }
}

// Function to turn one age's Monte Carlo result into prose, the same way bridgeFinding does for
// the bridge simulation -- read alongside the fan chart built from the same result, not a second
// computation of anything. 90%/50% success-rate bands are a common, defensible planning
// convention (comfortably funded / worth a second look), not a value this app derives from
// anything upstream -- reasonable thresholds, not a precise cutoff.
export function monteCarloFinding(result: MonteCarloSummary, currentAge: number, retirementAge: number, planToAge: number): Finding {
  const successPct = Math.round(result.successRate * 100)
  const detail = [`Median ending balance ${formatUsd(result.medianEndingBalance)}.`]
  if (result.successRate >= 1) {
    return { level: "ok", title: `age ${retirementAge} -- every simulated run funds the plan through age ${planToAge}.`, detail }
  }
  if (result.medianDepletionYear != null) {
    detail.push(`Depleted runs typically ran out around age ${currentAge + result.medianDepletionYear}.`)
  }
  const level: FindingLevel = result.successRate >= 0.9 ? "ok" : result.successRate >= 0.5 ? "warn" : "fail"
  return {
    level,
    title: `age ${retirementAge} -- ${successPct}% of ${result.simulationCount.toLocaleString()} simulated runs fund the plan through age ${planToAge}.`,
    detail,
  }
}

// Function to reduce one classified account to the fields simulateBridge cares about (shared by
// both the ordinary single-entry case and the Roth-basis split below, so the growth/return logic
// only lives in one place).
function bridgeReturnMean(account: ClassifiedAccount): number {
  // Same per-field override-over-preset-default resolution as fire-dashboard.ts's
  // returnAssumptionsFor, but never throws -- an account with no preset at all (never classified
  // into the portfolio with one) contributes 0 growth rather than failing the whole read-only
  // analysis.
  const presetDefaultMean = account.allocationPreset != null ? ALLOCATION_PRESET_RETURNS[account.allocationPreset].mean : null
  return account.customReturnMean ?? presetDefaultMean ?? 0
}

// Function to build bridge inputs from classified accounts plus live balances and derived annual
// contributions, keyed by account id. Non-portfolio accounts (debt/cash/other) are dropped, and an
// account with no allocation preset (or a "custom" one with nothing entered yet) contributes
// nothing to growth rather than silently assuming one or failing the whole analysis -- this is a
// read-only Check pass, not the stricter Generate path (see buildPot/returnAssumptionsFor, which
// throws on the same incomplete "custom" config since a dashboard genuinely can't be built without it).
//
// A roth-ira account with rothBasis set splits into two synthetic entries instead of one: IRC
// Sec. 408A(d)(4)'s ordering rule lets a Roth IRA's own contributions (and conversions, not
// modeled here) be withdrawn tax- and penalty-free at any age, before touching earnings -- unlike
// every other retirement account here, and unlike a Roth 401(k)/403(b) pre-rollover, which has no
// such rule. This is deliberately NOT threaded into the Monte Carlo dashboard widget Actual itself
// simulates: Actual's own pot format has no way to give one account two different access ages
// without either double-counting its balance or hand-entering a starting balance that drifts from
// reality on every regenerate. Scoped to this bridge/Check analysis only, which is this app's own
// pure function with no such constraint. The basis-side entry is where an ongoing contribution
// goes too -- a new Roth contribution IS new basis.
export function toBridgeAccounts(
  accounts: readonly ClassifiedAccount[],
  balances: ReadonlyMap<string, number>,
  annualContributions: ReadonlyMap<string, number>,
  retirementAge: number,
): BridgeAccount[] {
  return accounts.filter((account) => isPortfolioCategory(account.category)).flatMap((account) => {
    const balance = balances.get(account.id) ?? 0
    const returnMean = bridgeReturnMean(account)
    const withdrawalTaxRate = withdrawalTaxRateFor(account)
    // The account's own normal accessAge, not the effective one -- effectiveAccessAge is what
    // GRANTS the early access the penalty prices, so using its own output as the penalty's cutoff
    // would make the penalty apply to zero years (accessAge already reads null once the penalty
    // flag is set). Meaningless when there's no accessAge to begin with (a taxable/HSA/cash
    // account, say) -- nothing for the penalty to have shortened.
    const earlyWithdrawalPenaltyUntilAge = account.earlyWithdrawalPenalty && account.accessAge != null ? account.accessAge : null

    if (account.type === "roth-ira" && account.rothBasis != null && account.rothBasis > 0) {
      // Clamped, not just subtracted -- a market drop since the contributions were made can leave
      // the live balance below the cumulative basis, and you can't withdraw money that isn't there.
      const basisPortion = Math.min(account.rothBasis, balance)
      const growthPortion = balance - basisPortion
      return [
        {
          id: `${account.id}-basis`,
          name: `${account.name} (basis)`,
          balance: basisPortion,
          accessAge: null,
          annualContribution: annualContributions.get(account.id) ?? 0,
          returnMean,
          withdrawalTaxRate,
          // Contributed basis is already unconditionally accessible (IRC Sec. 408A(d)(4)) -- the
          // penalty option has nothing left to grant here.
          earlyWithdrawalPenaltyUntilAge: null,
          // Same order as the account's own -- basis and growth are one user-configured pot split
          // into two synthetic entries, not two independently orderable ones.
          withdrawalOrder: account.withdrawalOrder,
        },
        {
          id: `${account.id}-growth`,
          name: `${account.name} (growth)`,
          balance: growthPortion,
          accessAge: effectiveAccessAge(account, retirementAge),
          annualContribution: 0,
          returnMean,
          withdrawalTaxRate,
          earlyWithdrawalPenaltyUntilAge,
          withdrawalOrder: account.withdrawalOrder,
        },
      ]
    }

    return [
      {
        id: account.id,
        name: account.name,
        balance,
        accessAge: effectiveAccessAge(account, retirementAge),
        annualContribution: annualContributions.get(account.id) ?? 0,
        returnMean,
        withdrawalTaxRate,
        earlyWithdrawalPenaltyUntilAge,
        withdrawalOrder: account.withdrawalOrder,
      },
    ]
  })
}

