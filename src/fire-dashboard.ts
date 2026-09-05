import { portfolioAccounts } from "./fire-accounts.ts"
import type { ClassifiedAccount, MonteCarloAllocationPreset, TaxTreatment } from "./fire-accounts.ts"

// Builds an Actual-native dashboard JSON (net worth, spending, and a FIRE crossover projection)
// from classified accounts and expense categories. Pure -- no API calls, no file I/O.
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

export type SpendingAverageRange = { mode: "last-n-months"; months: 3 | 6 | 12 } | { mode: "year-to-date" } | { mode: "all-time" }

export interface SpendingCardMeta {
  name?: string
  mode?: "single-month" | "budget" | "average"
  averageRange?: SpendingAverageRange
}

export interface CrossoverCardMeta {
  name?: string
  // Never leave this empty -- Actual's crossover projection zeroes out historical expense data
  // entirely when this array is empty, which makes the widget silently claim "already FI" with
  // $0/month of expenses. Always populate with every real (non-income, non-hidden) category id.
  expenseCategoryIds: string[]
  // Despite the name, this is NOT "accounts that receive income" -- it's the set of accounts
  // whose combined balance is treated as the investable portfolio a safe withdrawal rate is
  // computed against. Must be exactly the portfolio accounts (retirement/HSA/investment-taxable),
  // never debt or everyday cash accounts -- see portfolioAccountIds below.
  incomeAccountIds: string[]
  safeWithdrawalRate: number
  estimatedReturn: number | null
  expectedContribution: number | null
  projectionType: "hampel" | "median" | "mean"
  expenseAdjustmentFactor: number
}

export type FireWidgetType = "net-worth-card" | "spending-card" | "crossover-card" | "monte-carlo-card"

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

// Function to build the net-worth-card widget. Deliberately no account filter: an unfiltered net
// worth (meta.conditions omitted) is a valid Actual default -- its own DEFAULT_DASHBOARD_STATE
// uses exactly this for the same widget -- and true net worth across every account is what a FIRE
// dashboard wants.
export function buildNetWorthWidget(x: number, y: number): ExportImportDashboardWidget<NetWorthCardMeta> {
  return { type: "net-worth-card", x, y, width: 6, height: 2, meta: { name: "Net Worth", mode: "trend" } }
}

// Function to build the spending-card widget, showing the trailing-12-month average -- the same
// spend history this tool's report-fire CLI uses for its own sanity-check numbers, shown here for
// visual cross-checking against the crossover-card.
export function buildSpendingWidget(x: number, y: number): ExportImportDashboardWidget<SpendingCardMeta> {
  return {
    type: "spending-card",
    x,
    y,
    width: 6,
    height: 2,
    meta: { name: "Trailing 12-Month Spending", mode: "average", averageRange: { mode: "last-n-months", months: 12 } },
  }
}

// Function to build the crossover-card widget -- the FIRE date/nest-egg projection. Field
// defaults match Actual's own UI defaults for this widget: safeWithdrawalRate 0.04 (the "4% rule"),
// estimatedReturn null (Actual computes a live historical CAGR itself, safer than a guessed
// constant), expectedContribution null, projectionType "hampel", expenseAdjustmentFactor 1.0.
export function buildCrossoverWidget(
  x: number,
  y: number,
  expenseCategoryIds: string[],
  portfolioAccountIds: string[],
): ExportImportDashboardWidget<CrossoverCardMeta> {
  return {
    type: "crossover-card",
    x,
    y,
    width: 12,
    height: 4,
    meta: {
      name: "FIRE Crossover",
      expenseCategoryIds,
      incomeAccountIds: portfolioAccountIds,
      safeWithdrawalRate: 0.04,
      estimatedReturn: null,
      expectedContribution: null,
      projectionType: "hampel",
      expenseAdjustmentFactor: 1.0,
    },
  }
}

// Function to pick which classified accounts count as "the portfolio" for the crossover-card's
// incomeAccountIds -- see fire-accounts.ts's portfolioAccounts/isPortfolioCategory for which
// categories qualify (debt, cash, and other never do).
export function portfolioAccountIds(accounts: readonly ClassifiedAccount[]): string[] {
  return portfolioAccounts(accounts).map((account) => account.id)
}

// Function to assemble the full three-widget FIRE dashboard on Actual's 12-column grid: net worth
// and spending side by side on the first row, crossover full-width on the row below.
export function buildFireDashboard(nonIncomeCategoryIds: string[], accountIds: string[]): ExportImportDashboard {
  return {
    version: 1,
    widgets: [buildNetWorthWidget(0, 0), buildSpendingWidget(6, 0), buildCrossoverWidget(0, 2, nonIncomeCategoryIds, accountIds)],
  }
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
  allocationPreset?: MonteCarloAllocationPreset
  // allocationPreset only auto-fills these in Actual's own UI -- the simulation itself reads these
  // numeric fields directly, so both must be set explicitly or the pot silently uses some other
  // default regardless of the preset label. See ALLOCATION_PRESET_RETURNS below.
  expectedReturnMean?: number
  returnStdDev?: number
  accessAge?: number | null
  // Flat tax model: effective tax rate on withdrawals from this pot (0.15 = 15%).
  withdrawalTaxRate?: number
}

export interface MonteCarloSpendingPhaseMeta {
  id: string
  name?: string
  fromAge?: number | null
  annualWithdrawal?: number
}

export type MonteCarloWithdrawalStrategy = "proportional" | "sequential" | "best-performer" | "target-mix"
export type MonteCarloTaxModel = "flat" | "bands"

export interface MonteCarloCardMeta {
  name?: string
  pots?: MonteCarloPotMeta[]
  withdrawalStrategy?: MonteCarloWithdrawalStrategy
  spendingPhases?: MonteCarloSpendingPhaseMeta[]
  // Mean yearly inflation as a decimal fraction (0.03 = 3%); null = flat, uninflated withdrawals.
  inflationMean?: number | null
  taxModel?: MonteCarloTaxModel
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

// Flat-model effective withdrawal tax rate per tax treatment. Deliberately rough, user-owned
// estimates (matching Actual's own docs: "you own the number") -- tax-deferred withdrawals are
// ordinary income (a common marginal-bracket estimate), taxable-investment withdrawals are mostly
// long-term capital gains (typically taxed lower), tax-free/none pay nothing.
const WITHDRAWAL_TAX_RATES: Record<TaxTreatment, number> = {
  "tax-deferred": 0.22,
  taxable: 0.15,
  "tax-free": 0,
  none: 0,
}

// Function to build one Monte Carlo pot from a portfolio account. Requires a non-null
// allocationPreset -- every portfolio-category account gets one by default (see
// fire-accounts.ts's CATEGORY_TRAITS), so a null here means an incomplete override; callers should
// catch that before reaching this function (see buildMonteCarloWidget).
export function buildPot(account: ClassifiedAccount & { allocationPreset: MonteCarloAllocationPreset }): MonteCarloPotMeta {
  const { mean, stdDev } = ALLOCATION_PRESET_RETURNS[account.allocationPreset]
  return {
    id: account.id,
    name: account.name,
    accountId: account.id,
    allocationPreset: account.allocationPreset,
    expectedReturnMean: mean,
    returnStdDev: stdDev,
    accessAge: account.accessAge,
    withdrawalTaxRate: WITHDRAWAL_TAX_RATES[account.taxTreatment],
  }
}

// Function to build the plan's spending phases from a real trailing-spend figure -- the same
// annual spend already computed for the crossover widget's console sanity check, not a separate
// guess. A single spending phase's `fromAge` is a no-op in Actual's own simulation engine (its
// per-year loop always falls back to the earliest phase's amount before checking any fromAge), so
// a future retirement age only has an effect if modeled as TWO phases: $0 while accumulating, then
// the real spend once retirementAge is reached. Already retired (or retiring today) collapses back
// to the single always-on phase.
export function buildSpendingPhases(currentAge: number, retirementAge: number, annualSpendCents: number): MonteCarloSpendingPhaseMeta[] {
  if (retirementAge <= currentAge) {
    return [{ id: "retirement-spending", name: "Retirement spending", fromAge: null, annualWithdrawal: annualSpendCents }]
  }
  return [
    { id: "pre-retirement", name: "Pre-retirement", fromAge: null, annualWithdrawal: 0 },
    { id: "retirement-spending", name: "Retirement spending", fromAge: retirementAge, annualWithdrawal: annualSpendCents },
  ]
}

export const MONTE_CARLO_WIDGET_HEIGHT = 4

// Function to build one monte-carlo-card widget: one pot per portfolio account (linked to its live
// balance), spending phases split around the retirement age, and a flat tax model. Everything else
// (return model, withdrawal rule, contributions, simulation count) is left unset so Actual's own UI
// defaults apply once the widget is opened -- this only sets what Actual can't infer on its own
// (account-linked pots, real spending, the plan's age window).
export function buildMonteCarloWidget(
  x: number,
  y: number,
  accounts: readonly ClassifiedAccount[],
  currentAge: number,
  retirementAge: number,
  targetAge: number,
  annualSpendCents: number,
  name = "Monte Carlo",
): ExportImportDashboardWidget<MonteCarloCardMeta> {
  const eligibleAccounts = portfolioAccounts(accounts)
  const missingPreset = eligibleAccounts.find((account) => account.allocationPreset === null)
  if (missingPreset) {
    throw new Error(
      `"${missingPreset.name}" has no allocationPreset set -- run ./actual accounts classify again to set one.`,
    )
  }

  const pots = eligibleAccounts.map((account) => buildPot(account as ClassifiedAccount & { allocationPreset: MonteCarloAllocationPreset }))

  return {
    type: "monte-carlo-card",
    x,
    y,
    width: 12,
    height: MONTE_CARLO_WIDGET_HEIGHT,
    meta: {
      name,
      pots,
      withdrawalStrategy: "proportional",
      spendingPhases: buildSpendingPhases(currentAge, retirementAge, annualSpendCents),
      inflationMean: 0.03,
      taxModel: "flat",
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
      name,
    )
  })
}
