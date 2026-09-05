import { accessSync, constants, createReadStream } from "node:fs"
import { createInterface } from "node:readline/promises"

export interface Category {
  id: string
  name: string
  is_income: boolean
  hidden: boolean
  group_id: string
}

export interface CategoryGroup {
  id: string
  name: string
  is_income: boolean
  hidden: boolean
  categories: Category[]
}

export interface CategoryMonth extends Category {
  budgeted: number
  spent: number
  balance: number
  carryover: boolean
}

export interface ActualConfig {
  baseUrl: string
  budgetId: string
  apiKey: string
}

export interface Account {
  id: string
  name: string
  offbudget: boolean
  closed: boolean
}

export interface Transaction {
  id: string
  account: string
  category: string | null
  amount: number
  imported_payee: string | null
  notes: string | null
  date: string
  transfer_id: string | null
  cleared: boolean
  tombstone: boolean
  is_parent?: boolean
  subtransactions?: Transaction[]
}

export type HistoryAction = "spent" | "spent-3" | "spent-12"
export type Action = "balance" | "previous" | HistoryAction

export const ACTIONS: readonly Action[] = ["balance", "spent", "spent-3", "spent-12", "previous"]

export const HISTORY_MONTHS: Record<HistoryAction, number> = {
  spent: 1,
  "spent-3": 3,
  "spent-12": 12,
}

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value)
}

// Function to parse a plain decimal dollar string (e.g. "500", "249.99", "-12.5") into cents,
// or null if it isn't one. Used to let an ACTION argument be a literal amount instead of a preset.
export function parseDollarAmount(value: string): number | null {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
    return null
  }
  return Math.round(parseFloat(value) * 100)
}

// Function to load and validate required environment variables
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ActualConfig {
  const baseUrl = env.AB_BASE_URL
  const budgetId = env.AB_BUDGET_ID
  const apiKey = env.AB_API_KEY
  if (!baseUrl || !budgetId || !apiKey) {
    throw new Error("Environment variables AB_BASE_URL, AB_BUDGET_ID, and AB_API_KEY must be set.")
  }
  return { baseUrl, budgetId, apiKey }
}

// Function to format a cent amount as a USD string, e.g. -415295 -> -$4152.95
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

// Function to validate month format
export function validateMonthFormat(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month format: ${month}`)
  }
}

// Function to shift a yyyy-mm month by a (possibly negative) number of months
export function addMonths(month: string, delta: number): string {
  validateMonthFormat(month)
  const [year, mon] = month.split("-").map(Number) as [number, number]
  const shifted = new Date(Date.UTC(year, mon - 1 + delta, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`
}

// Function to validate a yyyy-mm-dd date
export function validateDateFormat(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format: ${date}`)
  }
}

// Function to shift a yyyy-mm-dd date by a (possibly negative) number of days
export function addDays(date: string, delta: number): string {
  validateDateFormat(date)
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  const shifted = new Date(Date.UTC(year, month - 1, day + delta))
  const yyyy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(shifted.getUTCDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

// Function to enumerate the inclusive month range between start and end, in either direction
export function monthRange(start: string, end: string): string[] {
  validateMonthFormat(start)
  validateMonthFormat(end)
  const direction = start <= end ? 1 : -1
  const months: string[] = []
  let current = start
  while (true) {
    months.push(current)
    if (current === end) break
    current = addMonths(current, direction)
  }
  return months
}

// Function to index category groups (parent categories) by ID
export function groupNameById(groups: CategoryGroup[]): Map<string, string> {
  return new Map(groups.map((group) => [group.id, group.name]))
}

// Function to determine whether a category matches the given category/parent-group filters
export function shouldUpdateCategory(
  category: Pick<Category, "id" | "name" | "group_id" | "is_income">,
  filters: readonly string[],
  groupNames: ReadonlyMap<string, string>,
): boolean {
  // Income categories are never touched, even by an explicit -c match on the
  // category itself or its parent group.
  if (category.is_income) {
    return false
  }
  if (filters.length === 0) {
    return true
  }
  const groupName = groupNames.get(category.group_id)
  return filters.some(
    (filter) => filter === category.id || filter === category.name || filter === category.group_id || filter === groupName,
  )
}

// Function to find which -c filters explicitly target an income category or its parent
// group, by id or name. Income categories are never valid update targets, so a filter that
// names one is a user error, not something to silently skip like the unfiltered sweep does.
export function findIncomeFilterMatches(filters: readonly string[], groups: readonly CategoryGroup[]): string[] {
  return filters.filter((filter) =>
    groups.some((group) => {
      if (group.is_income && (filter === group.id || filter === group.name)) {
        return true
      }
      return group.categories.some((category) => category.is_income && (filter === category.id || filter === category.name))
    }),
  )
}

// Function to compute the budgeted amount that zeroes out a category's current balance
export function computeBalanceBudget(category: Pick<CategoryMonth, "budgeted" | "balance">): number {
  return category.budgeted - category.balance
}

// Function to average a set of prior months' spent amounts into a positive budgeted amount
export function averageSpent(spentAmounts: readonly number[]): number {
  if (spentAmounts.length === 0) {
    return 0
  }
  const total = spentAmounts.reduce((sum, spent) => sum + -spent, 0)
  return Math.round(total / spentAmounts.length)
}

// Function to format a single category status line: status first (log-style), then the field columns
export function formatCategoryLine(month: string, status: string, budgetedCents: number, balanceCents: number, name: string): string {
  const statusCol = status.padEnd(18)
  const budgetedCol = formatUsd(budgetedCents).padEnd(11)
  const balanceCol = formatUsd(balanceCents).padEnd(11)
  return `${statusCol}; month: ${month}; budgeted = ${budgetedCol}; balance = ${balanceCol}; name: ${name}`
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error
  }
  return undefined
}

async function actualRequest(config: ActualConfig, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-api-key": config.apiKey,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`Request to ${path} failed: ${extractErrorMessage(body) ?? `HTTP ${response.status}`}`)
  }
  return body
}

function isDataArray(body: unknown): body is { data: unknown[] } {
  return !!body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
}

// Function to fetch category groups (parent categories)
export async function fetchCategoryGroups(config: ActualConfig): Promise<CategoryGroup[]> {
  const body = await actualRequest(config, `/budgets/${config.budgetId}/categorygroups`)
  if (!isDataArray(body)) {
    throw new Error(`Unexpected response fetching category groups: ${JSON.stringify(body)}`)
  }
  return body.data as CategoryGroup[]
}

// Function to fetch categories (with budgeted/spent/balance) for a given month
export async function fetchMonthCategories(config: ActualConfig, month: string): Promise<CategoryMonth[]> {
  const body = await actualRequest(config, `/budgets/${config.budgetId}/months/${month}/categories`)
  if (!isDataArray(body)) {
    throw new Error(`Unexpected response fetching categories for month ${month}: ${JSON.stringify(body)}`)
  }
  return body.data as CategoryMonth[]
}

// Function to fetch a month's categories, reusing a previous result if already cached
export async function getCachedMonthCategories(
  config: ActualConfig,
  month: string,
  cache: Map<string, CategoryMonth[]>,
): Promise<CategoryMonth[]> {
  const cached = cache.get(month)
  if (cached) {
    return cached
  }
  const categories = await fetchMonthCategories(config, month)
  cache.set(month, categories)
  return categories
}

// Function to fetch a category's raw `spent` values for the N months immediately before `month`,
// in the same negative-for-outflow units as CategoryMonth.spent. A month where the category
// doesn't appear counts as 0, not a shrunken sample.
export async function fetchHistoricalSpent(
  config: ActualConfig,
  categoryId: string,
  month: string,
  monthsBack: number,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number[]> {
  const spentAmounts: number[] = []
  for (let i = 1; i <= monthsBack; i++) {
    const priorMonth = addMonths(month, -i)
    const priorCategories = await getCachedMonthCategories(config, priorMonth, monthCache)
    const priorCategory = priorCategories.find((category) => category.id === categoryId)
    spentAmounts.push(priorCategory ? priorCategory.spent : 0)
  }
  return spentAmounts
}

// Function to average the previous N months of a category's spending into a budgeted amount
export async function computeHistoricalBudget(
  config: ActualConfig,
  categoryId: string,
  month: string,
  monthsBack: number,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number> {
  const spentAmounts = await fetchHistoricalSpent(config, categoryId, month, monthsBack, monthCache)
  return averageSpent(spentAmounts)
}

// Function to fetch what a category was budgeted the single month before `month` (not what it
// spent). A month where the category doesn't appear counts as $0, matching the "missing month"
// convention used everywhere else in this module.
export async function fetchPreviousBudgeted(
  config: ActualConfig,
  categoryId: string,
  month: string,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number> {
  const priorMonth = addMonths(month, -1)
  const priorCategories = await getCachedMonthCategories(config, priorMonth, monthCache)
  const priorCategory = priorCategories.find((category) => category.id === categoryId)
  return priorCategory ? priorCategory.budgeted : 0
}

// Function to set a category's budgeted amount for a given month
export async function patchCategoryBudget(config: ActualConfig, month: string, categoryId: string, budgeted: number): Promise<void> {
  await actualRequest(config, `/budgets/${config.budgetId}/months/${month}/categories/${categoryId}`, {
    method: "PATCH",
    body: JSON.stringify({ category: { budgeted } }),
  })
}

// Function to fetch every open, on-budget account (closed and off-budget accounts don't count
// toward category spending, matching how match-uncleared.sh already scopes its account fetch)
export async function fetchOnBudgetAccounts(config: ActualConfig): Promise<Account[]> {
  const body = await actualRequest(config, `/budgets/${config.budgetId}/accounts`)
  if (!isDataArray(body)) {
    throw new Error(`Unexpected response fetching accounts: ${JSON.stringify(body)}`)
  }
  return (body.data as Account[]).filter((account) => !account.closed && !account.offbudget)
}

// Function to fetch every open account, on- or off-budget. Retirement, investment, and debt
// accounts are typically off-budget, so this is what classification needs (fetchOnBudgetAccounts
// deliberately excludes exactly those accounts).
export async function fetchAllOpenAccounts(config: ActualConfig): Promise<Account[]> {
  const body = await actualRequest(config, `/budgets/${config.budgetId}/accounts`)
  if (!isDataArray(body)) {
    throw new Error(`Unexpected response fetching accounts: ${JSON.stringify(body)}`)
  }
  return (body.data as Account[]).filter((account) => !account.closed)
}

// Function to fetch an account's transactions on or after `sinceDate` (the API has no upper
// bound, so callers filter the result down to whatever end date they need)
export async function fetchAccountTransactions(config: ActualConfig, accountId: string, sinceDate: string): Promise<Transaction[]> {
  const body = await actualRequest(
    config,
    `/budgets/${config.budgetId}/accounts/${accountId}/transactions?since_date=${sinceDate}`,
  )
  if (!isDataArray(body)) {
    throw new Error(`Unexpected response fetching transactions for account ${accountId}: ${JSON.stringify(body)}`)
  }
  return body.data as Transaction[]
}

// Function to sum a list of transactions' amounts. The API has no running-balance field, but the
// sum of an account's entire transaction history *is* its current balance -- an accounting
// identity, not an approximation. Deliberately does not flatten splits or exclude transfers (the
// way fetchAllTransactionsSince does): a split parent's amount already equals its children's sum,
// and a transfer's two legs are both real postings to two different accounts that must count.
// Applying either of those filters here would break the identity, not improve it.
export function sumTransactionAmounts(transactions: readonly Transaction[]): number {
  return transactions.reduce((total, transaction) => total + transaction.amount, 0)
}

// Function to compute an account's current balance via the transaction-sum identity above.
// `sinceDate` must predate the account's first transaction or the sum will be wrong; pass a date
// far enough in the past (e.g. "1970-01-01") when there's no better bound available.
export async function fetchAccountBalance(config: ActualConfig, accountId: string, sinceDate: string): Promise<number> {
  const transactions = await fetchAccountTransactions(config, accountId, sinceDate)
  return sumTransactionAmounts(transactions)
}

// Function to replace a split (parent) transaction with its individually-categorized
// subtransactions, which is where the API assigns category/amount/notes for a split — the parent
// itself has category: null and an amount spanning every category in the split, so it isn't a
// usable line item on its own.
export function flattenTransactions(transactions: readonly Transaction[]): Transaction[] {
  return transactions.flatMap((transaction) => (transaction.is_parent ? (transaction.subtransactions ?? []) : [transaction]))
}

// Function to fetch every non-transfer transaction, across every on-budget account, on or after
// `sinceDate` — the building block for anything that needs to look at individual transactions
// rather than a category's monthly aggregate. Splits are flattened to their subtransactions first.
export async function fetchAllTransactionsSince(config: ActualConfig, sinceDate: string): Promise<Transaction[]> {
  const accounts = await fetchOnBudgetAccounts(config)
  const transactionsByAccount = await Promise.all(
    accounts.map((account) => fetchAccountTransactions(config, account.id, sinceDate)),
  )
  return flattenTransactions(transactionsByAccount.flat()).filter((transaction) => transaction.transfer_id === null)
}

// Function to set a transaction's notes
export async function patchTransactionNotes(config: ActualConfig, transactionId: string, notes: string): Promise<void> {
  await actualRequest(config, `/budgets/${config.budgetId}/transactions/${transactionId}`, {
    method: "PATCH",
    body: JSON.stringify({ transaction: { notes } }),
  })
}

// Function to prepend a "#tag " label to a transaction's notes, unless it's already there
export function addTagToNotes(notes: string | null, tag: string): string {
  const existing = notes ?? ""
  if (existing === tag || existing.startsWith(`${tag} `)) {
    return existing
  }
  return existing ? `${tag} ${existing}` : tag
}

// Function to normalize a payee name for matching: lowercase, collapsed whitespace, trimmed
export function normalizePayeeName(payee: string | null): string {
  return (payee ?? "").toLowerCase().replace(/\s+/g, " ").trim()
}

// Function to find the first cleared transaction that looks like the re-imported, posted version
// of an uncleared one -- the same real-world transaction appearing as a second, separate row
// instead of the original row being updated in place. Same account, same normalized payee, dated
// after the uncleared transaction and on or before maxDate, and no larger than 30% above the
// uncleared amount (a pending authorization hold is often somewhat higher than what it settles
// at, rarely lower). "First" is candidates' array order, not closest match, and amount is compared
// by magnitude only (not sign) -- both faithfully match the original bash version.
export function findMatchingTransaction(
  unclearedTx: Pick<Transaction, "account" | "date" | "amount" | "imported_payee">,
  clearedCandidates: readonly Transaction[],
  maxDate: string,
): Transaction | null {
  const payee = normalizePayeeName(unclearedTx.imported_payee)
  const amountCeiling = Math.abs(unclearedTx.amount) * 1.3
  return (
    clearedCandidates.find(
      (candidate) =>
        candidate.account === unclearedTx.account &&
        normalizePayeeName(candidate.imported_payee) === payee &&
        candidate.date > unclearedTx.date &&
        candidate.date <= maxDate &&
        Math.abs(candidate.amount) <= amountCeiling,
    ) ?? null
  )
}

export interface TtyInterface {
  question(promptText: string): Promise<string>
  close(): void
}

// Function to open an interactive prompt session on the controlling terminal (/dev/tty), for one
// or more questions in sequence. Callers must call .close() when done (a try/finally around a
// loop of prompts, not one open+close per question).
export function openTtyInterface(): TtyInterface {
  try {
    accessSync("/dev/tty", constants.R_OK)
  } catch {
    throw new Error("This command requires an interactive terminal.")
  }
  const ttyIn = createReadStream("/dev/tty")
  const rl = createInterface({ input: ttyIn, output: process.stderr })
  return {
    question: (promptText: string) => rl.question(promptText),
    close: () => {
      rl.close()
      ttyIn.close()
    },
  }
}

// Function to prompt for a single yes/no confirmation via the controlling terminal
export async function confirmViaTty(promptText: string): Promise<boolean> {
  const tty = openTtyInterface()
  try {
    while (true) {
      const answer = (await tty.question(promptText)).trim().toLowerCase()
      if (answer === "y" || answer === "yes") {
        return true
      }
      if (answer === "n" || answer === "no" || answer === "") {
        return false
      }
      process.stderr.write("Please answer y or n.\n")
    }
  } finally {
    tty.close()
  }
}

// Function to prompt for one numbered choice among options, via an already-open TTY interface (so
// a caller asking several questions in a row only opens the terminal once). When `defaultIndex` is
// given, pressing Enter with no input accepts it; when null, a valid number is required -- there
// is no way to skip the question.
export async function promptChoice(
  tty: TtyInterface,
  promptText: string,
  options: readonly string[],
  defaultIndex: number | null,
): Promise<number> {
  const optionLines = options.map((option, index) => `  ${index + 1}) ${option}`).join("\n")
  const defaultLabel = defaultIndex === null ? "" : ` [${defaultIndex + 1}]`
  const question = `${optionLines}\n${promptText}${defaultLabel}: `

  while (true) {
    const answer = (await tty.question(question)).trim()
    if (answer === "" && defaultIndex !== null) {
      return defaultIndex
    }
    const choice = Number.parseInt(answer, 10)
    if (Number.isInteger(choice) && String(choice) === answer && choice >= 1 && choice <= options.length) {
      return choice - 1
    }
    process.stderr.write(`Please enter a number from 1 to ${options.length}.\n`)
  }
}
