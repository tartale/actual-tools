import {
  addMonthsToDate,
  ageFromBirthDate,
  averageSpent,
  fetchAccountTransactions,
  fetchCategoryGroups,
  fetchDashboardWidgets,
  fetchHistoricalSpent,
  formatError,
  sumTransactionAmounts,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth, Transaction } from "./actual-helpers.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
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
import type { FederalTaxBrackets, FilingStatus } from "./federal-tax-brackets.ts"

// The non-CLI guts of what used to be reports-fire.ts's main(): fetching real data and analyzing
// the dashboard, returning a plain structured result rather than printing one -- consumed by
// app-server.ts's /api/retirement/check route, and directly unit-testable without capturing
// stdout. (Used to also build and write a fresh dashboard for Export to Dashboard -- removed
// entirely, along with the drift-detection findings that only existed to nudge a re-export.)

// The API has no running-balance field; summing an account's full transaction history is the
// accounting identity used instead, so this must reach back further than any real account could
// have existed.
const BALANCE_SINCE_DATE = "1970-01-01"

// Function to get the current month as a yyyy-mm string
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Function to sum the trailing-N-month average spend across every given category -- N is
// historyMonths, a Plan-section-tunable setting (see fire-dashboard.ts's
// spendHistoryMonthsWithOverride), not a fixed constant.
async function trailingAnnualSpend(config: ActualConfig, categoryIds: readonly string[], historyMonths: number): Promise<number> {
  const month = currentMonth()
  const monthCache = new Map<string, CategoryMonth[]>()
  let monthlyTotal = 0
  for (const categoryId of categoryIds) {
    const history = await fetchHistoricalSpent(config, categoryId, month, historyMonths, monthCache)
    monthlyTotal += averageSpent(history)
  }
  return monthlyTotal * 12
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
): Promise<{ annualSpend: number; basis: string | null }> {
  const categoryIds = selection?.filter((id) => allExpenseCategoryIds.includes(id)) ?? []
  if (categoryIds.length === 0) {
    const annualSpend = Math.round(await trailingAnnualSpend(config, allExpenseCategoryIds, historyMonths))
    return { annualSpend, basis: null }
  }
  const annualSpend = Math.round((await trailingAnnualSpend(config, categoryIds, historyMonths)) * adjustmentFactor)
  const basis =
    `${categoryIds.length} categories over ${historyMonths} months to ${currentMonth()} (Plan section selection)` +
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
  // Both needed for the MAGI/effective-tax-rate finding (see magiFinding in fire-analysis.ts) --
  // either missing just skips that finding entirely (checkDashboard), the same "absent, not an
  // error" convention as ruleOf55Boosts/debtPayoffs.
  filingStatus: FilingStatus | null
  federalTaxBrackets: FederalTaxBrackets | null
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

  // Entirely local -- see spendFromLocalSelection's own doc comment for why this never falls back
  // to reading a live Actual crossover widget's own checklist.
  const groups = await fetchCategoryGroups(actualConfig)
  const allExpenseCategoryIds = groups.flatMap((group) => group.categories).filter((category) => !category.is_income && !category.hidden).map((category) => category.id)
  const { annualSpend, basis: spendBasis } = await spendFromLocalSelection(
    actualConfig,
    allExpenseCategoryIds,
    options.crossoverExpenseCategoryIds,
    options.expenseAdjustmentFactor,
    options.spendHistoryMonths,
  )

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
  // The same gross-inflate formula simulateBridge's own loop applies for its projectedSpend field
  // (income NOT netted out -- see BridgeYear's own doc comment for why), for an arbitrary age
  // rather than a running simulation -- scenario-independent (annualSpend/inflationMean don't vary
  // by retirementAge), so computed once and reused across every scenario's own history below,
  // rather than duplicated inline for each. For an age before currentAge, the negative exponent
  // runs the same formula backward: what this plan's projected expenses were worth back then, not a
  // claim about what was actually spent.
  const projectedSpendAt = (age: number): number => annualSpend * Math.pow(1 + inflationMean, age - options.currentAge)

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
      ...historicalAges.map((age) => historicalBridgeYear(toBridgeAccounts(accounts, historicalBalancesByAge.get(age) as Map<string, number>, contributionsAnnualByAccount, retirementAge), age, projectedSpendAt(age))),
      ...(historicalAges.length > 0 ? [historicalBridgeYear(currentBridgeAccounts, options.currentAge, projectedSpendAt(options.currentAge))] : []),
    ]
    return { ...result, history }
  })
  // A second finding per scenario, right after its own funding-status finding, estimating that
  // year's MAGI/effective-tax-rate -- see magiFinding's own doc comment for the simplifying
  // assumptions. Skipped (not an error) whenever filing status or the tax-bracket table is missing,
  // same convention as ruleOf55Boosts/debtPayoffs being empty rather than reported as broken.
  const bridgeFindings = bridgeResults.flatMap((result) => {
    const findings = [bridgeFinding(result, options.planToAge)]
    if (options.filingStatus != null && options.federalTaxBrackets != null) {
      const retirementAge = result.retirementAge
      // incomeStreams here is the FULL merged set (pension/SS + any debt-freed-up cash flow) --
      // matches simulateBridge's own netting exactly, so a paid-off mortgage correctly lowers the
      // withdrawal this estimates without also being (wrongly) treated as taxable income itself.
      const incomeAtRetirement = incomeStreams.filter((s) => s.startAge <= retirementAge).reduce((sum, s) => sum + s.annualAmount, 0)
      const grossTaxDeferredWithdrawal = Math.max(0, projectedSpendAt(retirementAge) - incomeAtRetirement)
      // options.incomeStreams (pension/SS only, pre-merge) for the RAW figures MAGI needs as their
      // own separate ordinary-income lines -- already netted out of grossTaxDeferredWithdrawal
      // above, so adding them back here (rather than re-deriving them some other way) is what keeps
      // the total modeled income correct instead of double-subtracting them.
      const pensionIncome = options.incomeStreams.find((s) => s.id === "pension" && s.startAge <= retirementAge)?.annualAmount ?? 0
      const socialSecurityBenefit = options.incomeStreams.find((s) => s.id === "social-security" && s.startAge <= retirementAge)?.annualAmount ?? 0
      findings.push(magiFinding(retirementAge, pensionIncome, socialSecurityBenefit, grossTaxDeferredWithdrawal, options.filingStatus, options.federalTaxBrackets))
    }
    return findings
  })

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
        result: runRetirementMonteCarlo(accounts, balances, options.currentAge, retirementAge, options.planToAge, annualSpend, options.monteCarloAssumptions, incomeStreams),
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
  }
}

// Re-exported so callers (app-server.ts) can format a thrown error consistently with the rest of
// this repo without importing actual-helpers.ts twice for one function.
export { formatError }
