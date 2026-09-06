import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  averageSpent,
  fetchAccountBalance,
  fetchCategoryGroups,
  fetchDashboardWidgets,
  fetchHistoricalSpent,
  formatError,
  monthRange,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import {
  DEFAULT_CROSSOVER_ASSUMPTIONS,
  DEFAULT_MONTE_CARLO_ASSUMPTIONS,
  buildFireDashboard,
  buildMonteCarloWidgets,
  effectiveAccessAge,
  mergeGeneratedDashboard,
  portfolioAccountIds,
  totalMonthlyContribution,
} from "./fire-dashboard.ts"
import type { CrossoverCardMeta, ExistingDashboard, MonteCarloCardMeta } from "./fire-dashboard.ts"
import { bridgeFinding, detectCrossoverMismatch, detectPotDrift, simulateBridge, toBridgeAccounts } from "./fire-analysis.ts"
import type { Finding } from "./fire-analysis.ts"

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

export interface GenerateOptions {
  outputPath: string
  currentAge: number
  retirementAges: readonly number[]
  planToAge: number
}

export interface RuleOf55Boost {
  accountName: string
  from: number | null
  to: number
}

export interface GenerateResult {
  portfolioAccountCount: number
  portfolioTotal: number
  expenseCategoryCount: number
  annualSpend: number
  ruleOf55Boosts: RuleOf55Boost[]
  outputPath: string
  widgetTypes: string[]
  preservedExisting: boolean
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

  const [annualSpend, portfolioBalances] = await Promise.all([
    trailingAnnualSpend(actualConfig, expenseCategoryIds),
    Promise.all(portfolioIds.map((accountId) => fetchAccountBalance(actualConfig, accountId, BALANCE_SINCE_DATE))),
  ])
  const portfolioTotal = portfolioBalances.reduce((total, balance) => total + balance, 0)

  const ruleOf55Boosts: RuleOf55Boost[] = []
  for (const account of accounts) {
    const boosted = effectiveAccessAge(account)
    if (boosted !== account.accessAge) {
      ruleOf55Boosts.push({ accountName: account.name, from: account.accessAge, to: boosted as number })
    }
  }

  const generated = buildFireDashboard(expenseCategoryIds, portfolioIds, DEFAULT_CROSSOVER_ASSUMPTIONS, totalMonthlyContribution(accounts))
  generated.widgets.push(
    ...buildMonteCarloWidgets(0, 6, accounts, options.currentAge, options.retirementAges, options.planToAge, annualSpend, DEFAULT_MONTE_CARLO_ASSUMPTIONS),
  )

  const existing = loadExistingDashboard(options.outputPath)
  const dashboard = mergeGeneratedDashboard(generated, existing)
  writeFileSync(options.outputPath, `${JSON.stringify(dashboard, null, 2)}\n`)

  return {
    portfolioAccountCount: portfolioIds.length,
    portfolioTotal,
    expenseCategoryCount: expenseCategoryIds.length,
    annualSpend,
    ruleOf55Boosts,
    outputPath: options.outputPath,
    widgetTypes: dashboard.widgets.map((widget) => widget.type),
    preservedExisting: existing !== null,
  }
}

export interface CheckOptions {
  currentAge: number
  retirementAges: readonly number[]
  planToAge: number
  // Used only when no crossover widget exists yet to derive real numbers from instead.
  fallbackAnnualSpend: number
  fallbackInflationMean: number
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

  const driftFindings: Finding[] =
    monteCarloMetas.length === 0
      ? [
          {
            level: "warn",
            title: "No Monte Carlo widgets found in any dashboard page.",
            detail: ["Generate and import first, then Reports -> new page -> \"...\" -> Import."],
          },
        ]
      : [...detectPotDrift(monteCarloMetas, accounts), ...detectCrossoverMismatch(crossoverMetas, accounts)]

  // Prefer the inflation the live dashboard is actually simulating with; fall back only when
  // nothing has been imported yet.
  const inflationMean = monteCarloMetas[0]?.inflationMean ?? options.fallbackInflationMean

  const balanceEntries = await Promise.all(
    portfolioIds.map(async (accountId): Promise<[string, number]> => [accountId, await fetchAccountBalance(actualConfig, accountId, BALANCE_SINCE_DATE)]),
  )
  const balances = new Map(balanceEntries)
  const bridgeAccounts = toBridgeAccounts(accounts, balances, contributionsAnnualByAccount)
  const bridgeFindings = options.retirementAges.map((retirementAge) =>
    bridgeFinding(simulateBridge(bridgeAccounts, options.currentAge, retirementAge, options.planToAge, annualSpend, inflationMean), options.planToAge),
  )

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
  }
}

// Re-exported so callers (app-server.ts) can format a thrown error consistently with the rest of
// this repo without importing actual-helpers.ts twice for one function.
export { formatError }
