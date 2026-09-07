// Non-CLI guts of `./actual budget set-values`/`anomalies`: the same pure orchestration those two
// commands already did, restructured into plain async functions returning structured results
// instead of a loop full of console.log -- so both the CLI (a thin formatter over these, same split
// fire-generate.ts already established for the retirement side) and the app server's /api/budget/
// routes read from one shared implementation instead of two copies of the same logic drifting apart.

import {
  addMonths,
  addTagToNotes,
  computeBalanceBudget,
  computeHistoricalBudget,
  fetchAllTransactionsSince,
  fetchCategoryGroups,
  fetchHistoricalSpent,
  fetchPreviousBudgeted,
  findIncomeFilterMatches,
  getCachedMonthCategories,
  groupNameById,
  monthRange,
  patchCategoryBudget,
  patchTransactionNotes,
  shouldUpdateCategory,
  HISTORY_MONTHS,
} from "./actual-helpers.ts"
import type { Action, ActualConfig, CategoryMonth, Transaction } from "./actual-helpers.ts"
import { detectAnomaly } from "./anomaly-detect.ts"
import type { AnomalyDirection } from "./anomaly-detect.ts"

// --- set-values ---

export type BudgetLineStatus = "unchanged" | "would-update" | "skipped" | "updated"

export interface BudgetLineResult {
  month: string
  categoryId: string
  categoryName: string
  status: BudgetLineStatus
  oldBudgeted: number
  newBudgeted: number
  balance: number
}

export interface BudgetMonthResult {
  month: string
  lines: BudgetLineResult[]
}

export interface SetBudgetValuesOptions {
  action: Action | number
  startMonth: string
  endMonth: string
  categories: string[]
  dryRun: boolean
  // Called once per category/month that would actually change, right before it's applied --
  // return false to skip it. Omitted (the web UI's own usage) means always apply once dryRun is
  // false; only the CLI's own -i/--interactive flag supplies one, via confirmViaTty.
  confirm?: (line: BudgetLineResult) => Promise<boolean>
}

// Function to compute the budgeted amount a given action (or literal dollar amount) wants for a category
async function computeNewBudget(
  config: ActualConfig,
  action: Action | number,
  category: CategoryMonth,
  month: string,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number> {
  if (typeof action === "number") {
    return action
  }
  if (action === "balance") {
    return computeBalanceBudget(category)
  }
  if (action === "previous") {
    return fetchPreviousBudgeted(config, category.id, month, monthCache)
  }
  return computeHistoricalBudget(config, category.id, month, HISTORY_MONTHS[action], monthCache)
}

// Function to set category budgets for a month, or an inclusive range of months -- the shared
// implementation behind `./actual budget set-values` and `POST /api/budget/set-values`. Grouped by
// month (not a flat list) so a caller can print/render "all categories done for this month" per
// month even when a month produced zero lines (e.g. every category filtered out), matching what
// the CLI has always printed.
export async function setBudgetValues(config: ActualConfig, options: SetBudgetValuesOptions): Promise<BudgetMonthResult[]> {
  let groupNames = new Map<string, string>()
  if (options.categories.length > 0) {
    const groups = await fetchCategoryGroups(config)
    const incomeFilters = findIncomeFilterMatches(options.categories, groups)
    if (incomeFilters.length > 0) {
      throw new Error(`Category filter matched an income category or group, which is never a valid update target: ${incomeFilters.join(", ")}`)
    }
    groupNames = groupNameById(groups)
  }

  const monthCache = new Map<string, CategoryMonth[]>()
  const monthResults: BudgetMonthResult[] = []

  for (const month of monthRange(options.startMonth, options.endMonth)) {
    const categories = await getCachedMonthCategories(config, month, monthCache)
    const lines: BudgetLineResult[] = []

    for (const category of categories) {
      if (!shouldUpdateCategory(category, options.categories, groupNames)) {
        continue
      }
      // The balance action has nothing to zero out when the month saw no activity at all.
      if (options.action === "balance" && category.spent === 0 && category.balance === 0) {
        continue
      }

      const newBudgeted = await computeNewBudget(config, options.action, category, month, monthCache)
      const base = { month, categoryId: category.id, categoryName: category.name, oldBudgeted: category.budgeted, newBudgeted, balance: category.balance }

      if (newBudgeted === category.budgeted) {
        lines.push({ ...base, status: "unchanged" })
        continue
      }
      if (options.dryRun) {
        lines.push({ ...base, status: "would-update" })
        continue
      }
      if (options.confirm) {
        const confirmed = await options.confirm({ ...base, status: "would-update" })
        if (!confirmed) {
          lines.push({ ...base, status: "skipped" })
          continue
        }
      }
      await patchCategoryBudget(config, month, category.id, newBudgeted)
      lines.push({ ...base, status: "updated" })
    }

    monthResults.push({ month, lines })
  }

  return monthResults
}

// --- budget table (a read-only grid for the web UI's category picker/preview -- no CLI equivalent) ---

// The most months of budgeted/spent/balance the table renders side by side -- unbounded would let
// a wide start/end range (the same range the bulk action itself still applies across in full)
// request and render an unusably wide grid; this caps just the table's own display, not what
// setBudgetValues/findAnomalies actually operate on.
export const BUDGET_TABLE_MAX_MONTHS = 6

export interface BudgetTableCategory {
  id: string
  name: string
  months: Record<string, { budgeted: number; spent: number; balance: number }>
}

export interface BudgetTableGroup {
  id: string
  name: string
  categories: BudgetTableCategory[]
}

export interface BudgetTable {
  months: string[]
  groups: BudgetTableGroup[]
}

// Function to fetch a read-only budgeted/spent/balance grid, one column-group per month (capped at
// BUDGET_TABLE_MAX_MONTHS, taken from the START of the requested range -- the range's own start is
// what a person is most likely mid-editing right now), grouped and ordered the same way Actual's
// own category groups are, income excluded (never a valid target for either budget tool, so never
// worth showing here either).
export async function fetchBudgetTable(config: ActualConfig, startMonth: string, endMonth: string): Promise<BudgetTable> {
  const months = monthRange(startMonth, endMonth).slice(0, BUDGET_TABLE_MAX_MONTHS)
  const monthCache = new Map<string, CategoryMonth[]>()
  const categoriesByMonth = await Promise.all(months.map((month) => getCachedMonthCategories(config, month, monthCache)))
  const byMonthThenCategory = new Map(months.map((month, index) => [month, new Map((categoriesByMonth[index] as CategoryMonth[]).map((c) => [c.id, c]))]))

  const groups = await fetchCategoryGroups(config)
  return {
    months,
    groups: groups
      .filter((group) => !group.is_income)
      .map((group) => ({
        id: group.id,
        name: group.name,
        categories: group.categories
          .filter((category) => !category.is_income)
          .map((category) => ({
            id: category.id,
            name: category.name,
            months: Object.fromEntries(
              months.map((month) => {
                const categoryMonth = byMonthThenCategory.get(month)?.get(category.id)
                return [month, { budgeted: categoryMonth?.budgeted ?? 0, spent: categoryMonth?.spent ?? 0, balance: categoryMonth?.balance ?? 0 }]
              }),
            ),
          })),
      })),
  }
}

// --- anomalies ---

// How many trailing months of history a category/month or a transaction is judged against.
const ANOMALY_HISTORY_MONTHS = 12

export interface AnomalyFinding {
  month: string
  category: CategoryMonth
  direction: AnomalyDirection
  // Both negative-for-outflow, same convention as CategoryMonth.spent (and everywhere else in this
  // repo), so a caller formatting both through formatUsd gets two consistently-signed figures
  // (e.g. "-$1,000.00" spent vs. "-$100.00" typical), not one flipped positive and one not.
  spentCents: number
  typicalCents: number
}

export interface FindAnomaliesOptions {
  categories: string[]
  startMonth: string
  endMonth: string
}

// Function to check one category/month for a spending anomaly against its own trailing history
async function checkCategoryMonth(
  config: ActualConfig,
  category: CategoryMonth,
  month: string,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<AnomalyFinding | null> {
  const historicalSpent = await fetchHistoricalSpent(config, category.id, month, ANOMALY_HISTORY_MONTHS, monthCache)
  // Spent is negative for outflows; the detector works in positive "amount spent" terms so
  // "high" reads as "spent more than usual" and "low" as "spent less than usual".
  const result = detectAnomaly(
    -category.spent,
    historicalSpent.map((spent) => -spent),
  )
  if (!result.isAnomaly || !result.direction) {
    return null
  }
  return { month, category, direction: result.direction, spentCents: category.spent, typicalCents: -result.median }
}

// Function to flag categories whose spending in a month deviates sharply from that category's own
// trailing 12-month history -- the shared implementation behind `./actual budget anomalies` and
// `POST /api/budget/anomalies`. Read-only; see tagAnomalyFindings for the (writing) tag step.
export async function findAnomalies(config: ActualConfig, options: FindAnomaliesOptions): Promise<AnomalyFinding[]> {
  if (options.categories.length === 0) {
    throw new Error("At least one category is required.")
  }
  const groups = await fetchCategoryGroups(config)
  const incomeFilters = findIncomeFilterMatches(options.categories, groups)
  if (incomeFilters.length > 0) {
    throw new Error(`Category filter matched an income category or group, which is never a valid target: ${incomeFilters.join(", ")}`)
  }
  const groupNames = groupNameById(groups)

  const monthCache = new Map<string, CategoryMonth[]>()
  const findings: AnomalyFinding[] = []

  for (const month of monthRange(options.startMonth, options.endMonth)) {
    const categories = await getCachedMonthCategories(config, month, monthCache)
    for (const category of categories) {
      if (!shouldUpdateCategory(category, options.categories, groupNames)) {
        continue
      }
      const finding = await checkCategoryMonth(config, category, month, monthCache)
      if (finding) {
        findings.push(finding)
      }
    }
  }

  return findings
}

export type TagResultStatus = "tagged" | "already-tagged" | "would-tag" | "no-transactions"

export interface TagResult {
  month: string
  categoryName: string
  status: TagResultStatus
  transactionId?: string
  date?: string
  amount?: number
  payee?: string
}

// Function to pick which transaction(s) in a flagged category/month get tagged: any transaction
// that is itself an outlier (in the same direction) against that category's own historical
// transaction sizes, or -- if none is individually anomalous -- the single largest transaction in
// that category/month, so a flagged month is never left with nothing to point at.
function findTransactionsToTag(finding: AnomalyFinding, allTransactions: readonly Transaction[]): Transaction[] {
  const { month, category, direction } = finding
  const monthTransactions = allTransactions.filter((t) => t.category === category.id && t.date.startsWith(month))
  if (monthTransactions.length === 0) {
    return []
  }

  const historicalAmounts = allTransactions
    .filter((t) => t.category === category.id && t.date < `${month}-01`)
    .map((t) => -t.amount)

  const outliers = monthTransactions.filter((t) => {
    const result = detectAnomaly(-t.amount, historicalAmounts)
    return result.isAnomaly && result.direction === direction
  })
  if (outliers.length > 0) {
    return outliers
  }

  return [monthTransactions.reduce((largest, t) => (Math.abs(t.amount) > Math.abs(largest.amount) ? t : largest))]
}

// Function to tag (or, in dry-run mode, report) the transaction(s) responsible for each finding
// with a #anomaly-high/#anomaly-low note tag -- the shared, writing half of `./actual budget
// anomalies -t`/`POST /api/budget/anomalies/tag`. `startMonth` is the requested range's own start
// (not just the earliest month with a finding), matching the original CLI's own
// `months.reduce(...)` -- monthRange always returns an ascending list, so its first element is the
// same value either way.
export async function tagAnomalyFindings(
  config: ActualConfig,
  findings: readonly AnomalyFinding[],
  startMonth: string,
  dryRun: boolean,
): Promise<TagResult[]> {
  if (findings.length === 0) {
    return []
  }
  const sinceDate = `${addMonths(startMonth, -ANOMALY_HISTORY_MONTHS)}-01`
  const allTransactions = await fetchAllTransactionsSince(config, sinceDate)
  const results: TagResult[] = []

  for (const finding of findings) {
    const toTag = findTransactionsToTag(finding, allTransactions)
    if (toTag.length === 0) {
      results.push({ month: finding.month, categoryName: finding.category.name, status: "no-transactions" })
      continue
    }
    for (const transaction of toTag) {
      const newNotes = addTagToNotes(transaction.notes, `#anomaly-${finding.direction}`)
      const payee = transaction.imported_payee ?? "unknown payee"
      const base = { month: finding.month, categoryName: finding.category.name, transactionId: transaction.id, date: transaction.date, amount: transaction.amount, payee }
      if (newNotes === transaction.notes) {
        results.push({ ...base, status: "already-tagged" })
        continue
      }
      if (dryRun) {
        results.push({ ...base, status: "would-tag" })
        continue
      }
      await patchTransactionNotes(config, transaction.id, newNotes)
      results.push({ ...base, status: "tagged" })
    }
  }

  return results
}
