// Runs the vendored Monte Carlo engine (src/vendor/monte-carlo/) against this app's own account
// data, in-process -- an alternative to only configuring Actual's own monte-carlo-card widget and
// reading the result off Actual's dashboard. Builds on buildMonteCarloWidget rather than
// duplicating its pot/contribution/spending-phase construction: the widget this app would export
// and the config this app simulates start from the exact same meta object, so the two can never
// disagree about anything Actual itself would also resolve.

import { buildMonteCarloWidget } from "./fire-dashboard.ts"
import type { MonteCarloAssumptions, RetirementIncomeStream } from "./fire-dashboard.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { getMonteCarloHorizonYears, monteCarloConfigFromMeta, runMonteCarloSimulation } from "./vendor/monte-carlo/monte-carlo-engine.ts"
import type { MonteCarloResult } from "./vendor/monte-carlo/monte-carlo-engine.ts"

// MonteCarloResult minus the raw per-simulation arrays (endingBalances/depletionYearBySimulation/
// totalWithdrawnBySimulation, each one entry per simulation -- 5,000 by default) and runDetail
// (never populated here; captureRunDetail is a drill-in feature this app doesn't wire up yet).
// Nothing downstream of this app's own /api/retirement/check route needs per-simulation detail,
// only the aggregate stats -- and a Float64Array/Int32Array would serialize to JSON as a
// numeric-keyed object, not a real array, on top of being needlessly large over the wire.
export type MonteCarloSummary = Omit<MonteCarloResult, "endingBalances" | "depletionYearBySimulation" | "totalWithdrawnBySimulation" | "runDetail">

// A MonteCarloSummary tagged with the retirement age it was run for -- self-describing the same
// way BridgeResult carries its own retirementAge, so a client rendering several of these (one per
// configured retirement age) never has to zip them back up against a separate, index-parallel
// retirementAges array.
export type MonteCarloResultEntry = MonteCarloSummary & { retirementAge: number }

// Function to run the full Monte Carlo simulation for one retirement age, using exactly the same
// inputs Generate would use to build that age's monte-carlo-card widget. x/y/name don't affect the
// simulation (they're only widget placement/labeling), so 0/0/undefined stand in for them here.
//
// buildMonteCarloWidget sets each pot's accountId but never a startingBalance -- Actual resolves
// that itself, from the account's live balance, at the moment the widget is actually displayed on
// a dashboard. This app has no such resolution step of its own once the widget is skipped
// entirely, so the real balance has to be filled in here instead, from the same balances map
// checkDashboard already builds for the Bridge simulation (see fire-generate.ts).
export function runRetirementMonteCarlo(
  accounts: readonly ClassifiedAccount[],
  balances: ReadonlyMap<string, number>,
  currentAge: number,
  retirementAge: number,
  targetAge: number,
  annualSpendCents: number,
  assumptions: MonteCarloAssumptions,
  incomeStreams: readonly RetirementIncomeStream[] = [],
): MonteCarloSummary {
  const widget = buildMonteCarloWidget(0, 0, accounts, currentAge, retirementAge, targetAge, annualSpendCents, assumptions, undefined, incomeStreams)
  // buildMonteCarloWidget always returns a real meta object; the | null in ExportImportDashboardWidget
  // is for a widget read back from an export file, which this freshly-built one never is.
  const meta = widget.meta ?? undefined
  const pots = meta?.pots?.map((pot) => ({
    ...pot,
    startingBalance: pot.accountId != null ? (balances.get(pot.accountId) ?? 0) : pot.startingBalance,
  }))
  const config = monteCarloConfigFromMeta(pots ? { ...meta, pots } : meta)
  const result = runMonteCarloSimulation({
    ...config,
    horizonYears: getMonteCarloHorizonYears({ currentAge, targetAge }),
    currentAge,
  })
  return {
    successRate: result.successRate,
    percentileBands: result.percentileBands,
    depletionHistogram: result.depletionHistogram,
    depletionProbabilityByYear: result.depletionProbabilityByYear,
    medianEndingBalance: result.medianEndingBalance,
    medianTotalWithdrawn: result.medianTotalWithdrawn,
    medianDepletionYear: result.medianDepletionYear,
    earliestDepletionYear: result.earliestDepletionYear,
    latestDepletionYear: result.latestDepletionYear,
    worstRunPath: result.worstRunPath,
    simulationCount: result.simulationCount,
    horizonYears: result.horizonYears,
  }
}
