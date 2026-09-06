import { portfolioAccounts } from "./fire-accounts.ts"
import type { ClassifiedAccount, FireConfig, MonteCarloAllocationPreset, TaxTreatment } from "./fire-accounts.ts"

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

export type CrossoverProjectionType = "hampel" | "median" | "mean"

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
  projectionType: CrossoverProjectionType
  expenseAdjustmentFactor: number
  showHiddenCategories?: boolean
}

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

// The crossover assumptions a person can configure (./actual configure) instead of this module
// hardcoding them. Shape matches CrossoverCardMeta's own configurable fields exactly.
export interface CrossoverAssumptions {
  safeWithdrawalRate: number
  estimatedReturn: number | null
  projectionType: CrossoverProjectionType
  expenseAdjustmentFactor: number
  showHiddenCategories: boolean
}

// Function to build the crossover-card widget -- the FIRE date/nest-egg projection.
// expectedContributionCents is a MONTHLY figure in cents (confirmed against Actual's own
// Crossover.tsx, which divides this same field by 100 to show it as dollars) -- see
// totalMonthlyContribution below for how it's summed from real per-account answers.
export function buildCrossoverWidget(
  x: number,
  y: number,
  expenseCategoryIds: string[],
  portfolioAccountIds: string[],
  assumptions: CrossoverAssumptions,
  expectedContributionCents: number | null,
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
      safeWithdrawalRate: assumptions.safeWithdrawalRate,
      estimatedReturn: assumptions.estimatedReturn,
      expectedContribution: expectedContributionCents,
      projectionType: assumptions.projectionType,
      expenseAdjustmentFactor: assumptions.expenseAdjustmentFactor,
      showHiddenCategories: assumptions.showHiddenCategories,
    },
  }
}

// Function to pick which classified accounts count as "the portfolio" for the crossover-card's
// incomeAccountIds -- see fire-accounts.ts's portfolioAccounts/isPortfolioCategory for which
// categories qualify (debt, cash, and other never do).
export function portfolioAccountIds(accounts: readonly ClassifiedAccount[]): string[] {
  return portfolioAccounts(accounts).map((account) => account.id)
}

// Function to sum monthly contributions across portfolio accounts -- the same population
// buildMonteCarloWidget draws pots/contributions from -- into crossover's single flat
// expectedContribution figure. Returns null (not 0) when nothing is configured, matching Actual's
// own "unset" convention for this field.
export function totalMonthlyContribution(accounts: readonly ClassifiedAccount[]): number | null {
  const total = portfolioAccounts(accounts).reduce((sum, account) => sum + (account.monthlyContribution ?? 0), 0)
  return total > 0 ? total : null
}

// Function to assemble the base FIRE dashboard on Actual's 12-column grid: net worth full-width on
// the first row, crossover full-width on the row below.
export function buildFireDashboard(
  nonIncomeCategoryIds: string[],
  accountIds: string[],
  crossoverAssumptions: CrossoverAssumptions,
  expectedContributionCents: number | null,
): ExportImportDashboard {
  return {
    version: 1,
    widgets: [
      buildNetWorthWidget(0, 0),
      buildCrossoverWidget(0, 2, nonIncomeCategoryIds, accountIds, crossoverAssumptions, expectedContributionCents),
    ],
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
export type MonteCarloReturnModel = "normal" | "historical-bootstrap" | "historical-sequence"
export type MonteCarloWithdrawalRuleType = "none" | "guardrails" | "ratcheting" | "floor-ceiling" | "boundaries"

// Parameters for every rule type are kept side by side (all optional) so switching between rules
// preserves each rule's own settings, matching Actual's own MonteCarloWithdrawalRuleMeta shape.
export interface MonteCarloWithdrawalRuleMeta {
  type: MonteCarloWithdrawalRuleType
  // Guardrails (Guyton-Klinger)
  prosperityTriggerPct?: number
  prosperityIncreasePct?: number
  preservationTriggerPct?: number
  preservationCutPct?: number
  // Ratcheting (Kitces)
  balanceThresholdMultiple?: number
  consecutiveYears?: number
  ratchetIncreasePct?: number
  // Floor & ceiling (Bengen)
  floorPct?: number
  ceilingPct?: number
  // Boundaries
  upperRateThreshold?: number
  upperCutPct?: number
  lowerRateThreshold?: number
  lowerIncreasePct?: number
}

export interface MonteCarloTaxBandMeta {
  id: string
  from?: number
  rate?: number
}

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

// Function to compute a pot's effective access age, applying Rule of 55 when it's earlier than the
// category default. IRS Code Sec. 72(t)(2)(A)(v): separating from an employer during or after the
// calendar year you turn 55 lets you withdraw penalty-free from THAT employer's own 401(k)/403(b)
// starting immediately -- so this only takes effect at 55+ (the exception's own floor); a
// separation age below 55 doesn't qualify at all, and the normal accessAge (59, or null) stands.
// account.ruleOf55SeparationAge itself asserts eligibility (a real, currently-held employer plan,
// never an IRA) -- see fire-accounts.ts's ClassifiedAccount for why there's no separate flag.
export function effectiveAccessAge(account: Pick<ClassifiedAccount, "accessAge" | "ruleOf55SeparationAge">): number | null {
  if (account.ruleOf55SeparationAge != null && account.ruleOf55SeparationAge >= 55) {
    return account.accessAge == null ? account.ruleOf55SeparationAge : Math.min(account.accessAge, account.ruleOf55SeparationAge)
  }
  return account.accessAge
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
    accessAge: effectiveAccessAge(account),
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

// Function to build one recurring-contribution entry per portfolio account with a nonzero monthly
// contribution. annualAmount is the monthly figure (cents) x12 -- see totalMonthlyContribution's
// doc comment for why the monthly figure itself needs no further conversion for the crossover
// widget's sibling field.
function buildContributions(accounts: readonly ClassifiedAccount[]): MonteCarloContributionMeta[] {
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
      toAge: null,
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
): ExportImportDashboardWidget<MonteCarloCardMeta> {
  const eligibleAccounts = portfolioAccounts(accounts)
  const missingPreset = eligibleAccounts.find((account) => account.allocationPreset === null)
  if (missingPreset) {
    throw new Error(
      `"${missingPreset.name}" has no allocationPreset set -- run ./actual configure again to set one.`,
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
      withdrawalStrategy: assumptions.withdrawalStrategy,
      returnModel: assumptions.returnModel,
      withdrawalRule: assumptions.withdrawalRule,
      minimumWithdrawal: assumptions.minimumWithdrawal,
      spendingPhases: buildSpendingPhases(currentAge, retirementAge, annualSpendCents),
      contributions: buildContributions(eligibleAccounts),
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
// refreshed (fromAge/annualWithdrawal come straight from the current retirement age and trailing
// spend), so a stale one (e.g. "pre-retirement" left over from a since-removed future retirement
// age) is dropped rather than carried forward. Any other phase id is untouched, hand-added content.
const OWNED_SPENDING_PHASE_IDS = new Set(["pre-retirement", "retirement-spending"])

function mergeSpendingPhases(generatedPhases: MonteCarloSpendingPhaseMeta[], existingPhasesRaw: unknown): MonteCarloSpendingPhaseMeta[] {
  const existingPhases = Array.isArray(existingPhasesRaw) ? (existingPhasesRaw as MonteCarloSpendingPhaseMeta[]) : []
  const extraPhases = existingPhases.filter((phase) => !OWNED_SPENDING_PHASE_IDS.has(phase?.id))
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
// simulationCount, taxBands, ...) is preserved from the existing file when present.
function mergeMonteCarloMeta(generatedMeta: Record<string, unknown>, existingMeta: Record<string, unknown>): Record<string, unknown> {
  return {
    ...generatedMeta,
    ...existingMeta,
    name: generatedMeta.name,
    currentAge: generatedMeta.currentAge,
    targetAge: generatedMeta.targetAge,
    pots: mergePots(generatedMeta.pots as MonteCarloPotMeta[], existingMeta.pots),
    spendingPhases: mergeSpendingPhases(generatedMeta.spendingPhases as MonteCarloSpendingPhaseMeta[], existingMeta.spendingPhases),
    contributions: mergeContributions(generatedMeta.contributions as MonteCarloContributionMeta[], existingMeta.contributions),
  }
}

// Function to merge one freshly generated widget with its match (if any) from an existing file.
// Layout (x/y/width/height) always comes from the fresh generation, since it's a function of how
// many widgets this run produces, not something meaningful to hand-tune in the file.
function mergeWidget(generated: ExportImportDashboardWidget, existingWidget: ExistingDashboardWidget | undefined): ExportImportDashboardWidget {
  if (existingWidget?.meta == null || generated.meta === null) {
    return generated
  }
  const generatedMeta = generated.meta as Record<string, unknown>
  const existingMeta = existingWidget.meta
  let meta: Record<string, unknown>
  if (generated.type === "monte-carlo-card") {
    meta = mergeMonteCarloMeta(generatedMeta, existingMeta)
  } else if (generated.type === "crossover-card") {
    // expenseCategoryIds/incomeAccountIds are real data (see buildCrossoverWidget); every other
    // field (safeWithdrawalRate, estimatedReturn, projectionType, ...) is a preservable assumption.
    meta = { ...generatedMeta, ...existingMeta, expenseCategoryIds: generatedMeta.expenseCategoryIds, incomeAccountIds: generatedMeta.incomeAccountIds }
  } else {
    // net-worth-card has no real-data fields at all -- an existing customization wins outright.
    meta = { ...generatedMeta, ...existingMeta }
  }
  return { ...generated, meta }
}

// Function to merge a freshly generated dashboard with the one already on disk, if any: preserves
// any customization to a still-generated widget (see mergeWidget), drops a generated-type widget
// that's no longer produced this run (e.g. a removed retirement age), and carries through untouched
// any widget whose type this tool has never generated (hand-added content, never this tool's to
// manage). Pass `existing: null` for a first run / no file yet -- returns `generated` unchanged.
export function mergeGeneratedDashboard(generated: ExportImportDashboard, existing: ExistingDashboard | null): ExportImportDashboard {
  if (existing === null) {
    return generated
  }
  const existingByKey = new Map(existing.widgets.map((widget) => [widgetKey(widget), widget]))
  const widgets = generated.widgets.map((widget) => mergeWidget(widget, existingByKey.get(widgetKey(widget))))
  const foreignWidgets = existing.widgets.filter((widget) => !OWNED_WIDGET_TYPES.includes(widget.type as FireWidgetType))
  return { version: generated.version, widgets: [...widgets, ...(foreignWidgets as ExportImportDashboardWidget[])] }
}

// --- Extracting configurable assumptions back out of an existing dashboard file (the mirror
// direction of mergeGeneratedDashboard, config -> dashboard) ---
//
// A person may tweak an assumption post-import in Actual's own Monte Carlo/crossover configuration
// UI and copy the resulting file back; ./actual configure uses this to pick that change up into
// config.json rather than silently discarding it the next time it asks its own questions.

function isNumber(value: unknown): value is number {
  return typeof value === "number"
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number"
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

// Function to read one field off an untrusted meta object, falling back when it's missing or the
// wrong JS type -- exact enum-membership validation happens later, when config.json is next read
// back via loadFireConfig, matching this file's existing merge functions' level of defensiveness.
function readField<T>(meta: Record<string, unknown>, key: string, isValid: (value: unknown) => value is T, fallback: T): T {
  const value = meta[key]
  return isValid(value) ? value : fallback
}

function extractCrossoverAssumptions(meta: Record<string, unknown>, fallback: CrossoverAssumptions): CrossoverAssumptions {
  return {
    safeWithdrawalRate: readField(meta, "safeWithdrawalRate", isNumber, fallback.safeWithdrawalRate),
    estimatedReturn: readField(meta, "estimatedReturn", isNumberOrNull, fallback.estimatedReturn),
    projectionType: readField(meta, "projectionType", isString, fallback.projectionType) as CrossoverProjectionType,
    expenseAdjustmentFactor: readField(meta, "expenseAdjustmentFactor", isNumber, fallback.expenseAdjustmentFactor),
    showHiddenCategories: readField(meta, "showHiddenCategories", isBoolean, fallback.showHiddenCategories),
  }
}

function extractMonteCarloAssumptions(meta: Record<string, unknown>, fallback: MonteCarloAssumptions): MonteCarloAssumptions {
  const withdrawalRuleRaw = meta.withdrawalRule
  const withdrawalRule =
    withdrawalRuleRaw && typeof withdrawalRuleRaw === "object" && isString((withdrawalRuleRaw as Record<string, unknown>).type)
      ? (withdrawalRuleRaw as MonteCarloWithdrawalRuleMeta)
      : fallback.withdrawalRule
  const taxBandsRaw = meta.taxBands
  const taxBands = Array.isArray(taxBandsRaw) ? (taxBandsRaw as MonteCarloTaxBandMeta[]) : fallback.taxBands

  return {
    withdrawalStrategy: readField(meta, "withdrawalStrategy", isString, fallback.withdrawalStrategy) as MonteCarloWithdrawalStrategy,
    returnModel: readField(meta, "returnModel", isString, fallback.returnModel) as MonteCarloReturnModel,
    withdrawalRule,
    minimumWithdrawal: readField(meta, "minimumWithdrawal", isNumber, fallback.minimumWithdrawal),
    inflationMean: readField(meta, "inflationMean", isNumberOrNull, fallback.inflationMean),
    inflationStdDev: readField(meta, "inflationStdDev", isNumber, fallback.inflationStdDev),
    taxModel: readField(meta, "taxModel", isString, fallback.taxModel) as MonteCarloTaxModel,
    taxBands,
    simulationCount: readField(meta, "simulationCount", isNumber, fallback.simulationCount),
  }
}

// Function to reconstruct the retirement age a single monte-carlo-card widget represents, from its
// own "retirement-spending" spending phase (see buildSpendingPhases) -- a null fromAge means
// already-retired, i.e. the widget's own currentAge.
function retirementAgeFromWidget(meta: Record<string, unknown>): number | null {
  const phases = meta.spendingPhases
  if (!Array.isArray(phases)) {
    return null
  }
  const phase = (phases as MonteCarloSpendingPhaseMeta[]).find((candidate) => candidate?.id === "retirement-spending")
  if (!phase) {
    return null
  }
  if (phase.fromAge != null) {
    return phase.fromAge
  }
  return isNumber(meta.currentAge) ? meta.currentAge : null
}

// Function to read one monte-carlo-card widget's contributions back into the matching account
// overrides' monthlyContribution (cents/month, the inverse of buildContributions' x12). Only
// touches overrides that already exist in `accounts` -- an account with no override yet is left
// alone, since extraction never invents new account classifications.
function applyContributions(meta: Record<string, unknown>, accounts: FireConfig["accounts"]): FireConfig["accounts"] {
  const contributionsRaw = meta.contributions
  if (!Array.isArray(contributionsRaw)) {
    return accounts
  }
  const monthlyByPotId = new Map<string, number>()
  for (const contribution of contributionsRaw as MonteCarloContributionMeta[]) {
    if (typeof contribution?.potId === "string" && isNumber(contribution.annualAmount)) {
      monthlyByPotId.set(contribution.potId, Math.round(contribution.annualAmount / 12))
    }
  }
  if (monthlyByPotId.size === 0) {
    return accounts
  }
  return accounts.map((override) => {
    const monthlyContribution = monthlyByPotId.get(override.match)
    return monthlyContribution === undefined ? override : { ...override, monthlyContribution }
  })
}

// Function to extract configurable assumptions back out of an existing dashboard file into a
// config -- the mirror of mergeGeneratedDashboard's direction (config -> dashboard). Used by
// ./actual configure to pick up a change made post-import in Actual's own configuration UI (copied
// back into the file), rather than silently overwriting it the next time it asks its own
// questions. Never touches birthDate, planToAge, or any account's category/taxTreatment/
// accessAge/allocationPreset -- those are sourced from real account/user input, never the
// dashboard. A dashboard with no crossover-card/monte-carlo-card widget leaves the corresponding
// config section untouched.
export function extractConfigFromDashboard(existing: ExistingDashboard, config: FireConfig): FireConfig {
  const crossoverWidget = existing.widgets.find((widget) => widget.type === "crossover-card")
  const monteCarloWidgets = existing.widgets.filter((widget) => widget.type === "monte-carlo-card")

  const crossover = crossoverWidget?.meta ? extractCrossoverAssumptions(crossoverWidget.meta, config.crossover) : config.crossover

  // All Monte Carlo widgets share one set of assumptions in this tool's own generated files (see
  // buildMonteCarloWidgets); if only one was hand-edited, there's no way to reconcile a
  // disagreement, so the first one found wins, same as any other "pick one" ambiguity here.
  const firstMonteCarloMeta = monteCarloWidgets[0]?.meta
  const monteCarlo = firstMonteCarloMeta ? extractMonteCarloAssumptions(firstMonteCarloMeta, config.monteCarlo) : config.monteCarlo

  const retirementAges = [
    ...new Set(
      monteCarloWidgets
        .map((widget) => (widget.meta ? retirementAgeFromWidget(widget.meta) : null))
        .filter((age): age is number => age !== null),
    ),
  ]

  let accounts = config.accounts
  for (const widget of monteCarloWidgets) {
    if (widget.meta) {
      accounts = applyContributions(widget.meta, accounts)
    }
  }

  return {
    ...config,
    crossover,
    monteCarlo,
    dashboard: { ...config.dashboard, retirementAges: retirementAges.length > 0 ? retirementAges : config.dashboard.retirementAges },
    accounts,
  }
}
