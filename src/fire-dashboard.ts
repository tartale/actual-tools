import { portfolioAccounts } from "./fire-accounts.ts"
import type {
  ClassifiedAccount,
  DashboardConfig,
  ExpenseAdjustment,
  ExpenseProjectionType,
  MonteCarloAllocationPreset,
  MonteCarloReturnModel,
  MonteCarloTaxBandMeta,
  MonteCarloTaxModel,
  MonteCarloWithdrawalRuleMeta,
  MonteCarloWithdrawalStrategy,
  TaxTreatment,
} from "./fire-accounts.ts"

// Account classification helpers, the Monte Carlo widget/pot builder this app's own in-app
// simulation (fire-monte-carlo.ts) runs on internally, and the plan-wide "Simulation settings"
// resolution. Pure -- no API calls, no file I/O. (Used to also build and merge a full
// Actual-native dashboard JSON for Export to Dashboard -- removed entirely; see FireWidgetType's
// own doc comment.)
//
// The types below are a minimal, hand-vendored local copy of the upstream ExportImportDashboard
// shape from actualbudget/actual's packages/loot-core/src/types/models/dashboard.ts, read at the
// "master" branch on 2026-09-05. Actual does not publish this as an npm type and does not version
// it independently of its own releases -- re-check against upstream before extending this file.

// The only widget type this app still builds -- net-worth-card and crossover-card (and the whole
// generate/export-to-Actual feature they belonged to) were removed once Export to Dashboard was;
// this survives on its own because buildMonteCarloWidget below is also how the in-app Monte Carlo
// simulation itself is run (see fire-monte-carlo.ts's runRetirementMonteCarlo), not just how a
// dashboard widget gets built.
export type FireWidgetType = "monte-carlo-card"

export interface ExportImportDashboardWidget<Meta = unknown> {
  type: FireWidgetType
  x: number
  y: number
  width: number
  height: number
  meta: Meta | null
}

// Function to pick which classified accounts count as "the portfolio" -- see fire-accounts.ts's
// portfolioAccounts/isPortfolioCategory for which categories qualify (debt, cash, and other never
// do). Used broadly (portfolio totals, contributions, debt-payoff streams), not tied to any one
// widget.
export function portfolioAccountIds(accounts: readonly ClassifiedAccount[]): string[] {
  return portfolioAccounts(accounts).map((account) => account.id)
}

// --- Monte Carlo (experimental in Actual as of 2026-09-05 -- gated behind Settings > Advanced >
// Experimental features > "Monte Carlo Analysis Report") ---
//
// Types below are, again, a minimal hand-vendored subset of the real upstream shapes (only the
// fields this module actually sets), from the same dashboard.ts plus
// packages/desktop-client/src/components/reports/reports/monte-carlo/monteCarloSimulation.ts.

export interface MonteCarloPotMeta {
  id: string
  name?: string
  // When set, Actual pulls this account's live balance as the pot's starting balance instead of a
  // manually-entered number -- always set this, never a hardcoded startingBalance, so the pot
  // stays driven by real data.
  accountId?: string | null
  // Only read when accountId is unset -- this app always sets accountId, so this stays optional
  // and unused here; kept only because the vendored simulation engine's own MonteCarloPotMeta
  // shape has it (see monte-carlo-engine.ts's header).
  startingBalance?: number
  allocationPreset?: MonteCarloAllocationPreset
  // allocationPreset only auto-fills these in Actual's own UI -- the simulation itself reads these
  // numeric fields directly, so both must be set explicitly or the pot silently uses some other
  // default regardless of the preset label. See ALLOCATION_PRESET_RETURNS below.
  expectedReturnMean?: number
  returnStdDev?: number
  // The 'custom-mix' allocation's own asset shares -- this app never generates that preset (see
  // MonteCarloAllocationPreset's own doc comment), so these stay unused; kept for the same reason
  // as startingBalance above.
  allocationStocks?: number
  allocationBonds?: number
  allocationCash?: number
  accessAge?: number | null
  // Flat tax model: effective tax rate on withdrawals from this pot (0.15 = 15%).
  withdrawalTaxRate?: number
  // Bands tax model: share of a withdrawal from this pot counted as taxable income (1 = fully
  // taxable, 0 = a Roth/HSA). This app doesn't expose the bands model's per-pot taxable fraction
  // yet -- kept for the same reason as startingBalance above.
  taxableFraction?: number
  // Management fees -- this app doesn't model these yet; kept for the same reason as
  // startingBalance above.
  annualFeeFixed?: number
  feeAdjustsWithInflation?: boolean
  annualFeeRate?: number
}

export interface MonteCarloSpendingPhaseMeta {
  id: string
  name?: string
  fromAge?: number | null
  annualWithdrawal?: number
}

// MonteCarloWithdrawalStrategy/MonteCarloReturnModel/MonteCarloTaxModel now live in
// fire-accounts.ts (imported above) -- DashboardConfig there needs them for the
// once-for-every-age-comparison settings a person can pin in this app (see
// monteCarloSettingsOverride below), same reasoning as MonteCarloAllocationPreset.
// One recurring yearly contribution into a pot over an age window.
export interface MonteCarloContributionMeta {
  id: string
  name?: string
  potId?: string
  fromAge?: number | null
  toAge?: number | null
  annualAmount?: number
  adjustsWithInflation?: boolean
}

export interface MonteCarloCardMeta {
  name?: string
  pots?: MonteCarloPotMeta[]
  withdrawalStrategy?: MonteCarloWithdrawalStrategy
  returnModel?: MonteCarloReturnModel
  withdrawalRule?: MonteCarloWithdrawalRuleMeta
  minimumWithdrawal?: number
  spendingPhases?: MonteCarloSpendingPhaseMeta[]
  contributions?: MonteCarloContributionMeta[]
  // Mean yearly inflation as a decimal fraction (0.03 = 3%); null = flat, uninflated withdrawals.
  inflationMean?: number | null
  inflationStdDev?: number
  taxModel?: MonteCarloTaxModel
  taxBands?: MonteCarloTaxBandMeta[]
  simulationCount?: number
  currentAge?: number
  targetAge?: number
}

// Illustrative nominal annual return assumptions per allocation preset, vendored verbatim from
// Actual's own ALLOCATION_PRESETS constant (monteCarloSimulation.ts) -- keep these in sync with
// upstream if that table ever changes, since a stale copy here would misrepresent the pot's risk.
export const ALLOCATION_PRESET_RETURNS: Record<MonteCarloAllocationPreset, { mean: number; stdDev: number }> = {
  "equity-100": { mean: 0.07, stdDev: 0.15 },
  "equity-80": { mean: 0.065, stdDev: 0.12 },
  "equity-60": { mean: 0.06, stdDev: 0.1 },
  "equity-40": { mean: 0.05, stdDev: 0.075 },
  cash: { mean: 0.03, stdDev: 0.015 },
}

// Function to resolve one account's actual return/volatility assumption -- customReturnMean/
// customReturnStdDev override independently of each other and independently of allocationPreset,
// so two accounts can both be labeled "100% stocks" while assuming different real returns (a
// growth-heavy fund vs. blue chips, say). Falls back, per field, to the preset table's own value
// when that field isn't overridden -- every account has a concrete preset (see
// MonteCarloAllocationPreset's own doc comment for why there's no separate "custom" preset value
// to fall back to nothing for), so this never has an incomplete case to reject.
export function returnAssumptionsFor(
  account: Pick<ClassifiedAccount, "allocationPreset" | "customReturnMean" | "customReturnStdDev"> & { allocationPreset: MonteCarloAllocationPreset },
): { mean: number; stdDev: number } {
  const presetDefaults = ALLOCATION_PRESET_RETURNS[account.allocationPreset]
  return {
    mean: account.customReturnMean ?? presetDefaults.mean,
    stdDev: account.customReturnStdDev ?? presetDefaults.stdDev,
  }
}

// Flat-model effective withdrawal tax rate per tax treatment. Deliberately rough, user-owned
// estimates (matching Actual's own docs: "you own the number") -- tax-deferred withdrawals are
// ordinary income (a common marginal-bracket estimate), taxable-investment withdrawals are mostly
// long-term capital gains (typically taxed lower), tax-free/none pay nothing.
export const WITHDRAWAL_TAX_RATES: Record<TaxTreatment, number> = {
  "tax-deferred": 0.22,
  taxable: 0.15,
  "tax-free": 0,
  none: 0,
}

// Function to resolve one account's effective withdrawal tax rate -- its own hand-entered
// customWithdrawalTaxRate override, if set, otherwise the type-wide rough estimate above. Shared
// by buildPot (the generated Monte Carlo widget) and fire-analysis.ts's toBridgeAccounts (the
// Bridge check) so both read the exact same rate for a given account.
export function withdrawalTaxRateFor(account: Pick<ClassifiedAccount, "taxTreatment" | "customWithdrawalTaxRate">): number {
  return account.customWithdrawalTaxRate ?? WITHDRAWAL_TAX_RATES[account.taxTreatment]
}

// IRC Sec. 72(t): the additional tax on an early distribution from a qualified retirement plan,
// on top of ordinary income tax on the same dollars. Applied only for years before the account's
// own normal accessAge -- see effectiveAccessAge (which is what actually grants the early access
// this rate prices) and fire-analysis.ts's simulateBridge (which is what actually applies it,
// since it's the one place an account's per-year age is known during the withdrawal math).
export const EARLY_WITHDRAWAL_PENALTY_RATE = 0.1

// Function to compute a pot's effective access age, applying Rule of 55 when it's earlier than the
// category default. IRS Code Sec. 72(t)(2)(A)(v): separating from an employer during or after the
// calendar year you turn 55 lets you withdraw penalty-free from THAT employer's own 401(k)/403(b)
// starting immediately -- so this only takes effect at 55+ (the exception's own floor); a
// separation age below 55 doesn't qualify at all, and the normal accessAge (59, or null) stands.
// account.ruleOf55SeparationAge itself asserts eligibility (a real, currently-held employer plan,
// never an IRA) -- see fire-accounts.ts's ClassifiedAccount for why there's no separate flag.
//
// retirementAge is this scenario's own retirement age (a plan can compare several at once -- see
// buildMonteCarloWidgets), and matters because the boost only makes sense if separation happens at
// or before it: this app's model treats "retired" as "no longer working anywhere," so a scenario
// that retires at 52 can't also assume you're still employed at this account's employer until 55 --
// that combination is contradictory, not just a later date. When separationAge is later than this
// scenario's retirementAge, the boost is skipped and the normal accessAge stands for THIS scenario
// only; a later retirementAge scenario where separationAge <= retirementAge still gets the boost.
export function effectiveAccessAge(
  account: Pick<ClassifiedAccount, "accessAge" | "ruleOf55SeparationAge" | "earlyWithdrawalPenalty" | "seppMethod" | "seppStartAge">,
  retirementAge: number,
): number | null {
  // Takes priority over everything below -- accepting the 10% penalty grants full, unconditional
  // access starting now, which is strictly more permissive than any earlier-but-still-conditional
  // access age Rule of 55 or a SEPP election could produce, so there's nothing left for either
  // check to add once this is set.
  if (account.earlyWithdrawalPenalty) {
    return null
  }
  // Rule of 55 and a SEPP election are two independent, non-exclusive ways to get early access --
  // a plan is free to use either (or, unusually, qualify for both at once), so this takes the
  // EARLIEST of whichever actually apply rather than treating one as the only option. accessAge
  // itself only enters the comparison when it's a real age -- a null accessAge (nothing locked to
  // begin with) has nothing to compare against and must fall out entirely, not compete as if it
  // were age zero.
  const candidates: number[] = []
  if (account.ruleOf55SeparationAge != null && account.ruleOf55SeparationAge >= 55 && account.ruleOf55SeparationAge <= retirementAge) {
    candidates.push(account.ruleOf55SeparationAge)
  }
  if (account.seppMethod != null && account.seppStartAge != null) {
    candidates.push(account.seppStartAge)
  }
  if (account.accessAge != null) {
    candidates.push(account.accessAge)
  }
  return candidates.length > 0 ? Math.min(...candidates) : null
}

// Function to build one Monte Carlo pot from a portfolio account. Requires a non-null
// allocationPreset -- every portfolio-category account gets one by default (see
// fire-accounts.ts's ACCOUNT_TYPE_TRAITS), so a null here means an incomplete override; callers should
// catch that before reaching this function (see buildMonteCarloWidget). retirementAge is this
// widget's own scenario -- see effectiveAccessAge for why the Rule of 55 boost needs it.
export function buildPot(account: ClassifiedAccount & { allocationPreset: MonteCarloAllocationPreset }, retirementAge: number): MonteCarloPotMeta {
  const { mean, stdDev } = returnAssumptionsFor(account)
  return {
    id: account.id,
    name: account.name,
    accountId: account.id,
    allocationPreset: account.allocationPreset,
    expectedReturnMean: mean,
    returnStdDev: stdDev,
    accessAge: effectiveAccessAge(account, retirementAge),
    withdrawalTaxRate: withdrawalTaxRateFor(account),
  }
}

// A guaranteed income source that isn't a portfolio pot at all (a pension, Social Security) --
// once it starts, it reduces how much the simulation needs to draw from the pots themselves,
// rather than being modeled as its own pot with its own growth/access-age rules.
export interface RetirementIncomeStream {
  id: string
  name: string
  startAge: number
  annualAmount: number
}

// Function to derive the plan's guaranteed-income streams from the dashboard config -- a pension
// needs both a start age and an amount to count (an age with no amount, or vice versa, isn't a
// real stream yet), and Social Security only counts once a claiming age is chosen AND that age's
// own figure has actually been entered. Order doesn't matter here -- buildSpendingPhases sorts by
// start age itself.
export function retirementIncomeStreams(dashboard: Pick<DashboardConfig, "pensionStartAge" | "pensionMonthlyAmount" | "socialSecurityClaimingAge" | "socialSecurityMonthlyAt62" | "socialSecurityMonthlyAt67" | "socialSecurityMonthlyAt70">): RetirementIncomeStream[] {
  const streams: RetirementIncomeStream[] = []
  if (dashboard.pensionStartAge != null && dashboard.pensionMonthlyAmount != null) {
    streams.push({ id: "pension", name: "Pension", startAge: dashboard.pensionStartAge, annualAmount: dashboard.pensionMonthlyAmount * 12 })
  }
  const socialSecurityMonthly =
    dashboard.socialSecurityClaimingAge === 62
      ? dashboard.socialSecurityMonthlyAt62
      : dashboard.socialSecurityClaimingAge === 67
        ? dashboard.socialSecurityMonthlyAt67
        : dashboard.socialSecurityClaimingAge === 70
          ? dashboard.socialSecurityMonthlyAt70
          : null
  if (dashboard.socialSecurityClaimingAge != null && socialSecurityMonthly != null) {
    streams.push({ id: "social-security", name: "Social Security", startAge: dashboard.socialSecurityClaimingAge, annualAmount: socialSecurityMonthly * 12 })
  }
  return streams
}

// Function to build the plan's spending phases from a real trailing-spend figure -- the same
// annual spend already computed for the crossover widget's console sanity check, not a separate
// guess. A single spending phase's `fromAge` is a no-op in Actual's own simulation engine (its
// per-year loop always falls back to the earliest phase's amount before checking any fromAge), so
// a future retirement age only has an effect if modeled as TWO phases: $0 while accumulating, then
// the real spend once retirementAge is reached. Already retired (or retiring today) collapses back
// to the single always-on phase.
//
// incomeStreams (pension, Social Security -- see retirementIncomeStreams) layer in as additional
// phases: each one still active at retirement folds straight into the base retirement-spending
// number (it was already reducing the draw from day one), while one that starts later gets its
// own phase stepping the withdrawal down further from that age on. Withdrawal is floored at 0 --
// guaranteed income exceeding spend doesn't mean the portfolio owes the plan money.
// expenseAdjustments layers in a SIGNED effect on top of income's own reduction -- positive
// increases the withdrawal, negative reduces it (see ExpenseAdjustment's own doc comment,
// fire-accounts.ts). Treated as a today's-dollars figure regardless of its own inflate flag:
// Monte Carlo's spending-phase model only knows a figure the engine itself inflates every
// simulated year (same as annualSpendCents/income streams already are), with no notion of a
// phase-spanning FIXED nominal amount the way Bridge's own per-year loop can represent -- a
// deliberate approximation specific to this engine, not a precise match to Bridge's own math.
export function buildSpendingPhases(
  currentAge: number,
  retirementAge: number,
  annualSpendCents: number,
  incomeStreams: readonly RetirementIncomeStream[] = [],
  expenseAdjustments: readonly ExpenseAdjustment[] = [],
): MonteCarloSpendingPhaseMeta[] {
  const alreadyRetired = retirementAge <= currentAge
  const effectiveStart = Math.max(retirementAge, currentAge)
  const phases: MonteCarloSpendingPhaseMeta[] = []
  if (!alreadyRetired) {
    // Named to say WHY it's $0, not just that it is -- Actual's own widget literally labels this
    // field "Yearly spending," which reads as an obvious data error at a glance if the phase is
    // just called "Pre-retirement." $0 here means $0 WITHDRAWN FROM THE PORTFOLIO -- verified
    // against Actual's own monteCarloSimulation.ts: withdrawal and contributions are separate,
    // additive line items applied to the same pot balances the same year, so a nonzero "spending"
    // figure here would double-count real living expenses that were actually paid out of wages,
    // never touching the portfolio at all. An expense adjustment active before retirement has
    // nothing to adjust here for exactly the same reason.
    phases.push({ id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 })
  }

  // Computed fresh at any age (not tracked incrementally) so the later loop below can freely
  // interleave income-stream and expense-adjustment boundaries in age order without the two
  // needing to be walked together.
  const incomeEffectAt = (age: number): number => incomeStreams.filter((stream) => stream.startAge <= age).reduce((sum, stream) => sum + stream.annualAmount, 0)
  const adjustmentEffectAt = (age: number): number =>
    expenseAdjustments.filter((adjustment) => adjustment.startAge <= age && (adjustment.endAge == null || adjustment.endAge >= age)).reduce((sum, adjustment) => sum + adjustment.annualAmount, 0)

  phases.push({
    id: "retirement-spending",
    name: "Retirement spending",
    fromAge: alreadyRetired ? null : retirementAge,
    annualWithdrawal: Math.max(0, annualSpendCents - incomeEffectAt(effectiveStart) + adjustmentEffectAt(effectiveStart)),
  })

  // Every later income-stream start and every later expense-adjustment boundary (its own startAge,
  // or the age right after its endAge, reversing it exactly once it's no longer active) merge into
  // one shared, age-ordered list of phases.
  const laterIncome = incomeStreams
    .filter((stream) => stream.startAge > effectiveStart)
    .map((stream) => ({ age: stream.startAge, id: `income-${stream.id}`, name: `After ${stream.name}` }))
  const laterAdjustments = expenseAdjustments
    .flatMap((adjustment) => [
      { age: adjustment.startAge, id: `expense-${adjustment.id}-start`, name: adjustment.name },
      ...(adjustment.endAge != null ? [{ age: adjustment.endAge + 1, id: `expense-${adjustment.id}-end`, name: `${adjustment.name} ends` }] : []),
    ])
    .filter((boundary) => boundary.age > effectiveStart)
  const laterBoundaries = [...laterIncome, ...laterAdjustments].sort((a, b) => a.age - b.age)

  for (const boundary of laterBoundaries) {
    phases.push({
      id: boundary.id,
      name: boundary.name,
      fromAge: boundary.age,
      annualWithdrawal: Math.max(0, annualSpendCents - incomeEffectAt(boundary.age) + adjustmentEffectAt(boundary.age)),
    })
  }

  return phases
}

export const MONTE_CARLO_WIDGET_HEIGHT = 4

// The Monte Carlo assumptions a person can configure (./actual configure) instead of this module
// hardcoding them. Shape matches MonteCarloCardMeta's own configurable fields exactly (minus pots/
// spendingPhases/contributions/currentAge/targetAge, which are always derived from real data).
export interface MonteCarloAssumptions {
  withdrawalStrategy: MonteCarloWithdrawalStrategy
  returnModel: MonteCarloReturnModel
  withdrawalRule: MonteCarloWithdrawalRuleMeta
  minimumWithdrawal: number
  inflationMean: number | null
  inflationStdDev: number
  taxModel: MonteCarloTaxModel
  taxBands: MonteCarloTaxBandMeta[]
  simulationCount: number
}

// The fallback for whichever "Simulation settings" fields a person hasn't overridden on the Plan
// section (see monteCarloAssumptionsWithOverrides) -- Actual's own real UI defaults (matched
// against MonteCarloConfiguration.tsx), not invented.
export const DEFAULT_MONTE_CARLO_ASSUMPTIONS: MonteCarloAssumptions = {
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

// Function to layer a person's "Simulation settings" overrides over the plain defaults used to
// actually run this app's own in-app Monte Carlo simulation (see fire-monte-carlo.ts).
export function monteCarloAssumptionsWithOverrides(dashboard: DashboardConfig): MonteCarloAssumptions {
  return {
    ...DEFAULT_MONTE_CARLO_ASSUMPTIONS,
    withdrawalStrategy: dashboard.monteCarloWithdrawalStrategy ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.withdrawalStrategy,
    returnModel: dashboard.monteCarloReturnModel ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.returnModel,
    taxModel: dashboard.monteCarloTaxModel ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.taxModel,
    inflationMean: dashboard.monteCarloInflationMean ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.inflationMean,
    inflationStdDev: dashboard.monteCarloInflationStdDev ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.inflationStdDev,
    minimumWithdrawal: dashboard.monteCarloMinimumWithdrawal ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.minimumWithdrawal,
    simulationCount: dashboard.monteCarloSimulationCount ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.simulationCount,
    withdrawalRule: dashboard.monteCarloWithdrawalRule ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.withdrawalRule,
    taxBands: dashboard.monteCarloTaxBands ?? DEFAULT_MONTE_CARLO_ASSUMPTIONS.taxBands,
  }
}

// Neither of these two has a counterpart in any exported widget (there's no crossover-card widget
// any more -- see FireWidgetType's own doc comment) -- they only ever feed this app's own
// trailing-average spend calculation (fire-generate.ts's spendFromLocalSelection).
export const DEFAULT_EXPENSE_ADJUSTMENT_FACTOR = 1.0
export const DEFAULT_SPEND_HISTORY_MONTHS = 12
// "mean" -- the exact computation every plan already had before ExpenseProjectionType existed (see
// its own doc comment in fire-accounts.ts), so an untouched plan's numbers never silently move.
export const DEFAULT_EXPENSE_PROJECTION_TYPE = "mean"

export function expenseAdjustmentFactorWithOverride(dashboard: Pick<DashboardConfig, "crossoverExpenseAdjustmentFactor">): number {
  return dashboard.crossoverExpenseAdjustmentFactor ?? DEFAULT_EXPENSE_ADJUSTMENT_FACTOR
}

export function spendHistoryMonthsWithOverride(dashboard: Pick<DashboardConfig, "crossoverSpendHistoryMonths">): number {
  return dashboard.crossoverSpendHistoryMonths ?? DEFAULT_SPEND_HISTORY_MONTHS
}

export function expenseProjectionTypeWithOverride(dashboard: Pick<DashboardConfig, "expenseProjectionType">): ExpenseProjectionType {
  return dashboard.expenseProjectionType ?? DEFAULT_EXPENSE_PROJECTION_TYPE
}

// Function to build one recurring-contribution entry per portfolio account with a nonzero monthly
// contribution. annualAmount is the monthly figure (cents) x12 -- Actual's own Monte Carlo
// simulation reads it the same way. Contributions stop at retirement (toAge: retirementAge, mirroring
// buildSpendingPhases' retirement-spending phase starting at that same age) -- nobody is still
// funding an account from a paycheck once they've retired. Already retired at generation time
// (retirementAge <= currentAge) means there's no ongoing contribution to model at all.
function buildContributions(accounts: readonly ClassifiedAccount[], currentAge: number, retirementAge: number): MonteCarloContributionMeta[] {
  if (retirementAge <= currentAge) {
    return []
  }
  const contributions: MonteCarloContributionMeta[] = []
  for (const account of accounts) {
    if (!account.monthlyContribution) {
      continue
    }
    contributions.push({
      id: `contribution-${account.id}`,
      name: account.name,
      potId: account.id,
      fromAge: null,
      toAge: retirementAge,
      annualAmount: account.monthlyContribution * 12,
      adjustsWithInflation: true,
    })
  }
  return contributions
}

// Function to build one monte-carlo-card widget: one pot (and, if configured, one contribution)
// per portfolio account (linked to its live balance), spending phases split around the retirement
// age, and the given assumptions. Everything this function doesn't set (fees, a custom
// taxableFraction, minimumWithdrawal beyond the assumption default, ...) is left for Actual's own
// UI once the widget is open -- this only sets what Actual can't infer on its own.
export function buildMonteCarloWidget(
  x: number,
  y: number,
  accounts: readonly ClassifiedAccount[],
  currentAge: number,
  retirementAge: number,
  targetAge: number,
  annualSpendCents: number,
  assumptions: MonteCarloAssumptions,
  name = "Monte Carlo",
  incomeStreams: readonly RetirementIncomeStream[] = [],
  expenseAdjustments: readonly ExpenseAdjustment[] = [],
): ExportImportDashboardWidget<MonteCarloCardMeta> {
  const eligibleAccounts = portfolioAccounts(accounts)
  const missingPreset = eligibleAccounts.find((account) => account.allocationPreset === null)
  if (missingPreset) {
    throw new Error(`"${missingPreset.name}" has no allocationPreset set -- pick one on the Configure tab first.`)
  }

  // Actual's own simulation engine drains pots strictly in the order the pots array lists them
  // (used only by the "sequential" withdrawal strategy; harmless to apply regardless of which
  // strategy is chosen, since every other strategy ignores array order entirely) -- see
  // ClassifiedAccount's withdrawalOrder doc comment. Accounts with no explicit order keep their
  // relative natural order and sort after every explicitly-ordered account.
  const orderedAccounts = [...eligibleAccounts].sort((a, b) => {
    if (a.withdrawalOrder == null && b.withdrawalOrder == null) return 0
    if (a.withdrawalOrder == null) return 1
    if (b.withdrawalOrder == null) return -1
    return a.withdrawalOrder - b.withdrawalOrder
  })
  const pots = orderedAccounts.map((account) => buildPot(account as ClassifiedAccount & { allocationPreset: MonteCarloAllocationPreset }, retirementAge))

  return {
    type: "monte-carlo-card",
    x,
    y,
    width: 12,
    height: MONTE_CARLO_WIDGET_HEIGHT,
    meta: {
      name,
      pots,
      withdrawalStrategy: assumptions.withdrawalStrategy,
      returnModel: assumptions.returnModel,
      withdrawalRule: assumptions.withdrawalRule,
      minimumWithdrawal: assumptions.minimumWithdrawal,
      spendingPhases: buildSpendingPhases(currentAge, retirementAge, annualSpendCents, incomeStreams, expenseAdjustments),
      contributions: buildContributions(eligibleAccounts, currentAge, retirementAge),
      inflationMean: assumptions.inflationMean,
      inflationStdDev: assumptions.inflationStdDev,
      taxModel: assumptions.taxModel,
      taxBands: assumptions.taxBands,
      simulationCount: assumptions.simulationCount,
      currentAge,
      targetAge,
    },
  }
}

