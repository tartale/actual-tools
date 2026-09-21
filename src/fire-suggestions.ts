import type { ActualConfig } from "./actual-helpers.ts"
import type { AccountDataSource } from "./account-data-source.ts"
import { ACCOUNT_TYPE_TRAITS } from "./fire-accounts.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { checkDashboard } from "./fire-generate.ts"
import type { CheckOptions, CheckResult } from "./fire-generate.ts"
import { SEPP_METHODS, seppAmount } from "./fire-sepp.ts"
import type { SeppMethod } from "./fire-sepp.ts"
import type { IrsLifeExpectancyTable } from "./irs-life-expectancy.ts"

// One candidate SEPP method's own informational annual distribution, for the suggestion modal's
// pros/cons text -- purely informational. This app's own simulation (effectiveAccessAge in
// fire-dashboard.ts) only ever uses seppStartAge to decide when an account unlocks; the computed
// distribution amount (and so which method is picked) has no effect on the simulated Bridge/Monte
// Carlo outcome at all, since simulateBridge's own withdrawal allocation is need-driven, not
// pinned to a fixed SEPP schedule. Real IRS rules DO care which method you commit to (a real
// election is a single, unmodifiable choice for 5 years or until 59.5, whichever is later), so
// this is still worth showing -- just not something a "which one performs better" simulation can
// answer, because in this app's model neither one performs any differently than the other.
export interface SeppMethodOption {
  method: SeppMethod
  // Null when the IRS life-expectancy table isn't loaded -- annualAmount just isn't shown then,
  // same "absent, not an error" convention the rest of this app's SEPP display already uses.
  annualAmount: number | null
}

export type Suggestion =
  | { kind: "rule-of-55"; accountId: string; accountName: string }
  | { kind: "sepp"; accountId: string; accountName: string; methodOptions: SeppMethodOption[] }

export interface SuggestionsResult {
  // The one scenario suggestions were generated against -- see generateSuggestions' own doc
  // comment for why only the lowest configured retirement age is targeted.
  targetRetirementAge: number
  suggestions: Suggestion[]
}

// Function to decide whether a candidate what-if CheckResult is a real improvement over the
// baseline for the SAME single-scenario request (both were run with retirementAges: [age], so
// index 0 is always the scenario being compared) -- a later (or newly eliminated) Bridge
// depletion age, or a meaningfully higher Monte Carlo success rate. The 0.5-percentage-point
// Monte Carlo margin exists to not surface a suggestion over pure simulation noise; Bridge's own
// mean-returns-no-volatility model has no such noise to guard against, so any real change there
// counts.
function isImprovement(baseline: CheckResult, candidate: CheckResult): boolean {
  const baselineBridge = baseline.bridgeResults[0]
  const candidateBridge = candidate.bridgeResults[0]
  const bridgeImproved =
    baselineBridge != null &&
    candidateBridge != null &&
    baselineBridge.depletionAge != null &&
    (candidateBridge.depletionAge == null || candidateBridge.depletionAge > baselineBridge.depletionAge)

  const baselineMonteCarlo = baseline.monteCarloResults[0]
  const candidateMonteCarlo = candidate.monteCarloResults[0]
  const monteCarloImproved = baselineMonteCarlo != null && candidateMonteCarlo != null && candidateMonteCarlo.successRate > baselineMonteCarlo.successRate + 0.005

  return bridgeImproved || monteCarloImproved
}

// Function to generate "you're eligible for an early-access option you haven't set, and it would
// help" suggestions -- issue #28. Only Rule of 55 (ruleOf55SeparationAge) and a SEPP election
// (seppMethod/seppStartAge) are considered, per the issue's own scope: both are already fully
// modeled (see fire-dashboard.ts's effectiveAccessAge), this is about detecting an unused,
// eligible option and confirming it actually helps before suggesting it -- not new financial
// modeling.
//
// Only the LOWEST configured retirement age is targeted (per the issue's own "only target the
// lowest age entered") -- that's the scenario most likely to benefit from earlier account access,
// and running this what-if search against every compared scenario would multiply the real
// checkDashboard calls below for little added value.
//
// Each candidate is tested with its own real checkDashboard call (accounts array locally modified,
// otherwise identical inputs) rather than re-deriving a cheaper approximation -- this is the only
// way to get a real, trustworthy "would this actually help" answer that can never disagree with
// what the real Bridge/Monte Carlo run would show once applied, the same reasoning this app
// already applies to keeping its MAGI/withdrawal figures from a single source of truth elsewhere.
// Bounded to one call per eligible account per mechanism (at most 2x the account count), not
// every possible combination of accounts -- combining multiple accounts' own changes is left for
// the user's own judgment once they see which individual accounts help.
export async function generateSuggestions(
  actualConfig: ActualConfig,
  dataSource: AccountDataSource,
  accounts: readonly ClassifiedAccount[],
  options: CheckOptions,
  irsLifeExpectancy: IrsLifeExpectancyTable | null,
): Promise<SuggestionsResult | null> {
  if (options.retirementAges.length === 0) return null
  const targetRetirementAge = Math.min(...options.retirementAges)
  const scenarioOptions: CheckOptions = { ...options, retirementAges: [targetRetirementAge] }

  const baseline = await checkDashboard(actualConfig, dataSource, accounts, scenarioOptions)
  if (baseline.bridgeResults[0] == null) return { targetRetirementAge, suggestions: [] }

  const suggestions: Suggestion[] = []
  for (const account of accounts) {
    // Nothing to unlock (no lock to begin with), or already unconditionally accessible now --
    // either way, there's no real option left for either mechanism to grant.
    if (account.accessAge == null || account.earlyWithdrawalPenalty) continue

    if (ACCOUNT_TYPE_TRAITS[account.type].ruleOf55Eligible && account.ruleOf55SeparationAge == null && targetRetirementAge >= 55) {
      const modified = accounts.map((a) => (a.id === account.id ? { ...a, ruleOf55SeparationAge: targetRetirementAge } : a))
      const candidate = await checkDashboard(actualConfig, dataSource, modified, scenarioOptions)
      if (isImprovement(baseline, candidate)) {
        suggestions.push({ kind: "rule-of-55", accountId: account.id, accountName: account.name })
      }
    }

    // IRC Sec. 72(t) SEPP elections apply to tax-deferred qualified retirement accounts -- not a
    // Roth (already has its own, different early-access rules for contributions) or a taxable
    // account (no early-withdrawal penalty concept applies there to begin with).
    if (account.taxTreatment === "tax-deferred" && account.seppMethod == null) {
      // Method choice doesn't change the simulated result (see this module's own top-of-file doc
      // comment) -- "amortization" here is an arbitrary valid choice to test with, not a
      // recommendation; the actual candidate methods shown to the user are computed separately
      // below, once an improvement is confirmed.
      const modified = accounts.map((a) => (a.id === account.id ? { ...a, seppMethod: "amortization" as const, seppStartAge: targetRetirementAge } : a))
      const candidate = await checkDashboard(actualConfig, dataSource, modified, scenarioOptions)
      if (isImprovement(baseline, candidate)) {
        const balance = await dataSource.fetchAccountBalance(account.id)
        const methodOptions: SeppMethodOption[] = SEPP_METHODS.map((method) => ({
          method,
          annualAmount: irsLifeExpectancy == null ? null : seppAmount(method, balance, targetRetirementAge, account.seppInterestRate, irsLifeExpectancy),
        }))
        suggestions.push({ kind: "sepp", accountId: account.id, accountName: account.name, methodOptions })
      }
    }
  }

  return { targetRetirementAge, suggestions }
}
