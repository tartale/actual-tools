import { addMonthsToDate, formatUsd } from "./actual-helpers.ts"
import { isPortfolioCategory } from "./fire-accounts.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { ALLOCATION_PRESET_RETURNS, effectiveAccessAge, withdrawalTaxRateFor } from "./fire-dashboard.ts"
import type { MonteCarloCardMeta, RetirementIncomeStream } from "./fire-dashboard.ts"
import type { MonteCarloSummary } from "./fire-monte-carlo.ts"

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
  if (details.balanceAsOf <= 0) {
    return { monthsRemaining: 0, payoffDate: details.balanceAsOfDate }
  }
  if (monthlyRate === 0) {
    if (details.monthlyPayment <= 0) {
      return { error: "Monthly payment must be greater than zero." }
    }
    const monthsRemaining = Math.ceil(details.balanceAsOf / details.monthlyPayment)
    return { monthsRemaining, payoffDate: addMonthsToDate(details.balanceAsOfDate, monthsRemaining) }
  }
  const monthlyInterest = details.balanceAsOf * monthlyRate
  if (details.monthlyPayment <= monthlyInterest) {
    return { error: "Payment doesn't cover the interest accruing each month -- the balance would grow, not shrink." }
  }
  const monthsRemaining = Math.ceil(
    -Math.log(1 - (details.balanceAsOf * monthlyRate) / details.monthlyPayment) / Math.log(1 + monthlyRate),
  )
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
}

// Function to split a one-shot snapshot of accounts (a historical balance as of some past age, or
// any other static balance figure) into accessible/locked totals -- the same accessAge rule
// simulateBridge's own internal splitAt applies to its year-by-year MUTATED balances, but usable
// here against toBridgeAccounts' plain, unchanging balance snapshot instead.
export function historicalBridgeYear(accounts: readonly BridgeAccount[], age: number): BridgeYear {
  let accessibleBalance = 0
  let lockedBalance = 0
  for (const account of accounts) {
    if (account.accessAge == null || age >= account.accessAge) {
      accessibleBalance += account.balance
    } else {
      lockedBalance += account.balance
    }
  }
  return { age, accessibleBalance, lockedBalance }
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
    if (!capturedSplit && age >= retirementAge) {
      const split = splitAt(age)
      accessibleAtRetirement = split.accessible
      lockedAtRetirement = split.locked
      accumulation.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked })
      capturedSplit = true
    }

    // Recorded every year of the withdrawal phase, not just at the moments the summary fields
    // above care about -- this is the actual line the chart draws.
    if (age >= retirementAge) {
      const split = splitAt(age)
      timeline.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked })
    } else {
      const split = splitAt(age)
      accumulation.push({ age, accessibleBalance: split.accessible, lockedBalance: split.locked })
    }

    if (age < retirementAge) {
      accounts.forEach((account, index) => {
        balances[index] = (balances[index] as number) + account.annualContribution
      })
    } else {
      // Pension/Social Security are entered as today's-dollars figures, same as annualSpend, so
      // the offset is netted out before inflating the result rather than after -- keeps guaranteed
      // income growing in step with spend under this same inflation assumption, rather than fixed
      // in nominal terms and shrinking in real value every year.
      const incomeAtAge = incomeStreams.filter((stream) => stream.startAge <= age).reduce((sum, stream) => sum + stream.annualAmount, 0)
      const netAnnualSpend = Math.max(0, annualSpend - incomeAtAge)
      const spend = netAnnualSpend * Math.pow(1 + inflationMean, age - currentAge)
      const reachable = accounts.map((account, index) => index).filter((index) => isAccessible(accounts[index] as BridgeAccount, age))
      const reachableTotal = reachable.reduce((total, index) => total + (balances[index] as number), 0)
      if (reachableTotal <= FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      const shares = new Map(reachable.map((index) => [index, (balances[index] as number) / reachableTotal]))
      // Withdrawals are taxed, so funding `spend` net needs a larger gross withdrawal. Each pot
      // contributes its balance-weighted share of that gross at its own rate.
      const netPerGross = reachable.reduce(
        (total, index) => total + (shares.get(index) as number) * (1 - (accounts[index] as BridgeAccount).withdrawalTaxRate),
        0,
      )
      const gross = netPerGross > 0 ? spend / netPerGross : Infinity
      if (gross > reachableTotal + FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      for (const index of reachable) {
        balances[index] = (balances[index] as number) - gross * (shares.get(index) as number)
      }
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
    `${formatUsd(result.accessibleAtRetirement)} reachable at ${result.retirementAge} (${share}%)` +
      (result.lockedAtRetirement > 0 && result.nextUnlockAge != null
        ? `, ${formatUsd(result.lockedAtRetirement)} locked (earliest unlock at ${result.nextUnlockAge})`
        : ""),
  ]

  if (result.depletionAge === null) {
    return { level: "ok", title: `age ${result.retirementAge} -- funds every year until age ${planToAge}.`, detail: split }
  }
  if (result.nextUnlockAfterDepletion != null) {
    const gap = result.nextUnlockAfterDepletion - result.depletionAge
    return {
      level: "fail",
      title: `age ${result.retirementAge} -- reachable money runs out at ${result.depletionAge}, ${gap} yr${gap === 1 ? "" : "s"} before the next ${formatUsd(result.lockedAtDepletion)} unlocks at ${result.nextUnlockAfterDepletion}.`,
      detail: [...split, "This is already the best case -- mean returns, no volatility -- so every simulated run fails here too."],
    }
  }
  return {
    level: "warn",
    title: `age ${result.retirementAge} -- runs out at ${result.depletionAge}, short of ${planToAge}.`,
    detail: [...split, "Everything has unlocked by then, so this is a shortfall, not a bridging problem."],
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
    return { level: "ok", title: `age ${retirementAge} -- every simulated run funds the plan through ${planToAge}.`, detail }
  }
  if (result.medianDepletionYear != null) {
    detail.push(`Depleted runs typically ran out around age ${currentAge + result.medianDepletionYear}.`)
  }
  const level: FindingLevel = result.successRate >= 0.9 ? "ok" : result.successRate >= 0.5 ? "warn" : "fail"
  return {
    level,
    title: `age ${retirementAge} -- ${successPct}% of ${result.simulationCount.toLocaleString()} simulated runs fund the plan through ${planToAge}.`,
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
        },
        {
          id: `${account.id}-growth`,
          name: `${account.name} (growth)`,
          balance: growthPortion,
          accessAge: effectiveAccessAge(account, retirementAge),
          annualContribution: 0,
          returnMean,
          withdrawalTaxRate,
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
      },
    ]
  })
}

// Function to compare the access ages actually stored in the live dashboard's Monte Carlo pots
// against what the current config would generate. A mismatch means the dashboard predates a
// config change and hasn't been re-imported -- the drift that makes the generate/import/edit cycle
// go wrong, and which nothing surfaces today.
//
// retirementAges is the full set of scenarios on the plan -- an account's Rule-of-55-adjusted
// accessAge can legitimately differ from one retirement-age widget to the next (see
// effectiveAccessAge), so "what's expected" is a set of ages, one per scenario, not a single value.
export function detectPotDrift(
  metas: readonly MonteCarloCardMeta[],
  accounts: readonly ClassifiedAccount[],
  retirementAges: readonly number[],
): Finding[] {
  const portfolio = accounts.filter((account) => isPortfolioCategory(account.category))
  const expected = new Map(
    portfolio.map((account) => [account.id, new Set(retirementAges.map((retirementAge) => effectiveAccessAge(account, retirementAge)))]),
  )

  const live = new Map<string, Set<number | null>>()
  for (const meta of metas) {
    for (const pot of meta.pots ?? []) {
      if (pot.accountId == null) {
        continue
      }
      const seen = live.get(pot.accountId) ?? new Set<number | null>()
      seen.add(pot.accessAge ?? null)
      live.set(pot.accountId, seen)
    }
  }

  const findings: Finding[] = []
  for (const account of portfolio) {
    const seen = live.get(account.id)
    if (seen === undefined) {
      findings.push({
        level: "warn",
        title: `${account.name} is classified ${account.category} but has no pot in Actual's exported dashboard.`,
        detail: ["Added or reclassified since you last exported. This doesn't affect the numbers on this page -- use Export to Dashboard to include it in Actual too."],
      })
      continue
    }
    const want = expected.get(account.id) ?? new Set<number | null>([null])
    const stale = [...seen].filter((age) => !want.has(age))
    if (stale.length > 0) {
      findings.push({
        level: "warn",
        title: `${account.name}: Actual has access age ${stale.map((age) => age ?? "none").join("/")}, your current config would produce ${[...want].map((age) => age ?? "none").join("/")}.`,
        detail: ["Your exported Actual dashboard predates this change. This doesn't affect the numbers on this page -- use Export to Dashboard to update it in Actual too."],
      })
    }
  }

  for (const accountId of live.keys()) {
    if (!expected.has(accountId)) {
      const named = accounts.find((account) => account.id === accountId)
      findings.push({
        level: "info",
        title: `${named?.name ?? accountId} has a pot in Actual's exported dashboard but is no longer a portfolio account here.`,
        detail: ["Doesn't affect the numbers on this page -- use Export to Dashboard to drop it from Actual too."],
      })
    }
  }

  return findings
}

// Function to catch a configured retirement-age scenario with no live widget at all yet -- not a
// mismatch WITHIN an existing widget (detectPotDrift/detectSpendingPhaseDrift's job), the widget
// itself missing outright. Real, not hypothetical: buildMonteCarloWidgets names a widget
// "Monte Carlo — Retire at N" once there's more than one configured age, but plain "Monte Carlo"
// with only one -- so going from one retirement age to several doesn't just need new widgets
// alongside the old one, the ORIGINAL scenario's own expected name changes too, and a dashboard
// generated back when there was only one age matches NONE of the freshly expected names any more.
// Matches by name, the same identifier Generate itself gives each widget and the only one a fresh
// widget and a live one share.
export function detectMonteCarloWidgetSetDrift(
  freshWidgets: readonly { meta: { name?: string } | null }[],
  liveMetas: readonly MonteCarloCardMeta[],
): Finding[] {
  const freshNames = new Set(freshWidgets.map((widget) => widget.meta?.name).filter((name): name is string => typeof name === "string"))
  const liveNames = new Set(liveMetas.filter((meta) => typeof meta.name === "string").map((meta) => meta.name as string))

  const findings: Finding[] = []
  for (const name of freshNames) {
    if (!liveNames.has(name)) {
      findings.push({
        level: "warn",
        title: `Actual has no Monte Carlo widget named "${name}" yet.`,
        detail: ["A retirement age was added, or the set of configured ages changed, since you last exported. This doesn't affect the numbers on this page -- click Export to Dashboard above if you'd also like it reflected in Actual."],
      })
    }
  }
  for (const name of liveNames) {
    if (!freshNames.has(name)) {
      findings.push({
        level: "info",
        title: `"${name}" is in Actual but no longer matches a configured retirement age.`,
        detail: ["Remove it by hand in Actual, or use Export to Dashboard to replace the whole set there."],
      })
    }
  }
  return findings
}

// Function to compare each live Monte Carlo widget's spendingPhases/contributions -- fields only
// ever refreshed when Generate actually runs -- against what a fresh generate would produce right
// now for the matching retirement-age scenario, matched by name (the same deterministic key
// mergeGeneratedDashboard already uses for merging, so this needs no separate age-parsing logic).
// This is what actually catches real data changing out from under an already-imported dashboard --
// a narrowed crossover category selection, a new pension/Social Security figure, a debt nearing
// payoff, or a changed account contribution -- none of which detectPotDrift (access ages alone)
// would ever flag. A scenario with nothing live yet is skipped here -- there's no spending phase to
// compare it against -- but IS a real gap this function doesn't cover: detectPotDrift only flags an
// account with NO live pot anywhere, and every account in an existing scenario already has one, so
// adding a whole new retirement-age scenario (same accounts, one more age) sailed past both checks
// with no finding at all. See detectMonteCarloWidgetSetDrift below, which is what actually covers
// that case -- an account having a pot somewhere and a SCENARIO existing at all are different
// questions, and no other check was asking the second one.
export function detectSpendingPhaseDrift(
  freshWidgets: readonly { meta: { name?: string; spendingPhases?: unknown; contributions?: unknown } | null }[],
  liveMetas: readonly MonteCarloCardMeta[],
): Finding[] {
  const liveByName = new Map(liveMetas.filter((meta) => typeof meta.name === "string").map((meta) => [meta.name as string, meta]))
  const findings: Finding[] = []
  for (const widget of freshWidgets) {
    const name = widget.meta?.name
    if (typeof name !== "string") {
      continue
    }
    const live = liveByName.get(name)
    if (!live) {
      continue
    }
    if (JSON.stringify(widget.meta?.spendingPhases ?? null) !== JSON.stringify(live.spendingPhases ?? null)) {
      findings.push({
        level: "warn",
        title: `"${name}" spending in Actual no longer matches your current Runway config.`,
        detail: ["An expense-category selection (Spend configuration), pension/Social Security figure, or debt payoff has changed since you last exported. This doesn't affect the numbers on this page -- use Export to Dashboard to update it in Actual too."],
      })
    }
    if (JSON.stringify(widget.meta?.contributions ?? null) !== JSON.stringify(live.contributions ?? null)) {
      findings.push({
        level: "warn",
        title: `"${name}" contributions in Actual no longer match your current Runway config.`,
        detail: ["An account's monthly contribution has changed since you last exported. This doesn't affect the numbers on this page -- use Export to Dashboard to update it in Actual too."],
      })
    }
  }
  return findings
}
