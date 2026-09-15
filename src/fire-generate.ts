import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  addMonthsToDate,
  ageFromBirthDate,
  averageSpent,
  fetchAccountBalance,
  fetchAccountTransactions,
  fetchCategoryGroups,
  fetchDashboardPages,
  fetchDashboardWidgets,
  fetchHistoricalSpent,
  formatError,
  monthRange,
  sumTransactionAmounts,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth, Transaction } from "./actual-helpers.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import {
  buildFireDashboard,
  buildMonteCarloWidgets,
  effectiveAccessAge,
  mergeGeneratedDashboard,
  portfolioAccountIds,
  totalMonthlyContribution,
} from "./fire-dashboard.ts"
import type { CrossoverAssumptions, CrossoverCardMeta, ExistingDashboard, MonteCarloAssumptions, MonteCarloCardMeta, RetirementIncomeStream } from "./fire-dashboard.ts"
import {
  bridgeFinding,
  calculateMortgagePayoff,
  detectMonteCarloWidgetSetDrift,
  detectPotDrift,
  detectSpendingPhaseDrift,
  historicalBridgeYear,
  monteCarloFinding,
  simulateBridge,
  toBridgeAccounts,
} from "./fire-analysis.ts"
import type { BridgeResult, Finding } from "./fire-analysis.ts"
import { runRetirementMonteCarlo } from "./fire-monte-carlo.ts"
import type { MonteCarloResultEntry, MonteCarloSummary } from "./fire-monte-carlo.ts"

// The non-CLI guts of what used to be reports-fire.ts's main(): fetching real data, building or
// analyzing the dashboard, and returning a plain structured result rather than printing one --
// consumed by app-server.ts's /api/retirement/generate and /api/retirement/check routes, and
// directly unit-testable without capturing stdout.

// The API has no running-balance field; summing an account's full transaction history is the
// accounting identity used instead (see fetchAccountBalance), so this must reach back further than
// any real account could have existed.
const BALANCE_SINCE_DATE = "1970-01-01"
const HISTORY_MONTHS = 12

// Function to get the current month as a yyyy-mm string
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Function to sum the trailing-12-month average spend across every given category -- the fallback
// used when no crossover widget exists yet to derive spend from instead (see spendFromCrossover).
async function trailingAnnualSpend(config: ActualConfig, categoryIds: readonly string[]): Promise<number> {
  const month = currentMonth()
  const monthCache = new Map<string, CategoryMonth[]>()
  let monthlyTotal = 0
  for (const categoryId of categoryIds) {
    const history = await fetchHistoricalSpent(config, categoryId, month, HISTORY_MONTHS, monthCache)
    monthlyTotal += averageSpent(history)
  }
  return monthlyTotal * 12
}

// Function to compute annual spend from the Plan section's own expense-category selection --
// takes priority over a live crossover widget's checklist (spendFromCrossover) wherever it's set,
// so narrowing categories never requires opening Actual.
// Intersected against the real, currently non-income/non-hidden category ids so a category deleted
// or hidden after being selected doesn't silently error the whole run; returns null (not a zero
// spend) when that intersection is empty, so the caller falls back the same way it would if this
// selection had never been set at all.
async function spendFromLocalSelection(
  config: ActualConfig,
  allExpenseCategoryIds: readonly string[],
  selection: readonly string[] | null,
  adjustmentFactor: number,
): Promise<{ annualSpend: number; basis: string } | null> {
  if (selection == null) {
    return null
  }
  const categoryIds = selection.filter((id) => allExpenseCategoryIds.includes(id))
  if (categoryIds.length === 0) {
    return null
  }
  const annualSpend = Math.round((await trailingAnnualSpend(config, categoryIds)) * adjustmentFactor)
  const basis =
    `${categoryIds.length} categories over ${HISTORY_MONTHS} months to ${currentMonth()} (Plan section selection)` +
    (adjustmentFactor === 1 ? "" : `, × ${Math.round(adjustmentFactor * 100)}% target income`)
  return { annualSpend, basis }
}

// Function to recompute annual spend from the crossover widget's own live selection: the
// categories picked and the date range set in Actual, rather than every category over a fixed
// twelve months. Narrowing either of those in Actual is exactly the edit that used to be lost on
// every regeneration -- reading it back here is what stops it being lost.
async function spendFromCrossover(config: ActualConfig, meta: CrossoverCardMeta): Promise<{ annualSpend: number; basis: string }> {
  const endMonth = meta.timeFrame?.end ?? currentMonth()
  const months = meta.timeFrame ? monthRange(meta.timeFrame.start, meta.timeFrame.end).length : HISTORY_MONTHS
  const monthCache = new Map<string, CategoryMonth[]>()
  let monthlyTotal = 0
  for (const categoryId of meta.expenseCategoryIds) {
    monthlyTotal += averageSpent(await fetchHistoricalSpent(config, categoryId, endMonth, months, monthCache))
  }
  // Actual's own crossover widget calls this "Target Income (% of expenses)" and applies it only to
  // the PROJECTED expense figure that decides its own crossover point (upstream
  // crossover-spreadsheet.ts: adjustedProjectedExpenses = projectedExpenses * expenseAdjustmentFactor),
  // never to the raw historical series it's charted against. Applying it here too -- rather than the
  // plain trailing average -- is what keeps every simulation built on this figure (Monte Carlo, the
  // Bridge chart, the Current numbers box) answering the same spending question Actual's own crossover
  // widget is, instead of silently reverting to 100% the moment someone sets it to anything else.
  // `?? 1`, not a bare read: this value came off a live widget fetched as `unknown`, and upstream
  // itself treats the field as optional with that same default, so CrossoverCardMeta's own
  // non-optional type is a compile-time promise this runtime data was never guaranteed to keep.
  const adjustmentFactor = meta.expenseAdjustmentFactor ?? 1
  const annualSpend = Math.round(monthlyTotal * 12 * adjustmentFactor)
  const basis =
    `${meta.expenseCategoryIds.length} categories over ${months} months to ${endMonth}` +
    (adjustmentFactor === 1 ? "" : `, × ${Math.round(adjustmentFactor * 100)}% target income`)
  return { annualSpend, basis }
}

// Function to read a previously written dashboard file, if any, so mergeGeneratedDashboard can
// preserve customizations made to it. A missing file is normal (first run) and returns null
// silently; a present-but-unreadable/malformed file (never written by this tool, or corrupted)
// falls back to a fresh generation rather than failing the whole run.
function loadExistingDashboard(path: string): ExistingDashboard | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { widgets?: unknown }).widgets)) {
      throw new Error("missing a widgets array")
    }
    return parsed as ExistingDashboard
  } catch {
    return null
  }
}

// Function to read back whatever is actually live on the "FIRE" dashboard page in Actual right
// now, as the merge basis for preserving hand-tuned settings (withdrawal strategy, tax model,
// inflation, safe withdrawal rate, ...) that this app deliberately doesn't expose -- the true
// source of truth once something has been imported, and a real fix over the previous approach of
// merging against the local server-side output file: since Generate downloads to the browser
// rather than only writing a server-side file, that local copy can go stale the moment a person
// tunes a setting inside Actual itself, silently reverting it on the next regenerate. Scoped to a
// page literally named "FIRE" (this tool's own documented convention) specifically so an unrelated
// widget from another page (e.g. a net-worth-card most budgets already have on their main page)
// doesn't get mistaken for this dashboard's own. Returns null -- not an error -- when there's no
// such page yet, or when the run-query endpoint is unavailable (advisory, same as everywhere else
// this repo reads live dashboard state); the caller falls back to the local file in that case.
export async function fetchLiveExistingDashboard(actualConfig: ActualConfig): Promise<ExistingDashboard | null> {
  try {
    const pages = await fetchDashboardPages(actualConfig)
    const firePage = pages.find((page) => page.name.trim().toLowerCase() === "fire")
    if (!firePage) {
      return null
    }
    const widgets = await fetchDashboardWidgets<Record<string, unknown>>(actualConfig, firePage.id)
    return {
      version: 1,
      widgets: widgets.map((widget) => ({
        type: widget.type,
        x: widget.x,
        y: widget.y,
        width: widget.width,
        height: widget.height,
        meta: widget.meta ?? null,
      })),
    }
  } catch {
    return null
  }
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
    })
    if ("error" in payoff || payoff.monthsRemaining <= 0) {
      continue
    }
    streams.push({
      id: `debt-payoff-${account.id}`,
      name: `${account.name} paid off`,
      startAge: currentAge + Math.round(payoff.monthsRemaining / 12),
      annualAmount: account.mortgageMonthlyPayment * 12,
    })
  }
  return streams
}

export interface GenerateOptions {
  outputPath: string
  currentAge: number
  retirementAges: readonly number[]
  planToAge: number
  incomeStreams: readonly RetirementIncomeStream[]
  monteCarloAssumptions: MonteCarloAssumptions
  pinnedMonteCarloFields: ReadonlySet<string>
  // Set on the Plan section instead of Actual's own crossover-card checklist -- see
  // DashboardConfig's own doc comment. Null keeps today's default (every non-income, non-hidden
  // category).
  crossoverExpenseCategoryIds: readonly string[] | null
  // The crossover widget's own remaining assumptions, with the Plan section's overrides already
  // layered in -- see fire-dashboard.ts's crossoverAssumptionsWithOverrides.
  crossoverAssumptions: CrossoverAssumptions
  pinnedCrossoverFields: ReadonlySet<string>
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

export interface GenerateResult {
  portfolioAccountCount: number
  portfolioTotal: number
  expenseCategoryCount: number
  annualSpend: number
  ruleOf55Boosts: RuleOf55Boost[]
  debtPayoffs: DebtPayoff[]
  outputPath: string
  widgetTypes: string[]
  // Where hand-tuned settings (withdrawal strategy, tax model, inflation, safe withdrawal rate,
  // ...) were preserved from, if anywhere -- "live" (a page literally named "FIRE" in Actual right
  // now, the true source of truth once something's been imported) beats "local" (the last file
  // this tool wrote, used only when the live page isn't found or reachable); "none" means nothing
  // to preserve, i.e. this is effectively a first-time generation.
  mergeSource: "live" | "local" | "none"
  // Null when no live crossover widget's own selection could be used, i.e. annualSpend came from
  // this tool's own fallback (every non-income/non-hidden category, trailing 12 months) instead --
  // see generateDashboard's own doc comment on why the fallback is a poor substitute for a
  // narrowed selection once one exists.
  spendBasis: string | null
  // The generated dashboard, pre-serialized -- lets a caller (the web UI) hand it straight to the
  // browser as a download, without a second round trip to re-read what was just written.
  dashboardJson: string
}

// Function to build (or regenerate) the FIRE dashboard from live account/category data and write
// it to outputPath. Crossover/Monte Carlo assumptions are seeded from fire-dashboard.ts's plain
// defaults only when there's nothing to merge against yet -- an existing file's hand-tuned
// assumptions are always preserved by mergeGeneratedDashboard, regardless of what's seeded here.
export async function generateDashboard(
  actualConfig: ActualConfig,
  accounts: readonly ClassifiedAccount[],
  options: GenerateOptions,
): Promise<GenerateResult> {
  const portfolioIds = portfolioAccountIds(accounts)
  if (portfolioIds.length === 0) {
    throw new Error(
      "No accounts are classified as retirement/HSA/investment-taxable -- nothing to build a portfolio from. Classify at least one account first.",
    )
  }

  const groups = await fetchCategoryGroups(actualConfig)
  const expenseCategoryIds = groups.flatMap((group) => group.categories).filter((category) => !category.is_income && !category.hidden).map((category) => category.id)
  if (expenseCategoryIds.length === 0) {
    throw new Error("No non-income, non-hidden categories found -- the crossover widget requires at least one expense category.")
  }

  const liveExisting = await fetchLiveExistingDashboard(actualConfig)
  const localExisting = loadExistingDashboard(options.outputPath)
  const existing = liveExisting ?? localExisting
  const mergeSource: GenerateResult["mergeSource"] = liveExisting ? "live" : localExisting ? "local" : "none"

  // The Plan section's own expense-category selection (see spendFromLocalSelection) takes
  // priority over everything below it. Only when it's unset does this fall back to the live
  // crossover widget's own checklist/date range, and only when neither exists does it fall back
  // further still to this tool's own "every non-income, non-hidden category, trailing 12 months"
  // default -- a poor substitute for a real selection, since it would inflate the Monte Carlo
  // widget's spend well past what a narrowed selection targets.
  // Filtered against the real, currently non-income/non-hidden categories -- see
  // spendFromLocalSelection's own doc comment for why a stale id (a deleted or hidden category)
  // shouldn't reach the widget either.
  const pinnedExpenseCategoryIds = options.crossoverExpenseCategoryIds?.filter((id) => expenseCategoryIds.includes(id)) ?? null
  const localSpend = await spendFromLocalSelection(actualConfig, expenseCategoryIds, options.crossoverExpenseCategoryIds, options.crossoverAssumptions.expenseAdjustmentFactor)
  const liveCrossoverMeta = liveExisting?.widgets.find((widget) => widget.type === "crossover-card")?.meta as CrossoverCardMeta | undefined
  const hasLiveCrossoverSelection = liveCrossoverMeta != null && (liveCrossoverMeta.expenseCategoryIds ?? []).length > 0
  const [spendResult, portfolioBalances] = await Promise.all([
    localSpend
      ? Promise.resolve(localSpend)
      : hasLiveCrossoverSelection
        ? spendFromCrossover(actualConfig, liveCrossoverMeta)
        : trailingAnnualSpend(actualConfig, expenseCategoryIds).then((total) => ({ annualSpend: total, basis: null })),
    Promise.all(portfolioIds.map((accountId) => fetchAccountBalance(actualConfig, accountId, BALANCE_SINCE_DATE))),
  ])
  const { annualSpend, basis: spendBasis } = spendResult
  const portfolioTotal = portfolioBalances.reduce((total, balance) => total + balance, 0)
  const balanceByAccountId = new Map(portfolioIds.map((id, index) => [id, portfolioBalances[index] as number]))

  // Reported against the latest configured retirement age -- effectiveAccessAge's own gate
  // (separationAge <= retirementAge) only gets easier to satisfy as retirementAge grows, so if the
  // boost doesn't apply there, it can't apply for any earlier scenario on this plan either. A
  // summary line for a boost that only some scenarios benefit from is still worth surfacing; the
  // per-scenario widgets themselves (buildMonteCarloWidget) are what actually enforce the cutoff.
  const latestRetirementAge = Math.max(...options.retirementAges)
  const ruleOf55Boosts: RuleOf55Boost[] = []
  for (const account of accounts) {
    const boosted = effectiveAccessAge(account, latestRetirementAge)
    if (boosted !== account.accessAge) {
      ruleOf55Boosts.push({ accountName: account.name, from: account.accessAge, to: boosted as number, amount: balanceByAccountId.get(account.id) ?? 0 })
    }
  }

  const debtStreams = debtPayoffIncomeStreams(accounts, options.currentAge)
  const debtPayoffs: DebtPayoff[] = debtStreams.map((stream) => ({
    accountName: stream.name.replace(/ paid off$/, ""),
    payoffAge: stream.startAge,
    monthlyAmount: Math.round(stream.annualAmount / 12),
  }))
  const incomeStreams = [...options.incomeStreams, ...debtStreams]

  const generated = buildFireDashboard(expenseCategoryIds, portfolioIds, options.crossoverAssumptions, totalMonthlyContribution(accounts))
  generated.widgets.push(
    ...buildMonteCarloWidgets(
      0,
      6,
      accounts,
      options.currentAge,
      options.retirementAges,
      options.planToAge,
      annualSpend,
      options.monteCarloAssumptions,
      incomeStreams,
    ),
  )

  const dashboard = mergeGeneratedDashboard(generated, existing, options.pinnedMonteCarloFields, pinnedExpenseCategoryIds, options.pinnedCrossoverFields)
  const dashboardJson = `${JSON.stringify(dashboard, null, 2)}\n`
  writeFileSync(options.outputPath, dashboardJson)

  return {
    portfolioAccountCount: portfolioIds.length,
    portfolioTotal,
    expenseCategoryCount: expenseCategoryIds.length,
    annualSpend,
    ruleOf55Boosts,
    debtPayoffs,
    outputPath: options.outputPath,
    widgetTypes: dashboard.widgets.map((widget) => widget.type),
    mergeSource,
    spendBasis,
    dashboardJson,
  }
}

export interface CheckOptions {
  currentAge: number
  retirementAges: readonly number[]
  planToAge: number
  // Used only when no crossover widget exists yet to derive real numbers from instead.
  fallbackAnnualSpend: number
  fallbackInflationMean: number
  incomeStreams: readonly RetirementIncomeStream[]
  monteCarloAssumptions: MonteCarloAssumptions
  // Takes priority over a live crossover widget's own checklist when set -- see
  // GenerateOptions.crossoverExpenseCategoryIds and spendFromLocalSelection below.
  crossoverExpenseCategoryIds: readonly string[] | null
  // Only expenseAdjustmentFactor is actually read here (spendFromLocalSelection) -- Check never
  // builds a fresh crossover widget the way Generate does, so the rest of CrossoverAssumptions has
  // nothing to feed here.
  crossoverAssumptions: CrossoverAssumptions
}

export interface AccountContribution {
  accountName: string
  monthlyCents: number
}

export interface CheckResult {
  monteCarloWidgetCount: number
  crossoverWidgetCount: number
  // The plan's own current age and target age -- self-contained rather than relying on the
  // client's own copy (STATE.currentAge/STATE.dashboard.planToAge) staying in sync, since the
  // Monte Carlo and Bridge charts both need these to size a shared x-axis.
  currentAge: number
  planToAge: number
  contributions: AccountContribution[]
  annualSpend: number
  // Null when no crossover widget's selection could be used, i.e. fallbackAnnualSpend was used instead.
  spendBasis: string | null
  inflationMean: number
  staleFindings: Finding[]
  bridgeFindings: Finding[]
  // The full simulation behind bridgeFindings, one entry per retirement age in the same order --
  // bridgeFindings is prose derived from these; this is what the client charts the burndown from.
  bridgeResults: BridgeResult[]
  // The in-app Monte Carlo simulation (src/vendor/monte-carlo/), one entry per retirement age in
  // the same order as bridgeResults -- an alternative to reading the equivalent monte-carlo-card
  // widget off Actual's own dashboard. Empty when an incomplete account (no allocationPreset set)
  // makes buildMonteCarloWidget itself throw -- Generate is where that needs to be a hard stop,
  // not Check.
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
  // The same at-a-glance numbers Generate's own result reports -- current portfolio total and the
  // access-age/spending adjustments already baked into every projection above. Previously only
  // shown as a side effect of clicking Download, which also writes a file and triggers a browser
  // download every time; reading them here costs nothing extra (every value below is already
  // computed, or a cheap pure function over data already fetched, elsewhere in this same function),
  // so the client can show them just by opening or refreshing this tab.
  portfolioAccountCount: number
  portfolioTotal: number
  ruleOf55Boosts: RuleOf55Boost[]
  debtPayoffs: DebtPayoff[]
}

// Function to analyze the dashboard that is actually live in Actual, rather than generating a new
// one. Reads the imported widgets back through ActualQL, so it sees the state a person has been
// editing in the app -- including changes this tool never made.
export async function checkDashboard(
  actualConfig: ActualConfig,
  accounts: readonly ClassifiedAccount[],
  options: CheckOptions,
): Promise<CheckResult> {
  const portfolioIds = portfolioAccountIds(accounts)
  const contributionsAnnualByAccount = new Map(
    accounts.flatMap((account) => (account.monthlyContribution == null ? [] : [[account.id, account.monthlyContribution * 12] as [string, number]])),
  )

  const widgets = await fetchDashboardWidgets<unknown>(actualConfig, null)
  const monteCarloMetas = widgets
    .filter((widget) => widget.type === "monte-carlo-card")
    .map((widget) => widget.meta as MonteCarloCardMeta | null)
    .filter((meta): meta is MonteCarloCardMeta => meta !== null)
  const crossoverMetas = widgets
    .filter((widget) => widget.type === "crossover-card")
    .map((widget) => widget.meta as CrossoverCardMeta | null)
    .filter((meta): meta is CrossoverCardMeta => meta !== null)

  let annualSpend = options.fallbackAnnualSpend
  let spendBasis: string | null = null
  // The Plan section's own selection takes priority over the live crossover widget's own
  // checklist -- same ordering as generateDashboard's spendFromLocalSelection call, so Check and
  // Generate never disagree about which one is authoritative.
  let localSpend: { annualSpend: number; basis: string } | null = null
  if (options.crossoverExpenseCategoryIds != null) {
    const groups = await fetchCategoryGroups(actualConfig)
    const allExpenseCategoryIds = groups.flatMap((group) => group.categories).filter((category) => !category.is_income && !category.hidden).map((category) => category.id)
    localSpend = await spendFromLocalSelection(actualConfig, allExpenseCategoryIds, options.crossoverExpenseCategoryIds, options.crossoverAssumptions.expenseAdjustmentFactor)
  }
  if (localSpend) {
    annualSpend = localSpend.annualSpend
    spendBasis = localSpend.basis
  } else {
    const crossover = crossoverMetas.find((meta) => (meta.expenseCategoryIds ?? []).length > 0)
    if (crossover) {
      const derived = await spendFromCrossover(actualConfig, crossover)
      annualSpend = derived.annualSpend
      spendBasis = derived.basis
    }
  }

  const debtStreams = debtPayoffIncomeStreams(accounts, options.currentAge)
  const incomeStreams = [...options.incomeStreams, ...debtStreams]
  const debtPayoffs: DebtPayoff[] = debtStreams.map((stream) => ({
    accountName: stream.name.replace(/ paid off$/, ""),
    payoffAge: stream.startAge,
    monthlyAmount: Math.round(stream.annualAmount / 12),
  }))

  // Real data (a narrowed crossover category selection, a pension/Social Security figure, a debt
  // nearing payoff, a changed contribution) can drift out from under an already-imported dashboard
  // the instant it changes, since nothing pushes it there automatically -- comparing the live
  // widgets against what Generate would produce for these exact same inputs RIGHT NOW is what
  // actually catches that. Never lets an incomplete "custom" allocation (see
  // returnAssumptionsFor's own throw) fail this whole read-only analysis -- Generate is where that
  // needs to be a hard stop, not Check.
  let spendingPhaseDriftFindings: Finding[] = []
  let widgetSetDriftFindings: Finding[] = []
  try {
    const freshWidgets = buildMonteCarloWidgets(0, 6, accounts, options.currentAge, options.retirementAges, options.planToAge, annualSpend, options.monteCarloAssumptions, incomeStreams)
    spendingPhaseDriftFindings = detectSpendingPhaseDrift(freshWidgets, monteCarloMetas)
    widgetSetDriftFindings = detectMonteCarloWidgetSetDrift(freshWidgets, monteCarloMetas)
  } catch {
    // Leave both empty -- the other drift checks below still run, and Generate will surface the
    // same incomplete-config error clearly if the person tries it.
  }

  const staleFindings: Finding[] =
    monteCarloMetas.length === 0
      ? []
      : [
          ...detectPotDrift(monteCarloMetas, accounts, options.retirementAges),
          ...widgetSetDriftFindings,
          ...spendingPhaseDriftFindings,
        ]

  // Prefer the inflation the live dashboard is actually simulating with; fall back only when
  // nothing has been imported yet.
  const inflationMean = monteCarloMetas[0]?.inflationMean ?? options.fallbackInflationMean

  const transactionEntries = await Promise.all(
    portfolioIds.map(async (accountId): Promise<[string, Transaction[]]> => [accountId, await fetchAccountTransactions(actualConfig, accountId, BALANCE_SINCE_DATE)]),
  )
  const transactionsByAccount = new Map(transactionEntries)
  const balances = new Map(portfolioIds.map((accountId) => [accountId, sumTransactionAmounts(transactionsByAccount.get(accountId) ?? [])]))
  const portfolioTotal = portfolioIds.reduce((total, accountId) => total + (balances.get(accountId) ?? 0), 0)

  // How far back to extend the Bridge/Monte Carlo charts' x-axis before currentAge: real
  // transaction history, capped at a few years so a decades-old account doesn't turn the chart
  // into a full net-worth history. Bounded by the earliest transaction across ALL portfolio
  // accounts (the one with the longest history), not the shortest -- an account opened more
  // recently than that just correctly contributes $0 for the years before it existed, same as it
  // would if it just hadn't been opened yet.
  const HISTORY_LOOKBACK_YEARS_MAX = 5
  const today = new Date().toISOString().slice(0, 10)
  const allTransactionDates = [...transactionsByAccount.values()].flat().map((transaction) => transaction.date).filter((date) => date <= today)
  const earliestTransactionDate = allTransactionDates.length > 0 ? allTransactionDates.reduce((min, date) => (date < min ? date : min)) : today
  const historyYearsBack = Math.min(HISTORY_LOOKBACK_YEARS_MAX, ageFromBirthDate(earliestTransactionDate))
  // Oldest first, so a chart can just concat this in front of its own forward-looking data.
  const historicalAges = Array.from({ length: historyYearsBack }, (_, index) => options.currentAge - historyYearsBack + index)
  const historicalBalancesByAge = new Map(
    historicalAges.map((age) => {
      const cutoff = addMonthsToDate(today, -12 * (options.currentAge - age))
      return [
        age,
        new Map(portfolioIds.map((accountId) => [accountId, sumTransactionAmounts((transactionsByAccount.get(accountId) ?? []).filter((transaction) => transaction.date <= cutoff))])),
      ] as const
    }),
  )
  const monteCarloHistory = historicalAges.map((age) => ({
    age,
    totalBalance: portfolioIds.reduce((total, accountId) => total + (historicalBalancesByAge.get(age)?.get(accountId) ?? 0), 0),
  }))

  // Reported against the latest configured retirement age, same as Generate's own identical loop:
  // effectiveAccessAge's own gate (separationAge <= retirementAge) only gets easier to satisfy as
  // retirementAge grows, so a boost that doesn't apply there can't apply for any earlier scenario
  // on this plan either.
  const latestRetirementAge = Math.max(...options.retirementAges)
  const ruleOf55Boosts: RuleOf55Boost[] = []
  for (const account of accounts) {
    const boosted = effectiveAccessAge(account, latestRetirementAge)
    if (boosted !== account.accessAge) {
      ruleOf55Boosts.push({ accountName: account.name, from: account.accessAge, to: boosted as number, amount: balances.get(account.id) ?? 0 })
    }
  }

  // Simulated once per retirement age and kept in full -- bridgeFindings below is prose derived
  // from these results, not a second computation, so the two can never disagree. history is real,
  // not simulated, so it's computed here rather than inside simulateBridge itself (which only ever
  // sees a single snapshot balance per account, not a series of them) -- effectiveAccessAge (via
  // toBridgeAccounts) still depends on retirementAge, so it's resolved per scenario like everything
  // else here, not shared across them the way monteCarloHistory above is.
  const bridgeResults = options.retirementAges.map((retirementAge) => {
    const currentBridgeAccounts = toBridgeAccounts(accounts, balances, contributionsAnnualByAccount, retirementAge)
    const result = simulateBridge(currentBridgeAccounts, options.currentAge, retirementAge, options.planToAge, annualSpend, inflationMean, incomeStreams)
    // Ends on a real point at currentAge itself (today's live balance, not a historical one) --
    // ties the last real-history year to "now" so the chart has something to draw a line between
    // even with only one year of lookback, and (for a retirementAge equal to currentAge) meets
    // timeline's own first point exactly rather than leaving a one-year gap right before it.
    const history = [
      ...historicalAges.map((age) => historicalBridgeYear(toBridgeAccounts(accounts, historicalBalancesByAge.get(age) as Map<string, number>, contributionsAnnualByAccount, retirementAge), age)),
      ...(historicalAges.length > 0 ? [historicalBridgeYear(currentBridgeAccounts, options.currentAge)] : []),
    ]
    return { ...result, history }
  })
  const bridgeFindings = bridgeResults.map((result) => bridgeFinding(result, options.planToAge))

  // Simulated once per retirement age, same order as bridgeResults; monteCarloFindings below is
  // prose derived from these same results, not a second computation. Never lets an incomplete
  // "custom" allocation (see returnAssumptionsFor's own throw, reached via buildMonteCarloWidget)
  // fail this whole read-only analysis -- Generate is where that needs to be a hard stop, not Check.
  // Skipped entirely with no portfolio accounts at all: the vendored engine's own
  // runMonteCarloSimulation falls back to a single fake $500,000 pot (MONTE_CARLO_DEFAULTS.pots)
  // for an empty pots array rather than simulating nothing, which would otherwise chart fabricated
  // data for a plan with no real portfolio yet.
  let monteCarloByAge: { retirementAge: number; result: MonteCarloSummary }[] = []
  if (portfolioIds.length > 0) {
    try {
      monteCarloByAge = options.retirementAges.map((retirementAge) => ({
        retirementAge,
        result: runRetirementMonteCarlo(accounts, balances, options.currentAge, retirementAge, options.planToAge, annualSpend, options.monteCarloAssumptions, incomeStreams),
      }))
    } catch {
      // Leave empty -- Generate will surface the same incomplete-config error clearly if attempted.
    }
  }
  const monteCarloResults: MonteCarloResultEntry[] = monteCarloByAge.map((entry) => ({ ...entry.result, retirementAge: entry.retirementAge }))
  const monteCarloFindings = monteCarloByAge.map((entry) => monteCarloFinding(entry.result, options.currentAge, entry.retirementAge, options.planToAge))

  return {
    monteCarloWidgetCount: monteCarloMetas.length,
    currentAge: options.currentAge,
    planToAge: options.planToAge,
    crossoverWidgetCount: crossoverMetas.length,
    contributions: accounts
      .filter((account) => portfolioIds.includes(account.id))
      .map((account) => ({ accountName: account.name, monthlyCents: Math.round((contributionsAnnualByAccount.get(account.id) ?? 0) / 12) })),
    annualSpend,
    spendBasis,
    inflationMean,
    staleFindings,
    bridgeFindings,
    bridgeResults,
    monteCarloResults,
    monteCarloFindings,
    monteCarloHistory,
    portfolioAccountCount: portfolioIds.length,
    portfolioTotal,
    ruleOf55Boosts,
    debtPayoffs,
  }
}

// Re-exported so callers (app-server.ts) can format a thrown error consistently with the rest of
// this repo without importing actual-helpers.ts twice for one function.
export { formatError }
