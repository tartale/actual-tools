import { portfolioAccounts } from "./fire-accounts.ts"
import type {
  ClassifiedAccount,
  DashboardConfig,
  MonteCarloAllocationPreset,
  MonteCarloReturnModel,
  MonteCarloTaxBandMeta,
  MonteCarloTaxModel,
  MonteCarloWithdrawalRuleMeta,
  MonteCarloWithdrawalStrategy,
  TaxTreatment,
} from "./fire-accounts.ts"

// Builds an Actual-native dashboard JSON (net worth and a Monte Carlo simulation) from classified
// accounts and expense categories. Pure -- no API calls, no file I/O.
//
// The types below are a minimal, hand-vendored local copy of the upstream ExportImportDashboard
// shape from actualbudget/actual's packages/loot-core/src/types/models/dashboard.ts, read at the
// "master" branch on 2026-09-05. Actual does not publish this as an npm type and does not version
// it independently of its own releases -- re-check against upstream before extending this file,
// especially before adding the Monte Carlo widget in a later phase.

export type TimeFrameMode =
  | "sliding-window"
  | "static"
  | "full"
  | "lastMonth"
  | "lastYear"
  | "yearToDate"
  | "priorYearToDate"
  | "currentQuarter"
  | "previousQuarter"

export interface TimeFrame {
  start: string
  end: string
  mode: TimeFrameMode
}

export interface RuleCondition {
  field: string
  op: string
  value: unknown
}

export interface NetWorthCardMeta {
  name?: string
  conditions?: RuleCondition[]
  conditionsOp?: "and" | "or"
  timeFrame?: TimeFrame
  interval?: "Daily" | "Weekly" | "Monthly" | "Yearly"
  mode?: "trend" | "stacked"
}

// "crossover-card" is no longer generated (see [[bridge-burndown-chart]] project memory -- Actual's
// own crossover projection ignores locked/inaccessible balances entirely, which this app's own
// Bridge chart already does correctly) but stays a recognized FireWidgetType/OWNED_WIDGET_TYPES
// member below so a widget from a dashboard exported before this change is cleanly dropped on the
// next regenerate, rather than either erroring or being preserved forever as "foreign" content.
export type FireWidgetType = "net-worth-card" | "crossover-card" | "monte-carlo-card"

export interface ExportImportDashboardWidget<Meta = unknown> {
  type: FireWidgetType
  x: number
  y: number
  width: number
  height: number
  meta: Meta | null
}

export interface ExportImportDashboard {
  version: 1
  widgets: ExportImportDashboardWidget[]
}

// Function to build the net-worth-card widget, spanning the full page width. Deliberately no
// account filter: an unfiltered net worth (meta.conditions omitted) is a valid Actual default --
// its own DEFAULT_DASHBOARD_STATE uses exactly this for the same widget -- and true net worth
// across every account is what a FIRE dashboard wants.
export function buildNetWorthWidget(x: number, y: number): ExportImportDashboardWidget<NetWorthCardMeta> {
  return { type: "net-worth-card", x, y, width: 12, height: 2, meta: { name: "Net Worth", mode: "trend" } }
}

// Function to pick which classified accounts count as "the portfolio" -- see fire-accounts.ts's
// portfolioAccounts/isPortfolioCategory for which categories qualify (debt, cash, and other never
// do). Used broadly (portfolio totals, contributions, debt-payoff streams), not tied to any one
// widget.
export function portfolioAccountIds(accounts: readonly ClassifiedAccount[]): string[] {
  return portfolioAccounts(accounts).map((account) => account.id)
}

// Function to assemble the base FIRE dashboard on Actual's 12-column grid: just net worth,
// full-width. (Used to also include a crossover-card widget -- see FireWidgetType's own doc
// comment for why that stopped.)
export function buildFireDashboard(): ExportImportDashboard {
  return { version: 1, widgets: [buildNetWorthWidget(0, 0)] }
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
export function effectiveAccessAge(account: Pick<ClassifiedAccount, "accessAge" | "ruleOf55SeparationAge">, retirementAge: number): number | null {
  if (account.ruleOf55SeparationAge != null && account.ruleOf55SeparationAge >= 55 && account.ruleOf55SeparationAge <= retirementAge) {
    return account.accessAge == null ? account.ruleOf55SeparationAge : Math.min(account.accessAge, account.ruleOf55SeparationAge)
  }
  return account.accessAge
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
export function buildSpendingPhases(
  currentAge: number,
  retirementAge: number,
  annualSpendCents: number,
  incomeStreams: readonly RetirementIncomeStream[] = [],
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
    // never touching the portfolio at all.
    phases.push({ id: "pre-retirement", name: "Pre-retirement (income covers it, no withdrawal)", fromAge: null, annualWithdrawal: 0 })
  }

  const alreadyActive = incomeStreams.filter((stream) => stream.startAge <= effectiveStart)
  const later = [...incomeStreams.filter((stream) => stream.startAge > effectiveStart)].sort((a, b) => a.startAge - b.startAge)

  let cumulativeIncome = alreadyActive.reduce((sum, stream) => sum + stream.annualAmount, 0)
  phases.push({
    id: "retirement-spending",
    name: "Retirement spending",
    fromAge: alreadyRetired ? null : retirementAge,
    annualWithdrawal: Math.max(0, annualSpendCents - cumulativeIncome),
  })

  for (const stream of later) {
    cumulativeIncome += stream.annualAmount
    phases.push({
      id: `income-${stream.id}`,
      name: `After ${stream.name}`,
      fromAge: stream.startAge,
      annualWithdrawal: Math.max(0, annualSpendCents - cumulativeIncome),
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

// Used only the first time a dashboard is generated for a page with no existing file to merge
// against -- config.json no longer stores these at all, since mergeGeneratedDashboard already
// preserves whatever the person tunes afterward (in Actual's own Monte Carlo config UI, or by
// hand) by reading the previously generated dashboard file. Actual's own real UI defaults
// (matched against MonteCarloConfiguration.tsx), not invented.
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

// Every MonteCarloAssumptions field (see above) that maps to a "Simulation settings" field in this
// app's own UI, keyed by the DashboardConfig field that pins it. withdrawalRule/taxBands are
// pinned as whole values (an object, an array) rather than the flat scalars every other row here
// is -- see MonteCarloWithdrawalStrategy's doc comment in fire-accounts.ts for why -- but the
// generic pin-it-here-it-always-wins mechanism (mergeMonteCarloMeta below) applies identically.
const PINNABLE_MONTE_CARLO_FIELDS: ReadonlyArray<{ dashboardField: keyof DashboardConfig; metaField: keyof MonteCarloCardMeta }> = [
  { dashboardField: "monteCarloWithdrawalStrategy", metaField: "withdrawalStrategy" },
  { dashboardField: "monteCarloReturnModel", metaField: "returnModel" },
  { dashboardField: "monteCarloTaxModel", metaField: "taxModel" },
  { dashboardField: "monteCarloInflationMean", metaField: "inflationMean" },
  { dashboardField: "monteCarloInflationStdDev", metaField: "inflationStdDev" },
  { dashboardField: "monteCarloMinimumWithdrawal", metaField: "minimumWithdrawal" },
  { dashboardField: "monteCarloSimulationCount", metaField: "simulationCount" },
  { dashboardField: "monteCarloWithdrawalRule", metaField: "withdrawalRule" },
  { dashboardField: "monteCarloTaxBands", metaField: "taxBands" },
]

// Function to layer a person's "Simulation settings" overrides over the plain defaults -- the
// seed used for a first-time generation (nothing to merge against yet) and, for whichever fields
// are actually set, the value pinned across every retirement-age comparison widget regardless of
// what merging would otherwise preserve (see mergeMonteCarloMeta's pinnedFields).
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

// Function to compute which MonteCarloCardMeta fields a person has actually pinned -- see
// mergeGeneratedDashboard's pinnedMonteCarloFields.
export function pinnedMonteCarloFields(dashboard: DashboardConfig): Set<string> {
  return new Set(PINNABLE_MONTE_CARLO_FIELDS.filter(({ dashboardField }) => dashboard[dashboardField] != null).map(({ metaField }) => metaField))
}

// Neither of these two has a counterpart in any exported widget (there's no crossover-card widget
// to feed them into any more -- see FireWidgetType's own doc comment) -- they only ever feed this
// app's own trailing-average spend calculation (fire-generate.ts's spendFromLocalSelection).
export const DEFAULT_EXPENSE_ADJUSTMENT_FACTOR = 1.0
export const DEFAULT_SPEND_HISTORY_MONTHS = 12

export function expenseAdjustmentFactorWithOverride(dashboard: Pick<DashboardConfig, "crossoverExpenseAdjustmentFactor">): number {
  return dashboard.crossoverExpenseAdjustmentFactor ?? DEFAULT_EXPENSE_ADJUSTMENT_FACTOR
}

export function spendHistoryMonthsWithOverride(dashboard: Pick<DashboardConfig, "crossoverSpendHistoryMonths">): number {
  return dashboard.crossoverSpendHistoryMonths ?? DEFAULT_SPEND_HISTORY_MONTHS
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
      spendingPhases: buildSpendingPhases(currentAge, retirementAge, annualSpendCents, incomeStreams),
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

// Function to build one stacked monte-carlo-card widget per retirement age, so multiple retirement
// scenarios can be compared side by side on the same dashboard page. Actual's dashboard has no
// built-in way to overlay multiple Monte Carlo configs on a single chart -- each widget holds
// exactly one config -- so this is the closest real comparison the widget model supports. A single
// retirement age keeps the original plain "Monte Carlo" name; multiple ages get a name naming each
// one so they're distinguishable on the page.
export function buildMonteCarloWidgets(
  x: number,
  y: number,
  accounts: readonly ClassifiedAccount[],
  currentAge: number,
  retirementAges: readonly number[],
  targetAge: number,
  annualSpendCents: number,
  assumptions: MonteCarloAssumptions,
  incomeStreams: readonly RetirementIncomeStream[] = [],
): ExportImportDashboardWidget<MonteCarloCardMeta>[] {
  return retirementAges.map((retirementAge, index) => {
    const name = retirementAges.length > 1 ? `Monte Carlo — Retire at ${retirementAge}` : "Monte Carlo"
    return buildMonteCarloWidget(
      x,
      y + index * MONTE_CARLO_WIDGET_HEIGHT,
      accounts,
      currentAge,
      retirementAge,
      targetAge,
      annualSpendCents,
      assumptions,
      name,
      incomeStreams,
    )
  })
}

// --- Merging a freshly generated dashboard with an existing file on disk ---
//
// Regenerating always recomputes the real-data fields (account/category ids, pot values and
// contributions from config.json, current age, retirement-age-driven spending), but a person may
// have hand-edited the previous output -- tweaked an assumption (safeWithdrawalRate, returnModel,
// withdrawalRule, ...), added an extra pot field (fees), or added an extra spending phase -- after
// opening it in Actual and copying settings back, or just by editing the JSON directly. Merging
// preserves all of that instead of silently discarding it on every regeneration.

// A widget as read back from an existing dashboard file -- not guaranteed to match this module's
// current FireWidgetType union (an older or hand-edited file may have a type this version no
// longer generates, e.g. the removed spending-card), so `type` stays a plain string here.
export interface ExistingDashboardWidget {
  type: string
  x: number
  y: number
  width: number
  height: number
  meta: Record<string, unknown> | null
}

export interface ExistingDashboard {
  version: number
  widgets: ExistingDashboardWidget[]
}

const OWNED_WIDGET_TYPES: readonly FireWidgetType[] = ["net-worth-card", "crossover-card", "monte-carlo-card"]

// Function to build a stable identity key for matching a freshly generated widget against one
// already present in an existing file. net-worth-card and crossover-card are singletons;
// monte-carlo-card is disambiguated by its name, which always encodes the retirement age it
// represents (see buildMonteCarloWidgets) -- a retirement age no longer requested simply has no
// generated widget to match against, so its old widget is dropped, not carried forward.
function widgetKey(widget: { type: string; meta: unknown }): string {
  if (widget.type === "monte-carlo-card") {
    const name = (widget.meta as { name?: unknown } | null)?.name
    return `monte-carlo-card:${typeof name === "string" ? name : ""}`
  }
  return widget.type
}

// Function to merge one pot's fresh, account-derived fields over any extra fields (fees, a custom
// taxableFraction, ...) an existing pot with the same account id already had. A pot with no
// existing counterpart (a newly classified portfolio account) is used exactly as generated.
function mergePots(generatedPots: MonteCarloPotMeta[], existingPotsRaw: unknown): MonteCarloPotMeta[] {
  const existingPots = Array.isArray(existingPotsRaw) ? (existingPotsRaw as Record<string, unknown>[]) : []
  const existingById = new Map(existingPots.filter((pot) => typeof pot.id === "string").map((pot) => [pot.id as string, pot]))
  return generatedPots.map((pot) => ({ ...existingById.get(pot.id), ...pot }))
}

// The spending phase ids this module generates (see buildSpendingPhases) -- these are always fully
// refreshed (fromAge/annualWithdrawal come straight from the current retirement age, trailing
// spend, and pension/Social Security config), so a stale one (e.g. "pre-retirement" left over from
// a since-removed future retirement age, or "income-pension" after the pension is cleared) is
// dropped rather than carried forward. "income-*" is a prefix, not a fixed set, since which income
// streams exist varies run to run. Any other phase id is untouched, hand-added content.
function isOwnedSpendingPhaseId(id: unknown): boolean {
  return id === "pre-retirement" || id === "retirement-spending" || (typeof id === "string" && id.startsWith("income-"))
}

function mergeSpendingPhases(generatedPhases: MonteCarloSpendingPhaseMeta[], existingPhasesRaw: unknown): MonteCarloSpendingPhaseMeta[] {
  const existingPhases = Array.isArray(existingPhasesRaw) ? (existingPhasesRaw as MonteCarloSpendingPhaseMeta[]) : []
  const extraPhases = existingPhases.filter((phase) => !isOwnedSpendingPhaseId(phase?.id))
  return [...generatedPhases, ...extraPhases]
}

// Function to merge fresh, account-derived contributions (see buildContributions) over an existing
// file's contributions array: every generated contribution (id "contribution-<accountId>") is
// always refreshed in full -- these come straight from each account's configured
// monthlyContribution, real data, not a hand-tunable assumption -- while any OTHER contribution id
// (e.g. one a person added by hand, not tied to a currently-contributing account) is preserved,
// same treatment as an extra hand-added spending phase.
function mergeContributions(generatedContributions: MonteCarloContributionMeta[], existingContributionsRaw: unknown): MonteCarloContributionMeta[] {
  const existingContributions = Array.isArray(existingContributionsRaw) ? (existingContributionsRaw as MonteCarloContributionMeta[]) : []
  const generatedIds = new Set(generatedContributions.map((contribution) => contribution.id))
  const extraContributions = existingContributions.filter((contribution) => !generatedIds.has(contribution?.id))
  return [...generatedContributions, ...extraContributions]
}

// Fields always refreshed from real data/this run's inputs on a monte-carlo-card, never preserved
// from an existing file: pots, spendingPhases, and contributions (each merged field-by-field
// above, real data from config.json), currentAge (from the birth date), targetAge (from
// --plan-to-age), and name (encodes the retirement age). Everything else (withdrawalStrategy,
// inflationMean, taxModel, returnModel, withdrawalRule, minimumWithdrawal, inflationStdDev,
// simulationCount, taxBands, ...) is preserved from the existing file when present -- UNLESS the
// person has pinned it in this app's own "Simulation settings" (see monteCarloSettingsOverride),
// in which case it's promoted into this same always-refreshed bucket, same as the real-data
// fields: pinning a setting here is exactly so every retirement-age comparison widget uses that
// one value, not whatever each one independently drifted to inside Actual.
function mergeMonteCarloMeta(generatedMeta: Record<string, unknown>, existingMeta: Record<string, unknown>, pinnedFields: ReadonlySet<string>): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...generatedMeta,
    ...existingMeta,
    name: generatedMeta.name,
    currentAge: generatedMeta.currentAge,
    targetAge: generatedMeta.targetAge,
    pots: mergePots(generatedMeta.pots as MonteCarloPotMeta[], existingMeta.pots),
    spendingPhases: mergeSpendingPhases(generatedMeta.spendingPhases as MonteCarloSpendingPhaseMeta[], existingMeta.spendingPhases),
    contributions: mergeContributions(generatedMeta.contributions as MonteCarloContributionMeta[], existingMeta.contributions),
  }
  for (const field of pinnedFields) {
    merged[field] = generatedMeta[field]
  }
  return merged
}

// Function to merge one freshly generated widget with its match (if any) from an existing file.
// Layout (x/y/width/height) always comes from the fresh generation, since it's a function of how
// many widgets this run produces, not something meaningful to hand-tune in the file.
function mergeWidget(generated: ExportImportDashboardWidget, existingWidget: ExistingDashboardWidget | undefined, pinnedMonteCarloFields: ReadonlySet<string>): ExportImportDashboardWidget {
  if (existingWidget?.meta == null || generated.meta === null) {
    return generated
  }
  const generatedMeta = generated.meta as Record<string, unknown>
  const existingMeta = existingWidget.meta
  const meta: Record<string, unknown> =
    generated.type === "monte-carlo-card"
      ? mergeMonteCarloMeta(generatedMeta, existingMeta, pinnedMonteCarloFields)
      : // net-worth-card has no real-data fields at all -- an existing customization wins outright.
        { ...generatedMeta, ...existingMeta }
  return { ...generated, meta }
}

// Function to merge a freshly generated dashboard with the one already on disk, if any: preserves
// any customization to a still-generated widget (see mergeWidget), drops a generated-type widget
// that's no longer produced this run (e.g. a removed retirement age, or crossover-card -- see
// FireWidgetType's own doc comment), and carries through untouched any widget whose type this tool
// has never generated (hand-added content, never this tool's to manage). Pass `existing: null` for
// a first run / no file yet -- returns `generated` unchanged. pinnedMonteCarloFields names the
// MonteCarloCardMeta fields (see monteCarloSettingsOverride) the person has explicitly set in this
// app's own settings -- always refreshed across every monte-carlo-card widget rather than
// independently preserved per widget.
export function mergeGeneratedDashboard(generated: ExportImportDashboard, existing: ExistingDashboard | null, pinnedMonteCarloFields: ReadonlySet<string> = new Set()): ExportImportDashboard {
  if (existing === null) {
    return generated
  }
  const existingByKey = new Map(existing.widgets.map((widget) => [widgetKey(widget), widget]))
  const widgets = generated.widgets.map((widget) => mergeWidget(widget, existingByKey.get(widgetKey(widget)), pinnedMonteCarloFields))
  const foreignWidgets = existing.widgets.filter((widget) => !OWNED_WIDGET_TYPES.includes(widget.type as FireWidgetType))
  return { version: generated.version, widgets: [...widgets, ...(foreignWidgets as ExportImportDashboardWidget[])] }
}
