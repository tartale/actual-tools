import { fetchCategoryGroups, fetchDashboardWidgets, fetchHistoricalSpent, formatError } from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import type { AccountDataSource } from "./account-data-source.ts"
import type { ClassifiedAccount, ExpenseAdjustment, ExpenseProjectionType } from "./fire-accounts.ts"
import { categoryIdFromName, transactionCutoff } from "./file-account-data-source.ts"
import type { FileTransactionRow } from "./file-account-data-source.ts"
import { effectiveAccessAge, portfolioAccountIds } from "./fire-dashboard.ts"
import type { MonteCarloAssumptions, MonteCarloCardMeta, RetirementIncomeStream } from "./fire-dashboard.ts"
import {
  bridgeFinding,
  calculateMortgagePayoff,
  historicalBridgeYear,
  magiFinding,
  monteCarloFinding,
  projectAccountBalance,
  simulateBridge,
  toBridgeAccounts,
} from "./fire-analysis.ts"
import type { BridgeResult, Finding } from "./fire-analysis.ts"
import { runRetirementMonteCarlo } from "./fire-monte-carlo.ts"
import type { MonteCarloResultEntry, MonteCarloSummary } from "./fire-monte-carlo.ts"
import { estimateMagi } from "./federal-tax-brackets.ts"
import type { FederalTaxBrackets, FilingStatus } from "./federal-tax-brackets.ts"
import { federalPovertyGuideline } from "./federal-poverty-guidelines.ts"
import type { FederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"

// The non-CLI guts of what used to be reports-fire.ts's main(): fetching real data and analyzing
// the dashboard, returning a plain structured result rather than printing one -- consumed by
// app-server.ts's /api/retirement/check route, and directly unit-testable without capturing
// stdout. (Used to also build and write a fresh dashboard for Export to Dashboard -- removed
// entirely, along with the drift-detection findings that only existed to nudge a re-export.)

// Function to get the current month as a yyyy-mm string
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// The "Expense Projection Type" statistic (mean/median/hampel) that collapses a trailing window of
// monthly spend totals into the one flat figure Bridge/Monte Carlo/MAGI project forward -- see
// ExpenseProjectionType's own doc comment in fire-accounts.ts. Ported from Actual's own
// crossover-spreadsheet.ts (MIT-licensed, same vendoring precedent as fire-monte-carlo.ts's
// simulation engine) so "Hampel Filtered Median" means exactly what it did there, not a
// reinvented approximation -- constants (1.4826, the MAD->stddev scale factor for a normal
// distribution; 3, the outlier threshold) are Actual's own, unchanged.
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// The Hampel identifier: a value counts as an outlier once it's more than `threshold` scaled
// median-absolute-deviations (MAD) from the median, and is filtered out before the final median.
function hampelFilteredMedian(values: readonly number[]): number {
  if (values.length <= 1) return values[0] ?? 0
  const med = median(values)
  const mad = median(values.map((value) => Math.abs(value - med)))
  const threshold = 1.4826 * mad * 3
  const filtered = values.filter((value) => value >= med - threshold && value <= med + threshold)
  return median(filtered)
}

export function projectMonthlyExpense(monthlyValues: readonly number[], projectionType: ExpenseProjectionType): number {
  switch (projectionType) {
    case "median":
      return median(monthlyValues)
    case "hampel":
      return hampelFilteredMedian(monthlyValues)
    case "mean":
      return mean(monthlyValues)
  }
}

const EXPENSE_PROJECTION_TYPE_LABELS: Record<ExpenseProjectionType, string> = {
  mean: "mean",
  median: "median",
  hampel: "Hampel filtered median",
}

// Function to build one combined monthly-total series across every given category -- summed PER
// MONTH across categories, not per-category-then-summed, the same shape Actual's own crossover
// widget builds its own series from. Only that shape lets a non-linear statistic (median, hampel)
// mean the same thing regardless of how many categories are selected -- for "mean" specifically
// this is mathematically identical to summing each category's own separate average (linearity of
// expectation over the same-length window for every category), so an untouched plan's numbers
// never move.
async function monthlySpendSeries(config: ActualConfig, categoryIds: readonly string[], historyMonths: number): Promise<number[]> {
  const month = currentMonth()
  const monthCache = new Map<string, CategoryMonth[]>()
  const combined = new Array<number>(historyMonths).fill(0)
  for (const categoryId of categoryIds) {
    const history = await fetchHistoricalSpent(config, categoryId, month, historyMonths, monthCache)
    history.forEach((spent, index) => {
      combined[index] = (combined[index] as number) + -spent
    })
  }
  return combined
}

// Function to sum the trailing-N-month spend across every given category into one flat monthly
// figure (per the person's own ExpenseProjectionType choice), then annualize it -- N is
// historyMonths, a Plan-section-tunable setting (see fire-dashboard.ts's
// spendHistoryMonthsWithOverride), not a fixed constant.
async function trailingAnnualSpend(config: ActualConfig, categoryIds: readonly string[], historyMonths: number, projectionType: ExpenseProjectionType): Promise<number> {
  const series = await monthlySpendSeries(config, categoryIds, historyMonths)
  return projectMonthlyExpense(series, projectionType) * 12
}

// Function to compute annual spend from the Plan section's own expense-category selection --
// entirely local: this app never reads a live Actual crossover widget's own checklist or date
// range to derive spend (it used to, as a fallback for someone who'd configured that widget by
// hand before ever touching the Plan section here; removed once every real workflow this app cares
// about starts and stays in the Plan section, so an unset selection is just "every category," not
// "go check what's live in Actual"). A null selection (never customized) or one that intersects to
// nothing (every previously-selected id has since been deleted or hidden) both fall back to
// allExpenseCategoryIds the same way -- basis stays null for either, since neither one reflects an
// actual choice worth describing in text, even though the number itself is still real and used.
async function spendFromLocalSelection(
  config: ActualConfig,
  allExpenseCategoryIds: readonly string[],
  selection: readonly string[] | null,
  adjustmentFactor: number,
  historyMonths: number,
  projectionType: ExpenseProjectionType,
): Promise<{ annualSpend: number; basis: string | null }> {
  const categoryIds = selection?.filter((id) => allExpenseCategoryIds.includes(id)) ?? []
  if (categoryIds.length === 0) {
    const annualSpend = Math.round(await trailingAnnualSpend(config, allExpenseCategoryIds, historyMonths, projectionType))
    return { annualSpend, basis: null }
  }
  const annualSpend = Math.round((await trailingAnnualSpend(config, categoryIds, historyMonths, projectionType)) * adjustmentFactor)
  const basis =
    `${categoryIds.length} categories over ${historyMonths} months to ${currentMonth()} (Plan section selection)` +
    (projectionType === "mean" ? "" : ` (${EXPENSE_PROJECTION_TYPE_LABELS[projectionType]})`) +
    (adjustmentFactor === 1 ? "" : `, × ${Math.round(adjustmentFactor * 100)}% target income`)
  return { annualSpend, basis }
}

// Function to compute annual spend from a file-mode transactions import -- the local-data
// counterpart to spendFromLocalSelection above, for a plan with no live Actual connection to fetch
// category history from at all (see checkDashboard's own doc comment on the file-mode spend-source
// precedence). Trailing historyMonths ending at today's real calendar month, same "as of right now"
// meaning trailingAnnualSpend itself uses. Every qualifying row's amount is NETTED (summed, sign
// and all, then negated), not just outflow rows summed on their own -- a positive-amount row inside
// a real spending category is a refund/return, and Actual's own "spent" figure nets those against
// the same category's outflows rather than ignoring them; discarding them outright (an earlier
// version of this function did exactly that) systematically overcounts spend for any category with
// legitimate refunds mixed in -- found live (2026-09-21) comparing this figure against Actual's own
// real "spent" total for the same household, about $51K/yr of the gap between them.
//
// Two exclusions, found against a REAL export (2026-09-21) that blew this up to $1.4M/yr without
// them:
//   1. An empty Category_Group or Category is never counted -- confirmed against real data these
//      are transfers between the person's own accounts (both a negative AND positive row for the
//      same dollars, net-zero for the household) and split-transaction parent rows (the real
//      amount lives on each split CHILD row instead -- see parseTransactionRows's own doc comment).
//      Neither is real household spend.
//   2. Everything else needs the SAME selection this app already applies in Actual mode
//      (crossoverExpenseCategoryIds, via spendFromLocalSelection above) -- without it, categories
//      like retirement/investment contributions ("Long-Term Savings," in the real export this was
//      found against) get summed as if they were spend too. selection is a list of
//      categoryIdFromName ids (file-account-data-source.ts) -- null or empty-after-filtering-to-
//      known-ids falls back to every non-empty-category row, the SAME "no real choice made yet"
//      convention spendFromLocalSelection itself uses (not "count everything," now that empty
//      categories are already excluded by (1) -- categorized savings/investment rows still need an
//      explicit selection to be excluded, there's no heuristic this function could apply on its own
//      to guess which category names mean "not spend" for an arbitrary person's own naming).
//
// Returns annualSpend: 0 (never null/negative) when nothing in the trailing window qualifies -- the
// caller (checkDashboard) falls back to the flat manual fileModeAnnualExpense whenever this comes
// back 0, same as it would for a freshly-imported transactions file with no spend recorded yet.
export function annualSpendFromTransactions(
  rows: readonly FileTransactionRow[],
  historyMonths: number,
  adjustmentFactor: number,
  selection: readonly string[] | null,
  projectionType: ExpenseProjectionType = "mean",
): { annualSpend: number; basis: string | null } {
  const asOfMonth = currentMonth()
  // Shared with categoryGroupsFromTransactions (file-account-data-source.ts) -- see its own doc
  // comment on why the picker needs the identical window this spend figure is computed from.
  const cutoff = transactionCutoff(historyMonths)
  // crossoverExpenseCategoryIds is the SAME plan field Actual mode's own spendFromLocalSelection
  // uses, but the ids it holds are mode-specific -- Actual's own real category UUIDs there, this
  // file's own categoryIdFromName ids here. Switching from Actual mode (where a selection was
  // already made) into file mode would otherwise inherit a selection that matches NOTHING here,
  // silently zeroing every row out rather than falling back sensibly -- confirmed live (2026-09-21)
  // against a real plan that had done exactly that. Filtering to only ids this file's own rows
  // actually produce, the same safety net spendFromLocalSelection already applies for its own
  // stale-selection case, fixes it: an all-stale selection filters down to empty, which falls back
  // to "every category" below, same as a selection that was simply never customized.
  const allCategoryIds = new Set(rows.filter((row) => row.categoryGroup !== "" && row.category !== "" && row.categoryGroup.toLowerCase() !== "income").map((row) => categoryIdFromName(row.categoryGroup, row.category)))
  const filteredSelection = selection?.filter((id) => allCategoryIds.has(id)) ?? []
  const selectedIds = filteredSelection.length > 0 ? new Set(filteredSelection) : null
  let totalSpent = 0
  // Only built/used for "median"/"hampel" (see below) -- bucketed by real calendar month (however
  // many distinct months actually fall in the window, including a partial current one), the same
  // shape Actual's own crossover-spreadsheet.ts builds its own per-month series from, so those two
  // projection types mean the same thing here they did there. "mean" deliberately keeps the
  // original plain totalSpent/historyMonths formula below instead of mean-of-these-buckets --
  // they're mathematically different whenever the window doesn't divide into whole calendar months
  // (a partial current month), and the original formula is what every existing plan's numbers
  // already assume, so it must stay bit-for-bit unchanged when projectionType is "mean" (the
  // default/null case).
  const monthlyTotals = new Map<string, number>()
  for (const row of rows) {
    // "Income" itself excluded by name (case-insensitive, same as categoryGroupsFromTransactions'
    // own is_income heuristic) -- a real export can have NEGATIVE rows under Income (a refund
    // clawback, a reversal, an accounting adjustment), which are still about tracking income, not
    // household spend, however they're signed. No sign check here otherwise -- a positive row in a
    // real spending category nets against that category's own outflows (see this function's own
    // doc comment), it isn't dropped.
    if (row.categoryGroup === "" || row.category === "" || row.categoryGroup.toLowerCase() === "income") continue
    const categoryId = categoryIdFromName(row.categoryGroup, row.category)
    if (selectedIds != null && !selectedIds.has(categoryId)) continue
    const date = new Date(row.date)
    if (Number.isNaN(date.getTime()) || date < cutoff) continue
    const netted = -row.amount
    totalSpent += netted
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
    monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) ?? 0) + netted)
  }
  const monthlyFigure = projectionType === "mean" ? totalSpent / historyMonths : projectMonthlyExpense([...monthlyTotals.values()], projectionType)
  // <= 0, not just === 0 -- refunds/returns netted against a short window's outflows (see this
  // function's own doc comment) could in principle net out to a negative total, which would
  // otherwise annualize to a nonsensical negative "spend."
  if (monthlyFigure <= 0) {
    return { annualSpend: 0, basis: null }
  }
  const annualSpend = Math.round(monthlyFigure * 12 * adjustmentFactor)
  const basis =
    (selectedIds != null ? `${selectedIds.size} categories` : "imported transaction file") +
    `, trailing ${historyMonths} months to ${asOfMonth}` +
    (projectionType === "mean" ? "" : ` (${EXPENSE_PROJECTION_TYPE_LABELS[projectionType]})`) +
    (adjustmentFactor === 1 ? "" : `, × ${Math.round(adjustmentFactor * 100)}% target income`)
  return { annualSpend, basis }
}

// Function to turn each debt account's own mortgage-payoff projection (see
// calculateMortgagePayoff) into a guaranteed-income-shaped stream: once the loan is paid off, that
// monthly payment stops going out, which is economically the same as new income arriving --
// simulated the same way as a pension/Social Security stream (see fire-dashboard.ts's
// RetirementIncomeStream) rather than as its own mechanism. currentAge is a whole-year integer
// (see ageFromBirthDate) while monthsRemaining is precise, so the payoff age is rounded to the
// nearest year -- the same granularity every other age in this plan (retirementAge, planToAge)
// already uses.
//
// Assumes the mortgage payment is counted in the trailing spend the simulation already draws
// from (i.e. budgeted as a category, the common Actual setup for a loan payment) -- if a person's
// budget tracks it purely as an account-to-account transfer instead, it was never part of
// annualSpend to begin with, and this would overstate the reduction. No way to tell which from
// account data alone -- documented here and in the README rather than silently assumed correct.
function debtPayoffIncomeStreams(accounts: readonly ClassifiedAccount[], currentAge: number): RetirementIncomeStream[] {
  const streams: RetirementIncomeStream[] = []
  for (const account of accounts) {
    if (account.mortgageInterestRate == null || account.mortgageMonthlyPayment == null || account.mortgageBalanceAsOfDate == null || account.mortgageBalanceAsOf == null) {
      continue
    }
    const payoff = calculateMortgagePayoff({
      interestRate: account.mortgageInterestRate,
      monthlyPayment: account.mortgageMonthlyPayment,
      balanceAsOfDate: account.mortgageBalanceAsOfDate,
      balanceAsOf: account.mortgageBalanceAsOf,
      extraMonthlyPrincipal: account.mortgageExtraPrincipal ?? undefined,
    })
    if ("error" in payoff || payoff.monthsRemaining <= 0) {
      continue
    }
    streams.push({
      id: `debt-payoff-${account.id}`,
      name: `${account.name} paid off`,
      startAge: currentAge + Math.round(payoff.monthsRemaining / 12),
      // Deliberately NOT (mortgageMonthlyPayment + mortgageExtraPrincipal): the netting below this
      // still rests on the same documented assumption as ever -- "this payment is already counted
      // in your budgeted spend" -- and that holds far less often for extra principal specifically.
      // It's a discretionary overpayment, commonly funded from savings/a windfall rather than a
      // routine tracked bill, and can genuinely be its own separate (unselected) category even when
      // the regular payment is tracked -- confirmed against a real plan this generalization was
      // checked against, where exactly that was true. mortgageExtraPrincipal still shortens the
      // payoff itself (see calculateMortgagePayoff above, which needs both to get the date right);
      // it just doesn't also free up spend once paid off.
      annualAmount: account.mortgageMonthlyPayment * 12,
    })
  }
  return streams
}

export interface RuleOf55Boost {
  accountName: string
  from: number | null
  to: number
  amount: number
}

export interface DebtPayoff {
  accountName: string
  payoffAge: number
  monthlyAmount: number
}

export interface CheckOptions {
  currentAge: number
  retirementAges: readonly number[]
  planToAge: number
  // Used only when no Monte Carlo widget exists yet to derive a real inflation assumption from
  // instead.
  fallbackInflationMean: number
  incomeStreams: readonly RetirementIncomeStream[]
  monteCarloAssumptions: MonteCarloAssumptions
  // See fire-dashboard.ts's expenseAdjustmentFactorWithOverride/spendHistoryMonthsWithOverride
  // (both resolved once in app-server.ts's requirePlan) -- spendFromLocalSelection's only other
  // two inputs besides this one, entirely local.
  crossoverExpenseCategoryIds: readonly string[] | null
  expenseAdjustmentFactor: number
  spendHistoryMonths: number
  // How those spendHistoryMonths collapse into one flat figure (mean/median/hampel) -- see
  // ExpenseProjectionType's own doc comment in fire-accounts.ts. Applies to Actual mode's own
  // selection above AND file/detached mode's own fileModeSpend (see its own doc comment below).
  expenseProjectionType: ExpenseProjectionType
  // Both needed for the MAGI/effective-tax-rate finding (see magiFinding in fire-analysis.ts) --
  // either missing just skips that finding entirely (checkDashboard), the same "absent, not an
  // error" convention as ruleOf55Boosts/debtPayoffs.
  filingStatus: FilingStatus | null
  federalTaxBrackets: FederalTaxBrackets | null
  // Both needed for the MAGI finding's %FPL/ACA-subsidy line specifically (not the MAGI/bracket
  // line itself, which only needs the two above) -- either missing just omits that one extra line,
  // same convention.
  householdSize: number | null
  federalPovertyGuidelines: FederalPovertyGuidelines | null
  // Target %FPL ceiling -- when set (plus the four fields above), the bridge/MAGI simulation caps
  // tax-deferred withdrawals at whatever this %FPL implies instead of draining accounts by plain
  // withdrawalOrder alone. See taxDeferredCapAt below.
  acaTargetPctFpl: number | null
  // Age Medicare eligibility begins -- optional secondary bound on the ceiling above: once
  // reached, the cap stops applying (Medicare replaces the need for ACA marketplace coverage).
  // Meaningless without acaTargetPctFpl also set.
  medicareAge: number | null
  // Minimum %FPL ACA marketplace subsidies require -- 100% in states that didn't expand Medicaid,
  // 138% in states that did (below either, a household would be Medicaid-eligible instead, not
  // subsidy-eligible). Only ever 100 or 138 -- validated at the API boundary (app-server.ts), not
  // a free-form percentage the way acaTargetPctFpl is, since those are this policy's only two real
  // values. This app tracks no state (federal-only everywhere else -- see
  // federal-poverty-guidelines.ts's own doc comment), so this is a direct toggle between the two
  // rather than a full state picker. When set (plus the four fields above), the simulation converts
  // just enough traditional money to Roth each year to keep MAGI at or above this floor once
  // non-taxable/pension/SS alone would otherwise land it under. Same medicareAge gating as the
  // ceiling above: once on Medicare there's no ACA marketplace coverage left to be subsidy-eligible
  // FOR, so there's nothing left for a conversion to protect -- see rothConversionAmountAt below.
  acaFloorPctFpl: 100 | 138 | null
  // Known future changes to living expenses -- see ExpenseAdjustment's own doc comment
  // (fire-accounts.ts) for each entry's shape.
  expenseAdjustments: readonly ExpenseAdjustment[]
  // File mode's own spend source (issue #34/#35's follow-up, 2026-09-21) -- see checkDashboard's
  // own doc comment for the full precedence. Ignored whenever checkDashboard's actualConfig
  // parameter is non-null (Actual mode always uses spendFromLocalSelection instead); required
  // (by the caller, app-server.ts) whenever it's null, since there's no live Actual data to fall
  // back to otherwise.
  fileModeSpend: { annualSpend: number; basis: string | null } | null
}

export interface AccountContribution {
  accountName: string
  monthlyCents: number
}

export interface CheckResult {
  // The plan's own current age and target age -- self-contained rather than relying on the
  // client's own copy (STATE.currentAge/STATE.dashboard.planToAge) staying in sync, since the
  // Monte Carlo and Bridge charts both need these to size a shared x-axis.
  currentAge: number
  planToAge: number
  contributions: AccountContribution[]
  annualSpend: number
  // Null when no real Plan-section category selection was used -- spendFromLocalSelection fell
  // back to every non-income/non-hidden category, which isn't a choice worth describing in text.
  spendBasis: string | null
  inflationMean: number
  bridgeFindings: Finding[]
  // The full simulation behind bridgeFindings, one entry per retirement age in the same order --
  // bridgeFindings is prose derived from these; this is what the client charts the burndown from.
  bridgeResults: BridgeResult[]
  // The in-app Monte Carlo simulation (src/vendor/monte-carlo/), one entry per retirement age in
  // the same order as bridgeResults -- an alternative to reading the equivalent monte-carlo-card
  // widget off Actual's own dashboard. Empty when an incomplete account (no allocationPreset set)
  // makes buildMonteCarloWidget itself throw -- caught below rather than failing this whole
  // read-only analysis.
  monteCarloResults: MonteCarloResultEntry[]
  // Prose derived from monteCarloResults, same order -- the fan chart's companion text, same
  // pairing as bridgeFindings/bridgeResults above.
  monteCarloFindings: Finding[]
  // Real (not simulated) total portfolio balance for up to a few years before currentAge -- see
  // the doc comment on BridgeResult's own `history` for why this is real transaction history
  // rather than a continuation of the simulation. Shared across every entry in monteCarloResults
  // (unlike bridgeResults' own per-scenario history): total balance doesn't depend on which
  // retirement age a scenario is comparing, only Bridge's accessible/locked split does.
  monteCarloHistory: { age: number; totalBalance: number }[]
  // At-a-glance numbers -- current portfolio total and the access-age/spending adjustments already
  // baked into every projection above. Every value below is already computed, or a cheap pure
  // function over data already fetched, elsewhere in this same function, so the client can show
  // them just by opening or refreshing this tab.
  portfolioAccountCount: number
  portfolioTotal: number
  ruleOf55Boosts: RuleOf55Boost[]
  debtPayoffs: DebtPayoff[]
  // Pension and Social Security only -- options.incomeStreams before debtStreams are merged into
  // the local incomeStreams below, so the Bridge chart can mark "income starts here" without also
  // duplicating the debt-payoff markers it already draws from debtPayoffs above.
  incomeStreams: readonly RetirementIncomeStream[]
  // One entry per scenario that actually crosses 400% FPL somewhere between retiring and
  // planToAge -- empty (not an error) whenever household size/filing status/either reference file
  // is missing, or a scenario simply never crosses it. See the computation's own doc comment.
  acaCliffCrossings: { retirementAge: number; crossesAtAge: number; pctFPL: number }[]
  // Passed straight through from options -- the client already has this from the Plan section's
  // own config (STATE.dashboard.expenseAdjustments), but exposing it here too keeps every
  // Bridge-chart marker input flowing through this same CheckResult, matching
  // ruleOf55Boosts/debtPayoffs/incomeStreams above, rather than the chart needing to reach into a
  // second, differently-shaped source for just this one marker kind.
  expenseAdjustments: readonly ExpenseAdjustment[]
}

// Function to analyze the dashboard that is actually live in Actual, rather than generating a new
// one. Reads the imported widgets back through ActualQL, so it sees the state a person has been
// editing in the app -- including changes this tool never made.
//
// actualConfig is null in file mode (issue #34/#35's follow-up, 2026-09-21) -- a
// name,balance-only accounts file has no live Actual connection AND no transaction history at all
// to derive spend/a Monte Carlo widget from, unlike every account this app otherwise analyzes. Two
// things change when it's null:
//   1. No Monte Carlo widget to import -- monteCarloMetas is just empty, the same "nothing
//      imported yet" state a fresh Actual budget with no widget would produce (falls back to
//      options.fallbackInflationMean below, same as ever).
//   2. Spend comes from options.fileModeSpend instead of spendFromLocalSelection's own
//      Actual-backed category-history lookup -- the caller (app-server.ts) computes it beforehand,
//      in one of two ways, in this precedence: a transactions file's own real spend (see
//      fire-generate.ts's annualSpendFromTransactions) when one's been imported and it comes back
//      nonzero, else fire-accounts.ts's flat fileModeAnnualExpense (defaulting to
//      DEFAULT_FILE_MODE_ANNUAL_EXPENSE). Required (never null) whenever actualConfig itself is
//      null -- there's nothing else this function could fall back to.
export async function checkDashboard(
  actualConfig: ActualConfig | null,
  dataSource: AccountDataSource,
  accounts: readonly ClassifiedAccount[],
  options: CheckOptions,
): Promise<CheckResult> {
  const portfolioIds = portfolioAccountIds(accounts)
  const contributionsAnnualByAccount = new Map(
    accounts.flatMap((account) => (account.monthlyContribution == null ? [] : [[account.id, account.monthlyContribution * 12] as [string, number]])),
  )

  let monteCarloMetas: MonteCarloCardMeta[] = []
  let annualSpend: number
  let spendBasis: string | null
  if (actualConfig == null) {
    if (options.fileModeSpend == null) {
      throw new Error("fileModeSpend is required when actualConfig is null (file mode).")
    }
    ;({ annualSpend, basis: spendBasis } = options.fileModeSpend)
  } else {
    const widgets = await fetchDashboardWidgets<unknown>(actualConfig, null)
    monteCarloMetas = widgets
      .filter((widget) => widget.type === "monte-carlo-card")
      .map((widget) => widget.meta as MonteCarloCardMeta | null)
      .filter((meta): meta is MonteCarloCardMeta => meta !== null)

    // Entirely local -- see spendFromLocalSelection's own doc comment for why this never falls
    // back to reading a live Actual crossover widget's own checklist.
    const groups = await fetchCategoryGroups(actualConfig)
    const allExpenseCategoryIds = groups.flatMap((group) => group.categories).filter((category) => !category.is_income && !category.hidden).map((category) => category.id)
    ;({ annualSpend, basis: spendBasis } = await spendFromLocalSelection(
      actualConfig,
      allExpenseCategoryIds,
      options.crossoverExpenseCategoryIds,
      options.expenseAdjustmentFactor,
      options.spendHistoryMonths,
      options.expenseProjectionType,
    ))
  }

  const debtStreams = debtPayoffIncomeStreams(accounts, options.currentAge)
  const incomeStreams = [...options.incomeStreams, ...debtStreams]
  const debtPayoffs: DebtPayoff[] = debtStreams.map((stream) => ({
    accountName: stream.name.replace(/ paid off$/, ""),
    payoffAge: stream.startAge,
    monthlyAmount: Math.round(stream.annualAmount / 12),
  }))

  // Prefer the inflation the live dashboard is actually simulating with; fall back only when
  // nothing has been imported yet.
  const inflationMean = monteCarloMetas[0]?.inflationMean ?? options.fallbackInflationMean

  // Function to get one age's own net effect of every configured ExpenseAdjustment, split into an
  // inflating (today's-dollars, netted in before inflating) and fixed (nominal, added after) part
  // -- see simulateBridge's own expenseAdjustmentAt parameter for exactly how each part is
  // applied. Scenario-independent (an adjustment's start/end age and amount don't vary by
  // retirementAge), so built once and shared by every scenario's own simulateBridge call and by
  // projectedSpendAt below, the same reasoning taxDeferredCapAt/inflateGuideline already use for
  // their own once-per-check callbacks.
  const expenseAdjustmentAt = (age: number): { inflating: number; fixed: number } => {
    let inflating = 0
    let fixed = 0
    for (const adjustment of options.expenseAdjustments) {
      if (age < adjustment.startAge || (adjustment.endAge != null && age > adjustment.endAge)) continue
      if (adjustment.inflate) inflating += adjustment.annualAmount
      else fixed += adjustment.annualAmount
    }
    return { inflating, fixed }
  }

  // The same gross-inflate formula simulateBridge's own loop applies for its projectedSpend field
  // (income NOT netted out -- see BridgeYear's own doc comment for why), for an arbitrary age
  // rather than a running simulation -- scenario-independent (annualSpend/inflationMean don't vary
  // by retirementAge), so computed once and reused across every scenario's own history below,
  // rather than duplicated inline for each. For an age before currentAge, the negative exponent
  // runs the same formula backward: what this plan's projected expenses were worth back then, not a
  // claim about what was actually spent -- expense adjustments run backward the same way (a
  // historical point for an adjustment whose startAge is in the past correctly still reflects it).
  const projectedSpendAt = (age: number): number => {
    const { inflating, fixed } = expenseAdjustmentAt(age)
    return Math.max(0, (annualSpend + inflating) * Math.pow(1 + inflationMean, age - options.currentAge) + fixed)
  }

  const balanceEntries = await Promise.all(
    portfolioIds.map(async (accountId): Promise<[string, number]> => [accountId, await dataSource.fetchAccountBalance(accountId)]),
  )
  const balances = new Map(balanceEntries)
  const portfolioTotal = portfolioIds.reduce((total, accountId) => total + (balances.get(accountId) ?? 0), 0)

  // How far back to extend the Bridge/Monte Carlo charts' x-axis before currentAge, and each
  // portfolio account's own balance at each of those past ages -- see AccountDataSource's own
  // fetchAccountHistory doc comment (account-data-source.ts) for what determines this and why an
  // empty result (no history at all) is a normal, valid case, not something this caller needs to
  // special-case.
  const { historicalAges, balancesByAgeAndAccount: historicalBalancesByAge } = await dataSource.fetchAccountHistory(portfolioIds, options.currentAge)
  const monteCarloHistory = historicalAges.map((age) => ({
    age,
    totalBalance: portfolioIds.reduce((total, accountId) => total + (historicalBalancesByAge.get(age)?.get(accountId) ?? 0), 0),
  }))

  // Reported against the latest configured retirement age -- effectiveAccessAge's own gate
  // (separationAge <= retirementAge) only gets easier to satisfy as
  // retirementAge grows, so a boost that doesn't apply there can't apply for any earlier scenario
  // on this plan either.
  const latestRetirementAge = Math.max(...options.retirementAges)
  const ruleOf55Boosts: RuleOf55Boost[] = []
  for (const account of accounts) {
    const boosted = effectiveAccessAge(account, latestRetirementAge)
    // Accepting the 10% early-withdrawal penalty, or electing a 72(t) SEPP schedule, both also
    // change effectiveAccessAge -- but neither is a real employment-driven exception the way Rule
    // of 55 is, so both are deliberately excluded here rather than mislabeled as a Rule of 55
    // boost. A SEPP account's own computed distribution is reported separately (AccountState's
    // seppAnnualAmount), not folded into this figure.
    if (!account.earlyWithdrawalPenalty && account.seppMethod == null && boosted !== account.accessAge) {
      // The amount that will actually be there BY the unlock age, not what's in the account today
      // -- see projectAccountBalance's own doc comment.
      const projected = projectAccountBalance(toBridgeAccounts([account], balances, contributionsAnnualByAccount, latestRetirementAge), options.currentAge, boosted as number)
      ruleOf55Boosts.push({ accountName: account.name, from: account.accessAge, to: boosted as number, amount: projected })
    }
  }

  // Function to look up one age's guaranteed ordinary income (pension/Social Security, pre-merge
  // with the rest of incomeStreams) -- shared by magiInputsAt and taxDeferredCapAt below, both of
  // which need the SAME raw figures as their own separate MAGI inputs.
  const ordinaryIncomeAt = (age: number): { pensionIncome: number; socialSecurityBenefit: number } => ({
    pensionIncome: options.incomeStreams.find((s) => s.id === "pension" && s.startAge <= age)?.annualAmount ?? 0,
    socialSecurityBenefit: options.incomeStreams.find((s) => s.id === "social-security" && s.startAge <= age)?.annualAmount ?? 0,
  })

  // Function to carry a published (fixed, single-year) FPL guideline forward to a future age's
  // NOMINAL dollars, the same way projectedSpendAt already does for spend -- MAGI at a future age is
  // derived from a withdrawal need that's already grown at inflationMean every year since today, so
  // comparing it against the guideline's raw, un-grown figure silently mixes real (today's) dollars
  // against nominal ones, understating %FPL more and more the further out the age (a household
  // spending comfortably under 400% FPL today would only cross it decades out from inflation alone,
  // with no real change in spending power). inflationMean (not some separate FPL-specific rate) is
  // the right growth rate to reuse here, not just a convenient stand-in: HHS itself updates the
  // guideline annually off CPI-U, the standard general-inflation index this app's own inflationMean
  // assumption already represents (confirmed against published FPL history -- ~1.9%/yr 2006-2016,
  // ~3.0%/yr 2016-2026 -- in the same range as this app's own 3% default). Takes the base guideline
  // as a parameter, not householdSize/the table themselves, so every call site keeps its own
  // already-checked (TS-narrowed) `options.householdSize`/`options.federalPovertyGuidelines` access
  // rather than this needing to re-check and return null itself.
  const inflateGuideline = (baseGuideline: number, age: number): number => baseGuideline * Math.pow(1 + inflationMean, age - options.currentAge)

  // Function to cap tax-deferred withdrawals at whatever this plan's target %FPL implies for a
  // given age -- see allocateWithdrawal's own taxDeferredCap parameter for how this is applied
  // (non-tax-deferred drawn first, uncapped, since it never raises MAGI; tax-deferred capped at
  // this; tax-deferred again past the cap only as a last resort, once non-taxable is ALSO
  // exhausted and the year's real spending need still isn't met -- a real need beats a MAGI
  // target). Built once here (not per scenario -- the formula only depends on age plus fixed
  // prerequisites, never on retirementAge), reused by every scenario's own simulateBridge call AND
  // by magiInputsAt, so the MAGI/ACA-cliff prose can never disagree with what the chart's own
  // simulation actually did (the same consistency guarantee withdrawalOrder already has). Returns
  // null (uncapped -- today's plain order/proportional allocation) whenever a prerequisite is
  // missing, or once medicareAge is reached (if set): Medicare replaces the need for ACA
  // marketplace coverage, so there's nothing left worth capping for. MAGI is monotonically
  // non-decreasing in grossTaxDeferredWithdrawal (see estimateMagi/taxableSocialSecurity -- both
  // are non-decreasing step functions), so a plain integer binary search over cents (~40
  // iterations, cheap closed-form calls, no trajectory simulation needed) is simpler and more
  // robust here than inverting the piecewise SS-taxability formula algebraically.
  const taxDeferredCapAt = (age: number): number | null => {
    if (
      options.acaTargetPctFpl == null ||
      options.householdSize == null ||
      options.federalPovertyGuidelines == null ||
      options.filingStatus == null ||
      options.federalTaxBrackets == null
    ) {
      return null
    }
    if (options.medicareAge != null && age >= options.medicareAge) {
      return null
    }
    const targetMagi = inflateGuideline(federalPovertyGuideline(options.householdSize, options.federalPovertyGuidelines), age) * (options.acaTargetPctFpl / 100)
    const { pensionIncome, socialSecurityBenefit } = ordinaryIncomeAt(age)
    let lo = 0
    let hi = 100_000_000_000 // $1B in cents -- comfortably past any real withdrawal; binary search converges regardless
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      const magi = estimateMagi({ grossTaxDeferredWithdrawal: mid, rothConversionAmount: 0, pensionIncome, socialSecurityBenefit }, options.filingStatus, options.federalTaxBrackets).magi
      if (magi <= targetMagi) lo = mid
      else hi = mid
    }
    return Math.round(lo)
  }

  // Function to get the desired Roth-conversion amount for a given age -- issue #29's ACA subsidy
  // floor, the mirror image of taxDeferredCapAt above: that one stops MAGI going too HIGH (risking
  // the 400% cliff), this one keeps it from going too LOW (risking falling under the minimum ACA
  // marketplace subsidies actually require -- see acaFloorPctFpl's own doc comment). Takes this
  // year's real grossTaxDeferredWithdrawal (simulateBridge already knows it by the time it calls
  // this) so the search is against the REAL trajectory, not a guess -- same reasoning
  // taxDeferredCapAt's own doc comment gives for reading grossTaxDeferredWithdrawal off
  // result.timeline elsewhere in this file. Returns the GROSS conversion amount that brings MAGI
  // up to (not past) the floor; simulateBridge itself clamps this to whatever tax-deferred balance
  // is actually reachable that year and picks the destination account, since only it tracks live
  // balances. Assumes acaFloorPctFpl is strictly less than acaTargetPctFpl whenever both are set
  // (validated at the API boundary, app-server.ts) -- converting up to the floor should never by
  // itself risk crossing the ceiling, so this never needs to look at taxDeferredCapAt's own output
  // to stay out of its way.
  const rothConversionAmountAt = (age: number, grossTaxDeferredWithdrawal: number): number => {
    if (
      options.acaFloorPctFpl == null ||
      options.householdSize == null ||
      options.federalPovertyGuidelines == null ||
      options.filingStatus == null ||
      options.federalTaxBrackets == null
    ) {
      return 0
    }
    if (options.medicareAge != null && age >= options.medicareAge) {
      return 0
    }
    const floorMagi = inflateGuideline(federalPovertyGuideline(options.householdSize, options.federalPovertyGuidelines), age) * (options.acaFloorPctFpl / 100)
    const { pensionIncome, socialSecurityBenefit } = ordinaryIncomeAt(age)
    const magiWithoutConversion = estimateMagi(
      { grossTaxDeferredWithdrawal, rothConversionAmount: 0, pensionIncome, socialSecurityBenefit },
      options.filingStatus,
      options.federalTaxBrackets,
    ).magi
    if (magiWithoutConversion >= floorMagi) return 0
    let lo = 0
    let hi = 100_000_000_000 // $1B in cents -- comfortably past any real conversion; binary search converges regardless
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      const magi = estimateMagi(
        { grossTaxDeferredWithdrawal, rothConversionAmount: mid, pensionIncome, socialSecurityBenefit },
        options.filingStatus,
        options.federalTaxBrackets,
      ).magi
      if (magi <= floorMagi) lo = mid
      else hi = mid
    }
    return Math.round(lo)
  }

  // Function to read one scenario's ordinary-income inputs at a given age -- shared by
  // magiFinding's own call below (at the retirement age only), acaCliffCrossings (which needs the
  // same figures at every age of the trajectory to find when, if ever, MAGI crosses the ACA
  // subsidy cliff), and attachMagi below (the Bridge table's own per-row MAGI/%FPL).
  // grossTaxDeferredWithdrawal comes straight off result.timeline -- the REAL figure this
  // scenario's own simulateBridge call already worked out against that year's real,
  // already-evolved account balances -- rather than this function re-deriving its own guess from
  // today's un-depleted balances. An earlier version did exactly that (rebuilding its own
  // allocateWithdrawal call from today's balances at every age), which quietly diverged from the
  // real trajectory more and more the further an age sat from today: every account here either
  // grows or drains over decades, so "what would today's balances do" and "what did the real,
  // already-decades-deep trajectory actually do" are two different questions once any real time
  // has passed -- confirmed live against real data, where the real trajectory had been drawing
  // five and six figures a year of tax-deferred money since the late 50s while this function kept
  // reporting $0 all the way to the 90s. Undefined (no point recorded for this age, or the
  // scenario's real withdrawal-phase computation never set a figure for it -- see BridgeYear's own
  // doc comment) reads as $0, same "nothing withdrawn" meaning as an explicit zero would have.
  const magiInputsAt = (age: number, result: BridgeResult) => {
    const point = result.timeline.find((point) => point.age === age)
    const grossTaxDeferredWithdrawal = point?.grossTaxDeferredWithdrawal ?? 0
    // Same "read the real trajectory, don't re-derive" reasoning as grossTaxDeferredWithdrawal
    // above -- the real Roth conversion (if any) simulateBridge's own rothConversionAmountAt
    // callback actually applied that year (issue #29's ACA subsidy floor).
    const rothConversionAmount = point?.rothConversionAmount ?? 0
    // options.incomeStreams (pension/SS only, pre-merge) for the RAW figures MAGI needs as their
    // own separate ordinary-income lines.
    const { pensionIncome, socialSecurityBenefit } = ordinaryIncomeAt(age)
    return { grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit }
  }

  // Function to set magi/pctFPL directly on each of a scenario's own timeline points (mutating in
  // place, same pattern simulateBridge itself uses for grossTaxDeferredWithdrawal) -- the Bridge
  // table's per-row MAGI/%FPL columns, computed here rather than inside simulateBridge (which has
  // no notion of tax brackets or poverty guidelines) by reusing the exact same
  // magiInputsAt/estimateMagi/inflateGuideline pipeline the MAGI finding and ACA cliff crossing
  // below already use, so a table row can never disagree with either. A no-op (leaves every point
  // as simulateBridge left it) whenever filing status or the tax-bracket table isn't loaded, same
  // "absent, not an error" convention as the rest of this file; pctFPL specifically also needs
  // household size and the poverty guidelines table.
  const attachMagi = (result: BridgeResult): BridgeResult => {
    if (options.filingStatus == null || options.federalTaxBrackets == null) return result
    const filingStatus = options.filingStatus
    const federalTaxBrackets = options.federalTaxBrackets
    const baseGuideline = options.householdSize != null && options.federalPovertyGuidelines != null ? federalPovertyGuideline(options.householdSize, options.federalPovertyGuidelines) : null
    for (const point of result.timeline) {
      // grossTaxDeferredWithdrawal undefined means no real withdrawal was ever computed for this
      // point (the final ending-balance-only point of a funded scenario, or a depletion year that
      // never reached the allocation -- see BridgeYear's own doc comment) -- magi/pctFPL stay
      // undefined for exactly the same reason: there's no real income to estimate one from.
      if (point.grossTaxDeferredWithdrawal === undefined) continue
      const { grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit } = magiInputsAt(point.age, result)
      const estimate = estimateMagi({ grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit }, filingStatus, federalTaxBrackets)
      point.magi = estimate.magi
      if (baseGuideline != null) point.pctFPL = (estimate.magi / inflateGuideline(baseGuideline, point.age)) * 100
    }
    return result
  }

  // Simulated once per retirement age and kept in full -- bridgeFindings below is prose derived
  // from these results, not a second computation, so the two can never disagree. history is real,
  // not simulated, so it's computed here rather than inside simulateBridge itself (which only ever
  // sees a single snapshot balance per account, not a series of them) -- effectiveAccessAge (via
  // toBridgeAccounts) still depends on retirementAge, so it's resolved per scenario like everything
  // else here, not shared across them the way monteCarloHistory above is.
  const bridgeResults = options.retirementAges.map((retirementAge) => {
    const currentBridgeAccounts = toBridgeAccounts(accounts, balances, contributionsAnnualByAccount, retirementAge)
    const result = simulateBridge(
      currentBridgeAccounts,
      options.currentAge,
      retirementAge,
      options.planToAge,
      annualSpend,
      inflationMean,
      incomeStreams,
      taxDeferredCapAt,
      rothConversionAmountAt,
      expenseAdjustmentAt,
    )
    // Ends on a real point at currentAge itself (today's live balance, not a historical one) --
    // ties the last real-history year to "now" so the chart has something to draw a line between
    // even with only one year of lookback, and (for a retirementAge equal to currentAge) meets
    // timeline's own first point exactly rather than leaving a one-year gap right before it.
    const history = [
      ...historicalAges.map((age) => historicalBridgeYear(toBridgeAccounts(accounts, historicalBalancesByAge.get(age) as Map<string, number>, contributionsAnnualByAccount, retirementAge), age, projectedSpendAt(age))),
      ...(historicalAges.length > 0 ? [historicalBridgeYear(currentBridgeAccounts, options.currentAge, projectedSpendAt(options.currentAge))] : []),
    ]
    return attachMagi({ ...result, history })
  })
  // A second finding per scenario, right after its own funding-status finding, estimating that
  // year's MAGI/effective-tax-rate -- see magiFinding's own doc comment for the simplifying
  // assumptions. Skipped (not an error) whenever filing status or the tax-bracket table is missing,
  // same convention as ruleOf55Boosts/debtPayoffs being empty rather than reported as broken.
  const bridgeFindings = bridgeResults.flatMap((result) => {
    const findings = [bridgeFinding(result, options.planToAge)]
    if (options.filingStatus != null && options.federalTaxBrackets != null) {
      const { grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit } = magiInputsAt(result.retirementAge, result)
      const aca =
        options.householdSize != null && options.federalPovertyGuidelines != null
          ? { targetGuideline: inflateGuideline(federalPovertyGuideline(options.householdSize, options.federalPovertyGuidelines), result.retirementAge) }
          : null
      findings.push(magiFinding(result.retirementAge, pensionIncome, socialSecurityBenefit, grossTaxDeferredWithdrawal, rothConversionAmount, options.filingStatus, options.federalTaxBrackets, aca))
    }
    return findings
  })

  // The ACA subsidy cliff, as a chart marker (see renderBridgeChart in app.js) rather than a text
  // line -- unlike the MAGI/tax-bracket finding above, this is inherently a "when does this happen"
  // fact, not a single-point-in-time one, so it belongs on the age axis. One entry per scenario,
  // and only for a scenario that actually crosses 400% FPL somewhere between retiring and planToAge
  // -- most don't, and a marker for "still under the cliff" would just be noise. Walks every whole
  // year rather than only the ages accessibility can change at, since netWithdrawalNeed itself isn't
  // monotonic either (a pension/Social Security stream starting can lower it) -- the product of the
  // two isn't guaranteed monotonic, so there's no shortcut past checking each year in order. Stops
  // at depletionAge, exclusive, when the scenario runs dry before planToAge -- magiInputsAt always
  // answers "what withdrawal WOULD this year need," with no notion of whether the portfolio still
  // has anything left to give, so past the age the money's actually gone there's no real withdrawal
  // (and so no real MAGI hit) for a marker to describe. The guideline itself is inflated forward to
  // each age's own nominal dollars (see inflateGuideline) to match the nominal MAGI it's compared
  // against -- otherwise a crossing decades out would mostly be measuring inflation eroding the
  // guideline's real value rather than any actual change in spending power.
  const acaCliffCrossings: { retirementAge: number; crossesAtAge: number; pctFPL: number }[] = []
  if (options.filingStatus != null && options.federalTaxBrackets != null && options.householdSize != null && options.federalPovertyGuidelines != null && options.federalPovertyGuidelines.subsidyCliffAt400Pct) {
    const baseGuideline = federalPovertyGuideline(options.householdSize, options.federalPovertyGuidelines)
    for (const result of bridgeResults) {
      const lastFundedAge = result.depletionAge != null ? result.depletionAge - 1 : options.planToAge
      for (let age = result.retirementAge; age <= Math.min(options.planToAge, lastFundedAge); age++) {
        const { grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit } = magiInputsAt(age, result)
        const estimate = estimateMagi({ grossTaxDeferredWithdrawal, rothConversionAmount, pensionIncome, socialSecurityBenefit }, options.filingStatus, options.federalTaxBrackets)
        const pctFPL = (estimate.magi / inflateGuideline(baseGuideline, age)) * 100
        if (pctFPL > 400) {
          acaCliffCrossings.push({ retirementAge: result.retirementAge, crossesAtAge: age, pctFPL: Math.round(pctFPL * 10) / 10 })
          break
        }
      }
    }
  }

  // Simulated once per retirement age, same order as bridgeResults; monteCarloFindings below is
  // prose derived from these same results, not a second computation. Never lets an incomplete
  // "custom" allocation (see returnAssumptionsFor's own throw, reached via buildMonteCarloWidget)
  // fail this whole read-only analysis -- caught below instead. Skipped entirely with no portfolio
  // accounts at all: the vendored engine's own runMonteCarloSimulation falls back to a single fake
  // $500,000 pot (MONTE_CARLO_DEFAULTS.pots) for an empty pots array rather than simulating
  // nothing, which would otherwise chart fabricated data for a plan with no real portfolio yet.
  let monteCarloByAge: { retirementAge: number; result: MonteCarloSummary }[] = []
  if (portfolioIds.length > 0) {
    try {
      monteCarloByAge = options.retirementAges.map((retirementAge) => ({
        retirementAge,
        result: runRetirementMonteCarlo(accounts, balances, options.currentAge, retirementAge, options.planToAge, annualSpend, options.monteCarloAssumptions, incomeStreams, options.expenseAdjustments),
      }))
    } catch {
      // Leave empty -- an incomplete "custom" allocation just means no Monte Carlo results this
      // pass, not a failed Check.
    }
  }
  const monteCarloResults: MonteCarloResultEntry[] = monteCarloByAge.map((entry) => ({ ...entry.result, retirementAge: entry.retirementAge }))
  const monteCarloFindings = monteCarloByAge.map((entry) => monteCarloFinding(entry.result, options.currentAge, entry.retirementAge, options.planToAge))

  return {
    currentAge: options.currentAge,
    planToAge: options.planToAge,
    contributions: accounts
      .filter((account) => portfolioIds.includes(account.id))
      .map((account) => ({ accountName: account.name, monthlyCents: Math.round((contributionsAnnualByAccount.get(account.id) ?? 0) / 12) })),
    annualSpend,
    spendBasis,
    inflationMean,
    bridgeFindings,
    bridgeResults,
    monteCarloResults,
    monteCarloFindings,
    monteCarloHistory,
    portfolioAccountCount: portfolioIds.length,
    portfolioTotal,
    ruleOf55Boosts,
    debtPayoffs,
    incomeStreams: options.incomeStreams,
    acaCliffCrossings,
    expenseAdjustments: options.expenseAdjustments,
  }
}

// Re-exported so callers (app-server.ts) can format a thrown error consistently with the rest of
// this repo without importing actual-helpers.ts twice for one function.
export { formatError }
