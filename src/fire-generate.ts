import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  averageSpent,
  fetchAccountBalance,
  fetchCategoryGroups,
  fetchDashboardPages,
  fetchDashboardWidgets,
  fetchHistoricalSpent,
  formatError,
  monthRange,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import {
  DEFAULT_CROSSOVER_ASSUMPTIONS,
  buildFireDashboard,
  buildMonteCarloWidgets,
  effectiveAccessAge,
  mergeGeneratedDashboard,
  portfolioAccountIds,
  totalMonthlyContribution,
} from "./fire-dashboard.ts"
import type { CrossoverCardMeta, ExistingDashboard, MonteCarloAssumptions, MonteCarloCardMeta, RetirementIncomeStream } from "./fire-dashboard.ts"
import {
  bridgeFinding,
  calculateMortgagePayoff,
  detectCrossoverMismatch,
  detectMonteCarloSettingsDrift,
  detectPotDrift,
  detectSpendingPhaseDrift,
  simulateBridge,
  toBridgeAccounts,
} from "./fire-analysis.ts"
import type { BridgeResult, Finding } from "./fire-analysis.ts"

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
  return {
    annualSpend: monthlyTotal * 12,
    basis: `${meta.expenseCategoryIds.length} categories over ${months} months to ${endMonth}`,
  }
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

// The crossover/Monte Carlo assumption fields this app never lets the user edit directly (safe
// withdrawal rate, tax model, inflation, withdrawal strategy, ...) -- Actual's own dashboard UI is
// the only place to change them, and mergeGeneratedDashboard exists specifically to leave them
// alone on every regenerate. Surfaced read-only in the Plan section (see PATCH-free
// GET /api/retirement/live-settings) so a person can see what's actually live without opening
// Actual, and so it's obvious when a "Simulation settings" field they've pinned here (see
// fire-dashboard.ts's monteCarloAssumptionsWithOverrides) hasn't propagated to Actual yet.
export interface LiveDashboardSettings {
  crossover: {
    safeWithdrawalRate: number
    estimatedReturn: number | null
    projectionType: string
    expenseAdjustmentFactor: number
  } | null
  monteCarlo: {
    withdrawalStrategy: string | null
    returnModel: string | null
    withdrawalRuleType: string
    minimumWithdrawal: number
    inflationMean: number | null
    inflationStdDev: number
    taxModel: string
    simulationCount: number
  } | null
}

// Function to summarize whatever's actually live on the "FIRE" dashboard page -- reuses
// fetchLiveExistingDashboard's own fetch (same page, same widgets) rather than a second ActualQL
// round trip. Returns all-null (not an error) when there's no such page yet, matching this
// function's own "advisory" convention.
export async function fetchLiveDashboardSettings(actualConfig: ActualConfig): Promise<LiveDashboardSettings> {
  const dashboard = await fetchLiveExistingDashboard(actualConfig)
  if (!dashboard) {
    return { crossover: null, monteCarlo: null }
  }
  const crossoverMeta = dashboard.widgets.find((widget) => widget.type === "crossover-card")?.meta as CrossoverCardMeta | undefined
  const monteCarloMeta = dashboard.widgets.find((widget) => widget.type === "monte-carlo-card")?.meta as MonteCarloCardMeta | undefined
  return {
    crossover: crossoverMeta
      ? {
          safeWithdrawalRate: crossoverMeta.safeWithdrawalRate,
          estimatedReturn: crossoverMeta.estimatedReturn,
          projectionType: crossoverMeta.projectionType,
          expenseAdjustmentFactor: crossoverMeta.expenseAdjustmentFactor,
        }
      : null,
    monteCarlo: monteCarloMeta
      ? {
          withdrawalStrategy: monteCarloMeta.withdrawalStrategy ?? null,
          returnModel: monteCarloMeta.returnModel ?? null,
          withdrawalRuleType: monteCarloMeta.withdrawalRule?.type ?? "none",
          minimumWithdrawal: monteCarloMeta.minimumWithdrawal ?? 0,
          inflationMean: monteCarloMeta.inflationMean ?? null,
          inflationStdDev: monteCarloMeta.inflationStdDev ?? 0,
          taxModel: monteCarloMeta.taxModel ?? "flat",
          simulationCount: monteCarloMeta.simulationCount ?? 0,
        }
      : null,
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
}

export interface RuleOf55Boost {
  accountName: string
  from: number | null
  to: number
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

  // Prefer the live crossover widget's own selection and date range for annual spend, same as
  // checkDashboard already does via spendFromCrossover -- this tool's own "every non-income,
  // non-hidden category, trailing 12 months" default exists only for a page that doesn't exist
  // yet. Once a person has narrowed the crossover's own checklist (excluding one-time trip
  // categories, a dependent's separate expenses, ...), falling back to the broader default here
  // would inflate the Monte Carlo widget's spend well past what the crossover itself targets --
  // exactly the mismatch a person comparing the two widgets would notice.
  const liveCrossoverMeta = liveExisting?.widgets.find((widget) => widget.type === "crossover-card")?.meta as CrossoverCardMeta | undefined
  const hasLiveCrossoverSelection = liveCrossoverMeta != null && (liveCrossoverMeta.expenseCategoryIds ?? []).length > 0
  const [spendResult, portfolioBalances] = await Promise.all([
    hasLiveCrossoverSelection
      ? spendFromCrossover(actualConfig, liveCrossoverMeta)
      : trailingAnnualSpend(actualConfig, expenseCategoryIds).then((total) => ({ annualSpend: total, basis: null })),
    Promise.all(portfolioIds.map((accountId) => fetchAccountBalance(actualConfig, accountId, BALANCE_SINCE_DATE))),
  ])
  const { annualSpend, basis: spendBasis } = spendResult
  const portfolioTotal = portfolioBalances.reduce((total, balance) => total + balance, 0)

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
      ruleOf55Boosts.push({ accountName: account.name, from: account.accessAge, to: boosted as number })
    }
  }

  const debtStreams = debtPayoffIncomeStreams(accounts, options.currentAge)
  const debtPayoffs: DebtPayoff[] = debtStreams.map((stream) => ({
    accountName: stream.name.replace(/ paid off$/, ""),
    payoffAge: stream.startAge,
    monthlyAmount: Math.round(stream.annualAmount / 12),
  }))
  const incomeStreams = [...options.incomeStreams, ...debtStreams]

  const generated = buildFireDashboard(expenseCategoryIds, portfolioIds, DEFAULT_CROSSOVER_ASSUMPTIONS, totalMonthlyContribution(accounts))
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

  const dashboard = mergeGeneratedDashboard(generated, existing, options.pinnedMonteCarloFields)
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
  pinnedMonteCarloFields: ReadonlySet<string>
}

export interface AccountContribution {
  accountName: string
  monthlyCents: number
}

export interface CheckResult {
  monteCarloWidgetCount: number
  crossoverWidgetCount: number
  contributions: AccountContribution[]
  annualSpend: number
  // Null when no crossover widget's selection could be used, i.e. fallbackAnnualSpend was used instead.
  spendBasis: string | null
  inflationMean: number
  driftFindings: Finding[]
  bridgeFindings: Finding[]
  // The full simulation behind bridgeFindings, one entry per retirement age in the same order --
  // bridgeFindings is prose derived from these; this is what the client charts the burndown from.
  bridgeResults: BridgeResult[]
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
  const crossover = crossoverMetas.find((meta) => (meta.expenseCategoryIds ?? []).length > 0)
  if (crossover) {
    const derived = await spendFromCrossover(actualConfig, crossover)
    annualSpend = derived.annualSpend
    spendBasis = derived.basis
  }

  const incomeStreams = [...options.incomeStreams, ...debtPayoffIncomeStreams(accounts, options.currentAge)]

  // Real data (a narrowed crossover category selection, a pension/Social Security figure, a debt
  // nearing payoff, a changed contribution) can drift out from under an already-imported dashboard
  // the instant it changes, since nothing pushes it there automatically -- comparing the live
  // widgets against what Generate would produce for these exact same inputs RIGHT NOW is what
  // actually catches that. Never lets an incomplete "custom" allocation (see
  // returnAssumptionsFor's own throw) fail this whole read-only analysis -- Generate is where that
  // needs to be a hard stop, not Check.
  let spendingPhaseDriftFindings: Finding[] = []
  try {
    const freshWidgets = buildMonteCarloWidgets(0, 6, accounts, options.currentAge, options.retirementAges, options.planToAge, annualSpend, options.monteCarloAssumptions, incomeStreams)
    spendingPhaseDriftFindings = detectSpendingPhaseDrift(freshWidgets, monteCarloMetas)
  } catch {
    // Leave it empty -- the other drift checks below still run, and Generate will surface the
    // same incomplete-config error clearly if the person tries it.
  }

  const driftFindings: Finding[] =
    monteCarloMetas.length === 0
      ? [
          {
            level: "warn",
            title: "No Monte Carlo widgets found in any dashboard page.",
            detail: ["Generate and import first, then Reports -> new page -> \"...\" -> Import."],
          },
        ]
      : [
          ...detectPotDrift(monteCarloMetas, accounts, options.retirementAges),
          ...detectCrossoverMismatch(crossoverMetas, accounts),
          ...detectMonteCarloSettingsDrift(monteCarloMetas, options.pinnedMonteCarloFields, options.monteCarloAssumptions),
          ...spendingPhaseDriftFindings,
        ]

  // Prefer the inflation the live dashboard is actually simulating with; fall back only when
  // nothing has been imported yet.
  const inflationMean = monteCarloMetas[0]?.inflationMean ?? options.fallbackInflationMean

  const balanceEntries = await Promise.all(
    portfolioIds.map(async (accountId): Promise<[string, number]> => [accountId, await fetchAccountBalance(actualConfig, accountId, BALANCE_SINCE_DATE)]),
  )
  const balances = new Map(balanceEntries)
  // Simulated once per retirement age and kept in full -- bridgeFindings below is prose derived
  // from these results, not a second computation, so the two can never disagree.
  const bridgeResults = options.retirementAges.map((retirementAge) =>
    simulateBridge(
      toBridgeAccounts(accounts, balances, contributionsAnnualByAccount, retirementAge),
      options.currentAge,
      retirementAge,
      options.planToAge,
      annualSpend,
      inflationMean,
      incomeStreams,
    ),
  )
  const bridgeFindings = bridgeResults.map((result) => bridgeFinding(result, options.planToAge))

  return {
    monteCarloWidgetCount: monteCarloMetas.length,
    crossoverWidgetCount: crossoverMetas.length,
    contributions: accounts
      .filter((account) => portfolioIds.includes(account.id))
      .map((account) => ({ accountName: account.name, monthlyCents: Math.round((contributionsAnnualByAccount.get(account.id) ?? 0) / 12) })),
    annualSpend,
    spendBasis,
    inflationMean,
    driftFindings,
    bridgeFindings,
    bridgeResults,
  }
}

// Re-exported so callers (app-server.ts) can format a thrown error consistently with the rest of
// this repo without importing actual-helpers.ts twice for one function.
export { formatError }
