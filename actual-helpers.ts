import { createReadStream } from "node:fs"
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

export type Action = "balance" | "previous" | "previous-3" | "previous-12"

export const ACTIONS: readonly Action[] = ["balance", "previous", "previous-3", "previous-12"]

export const HISTORY_MONTHS: Record<Exclude<Action, "balance">, number> = {
  previous: 1,
  "previous-3": 3,
  "previous-12": 12,
}

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value)
}

// Function to load and validate required environment variables
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ActualConfig {
  const baseUrl = env.BASE_URL
  const budgetId = env.BUDGET_ID
  const apiKey = env.API_KEY
  if (!baseUrl || !budgetId || !apiKey) {
    throw new Error("Environment variables BASE_URL, BUDGET_ID, and API_KEY must be set.")
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
  category: Pick<Category, "id" | "name" | "group_id">,
  filters: readonly string[],
  groupNames: ReadonlyMap<string, string>,
): boolean {
  if (filters.length === 0) {
    return true
  }
  const groupName = groupNames.get(category.group_id)
  return filters.some(
    (filter) => filter === category.id || filter === category.name || filter === category.group_id || filter === groupName,
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
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error
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

// Function to average the previous N months of a category's spending into a budgeted amount
export async function computeHistoricalBudget(
  config: ActualConfig,
  categoryId: string,
  month: string,
  monthsBack: number,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number> {
  const spentAmounts: number[] = []
  for (let i = 1; i <= monthsBack; i++) {
    const priorMonth = addMonths(month, -i)
    const priorCategories = await getCachedMonthCategories(config, priorMonth, monthCache)
    const priorCategory = priorCategories.find((category) => category.id === categoryId)
    spentAmounts.push(priorCategory ? priorCategory.spent : 0)
  }
  return averageSpent(spentAmounts)
}

// Function to set a category's budgeted amount for a given month
export async function patchCategoryBudget(config: ActualConfig, month: string, categoryId: string, budgeted: number): Promise<void> {
  await actualRequest(config, `/budgets/${config.budgetId}/months/${month}/categories/${categoryId}`, {
    method: "PATCH",
    body: JSON.stringify({ category: { budgeted } }),
  })
}

// Function to prompt for interactive confirmation via the controlling terminal
export async function confirmViaTty(promptText: string): Promise<boolean> {
  let ttyIn
  try {
    ttyIn = createReadStream("/dev/tty")
  } catch {
    throw new Error("--interactive requires a terminal for confirmation.")
  }
  const rl = createInterface({ input: ttyIn, output: process.stderr })
  try {
    while (true) {
      const answer = (await rl.question(promptText)).trim().toLowerCase()
      if (answer === "y" || answer === "yes") {
        return true
      }
      if (answer === "n" || answer === "no" || answer === "") {
        return false
      }
      process.stderr.write("Please answer y or n.\n")
    }
  } finally {
    rl.close()
    ttyIn.close()
  }
}
