import type { ClassifiedAccount, FireAccountCategory } from "./fire-accounts.ts"

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

export type FireWidgetType = "net-worth-card" | "spending-card" | "crossover-card"

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

const PORTFOLIO_CATEGORIES: readonly FireAccountCategory[] = [
  "retirement-tax-deferred",
  "retirement-roth",
  "hsa",
  "investment-taxable",
]

// Function to pick which classified accounts count as "the portfolio" for the crossover-card's
// incomeAccountIds. Debt, cash, and other are always excluded -- debt isn't investable, and
// cash/other are a spending buffer, not part of the safe-withdrawal-rate calculation.
export function portfolioAccountIds(accounts: readonly ClassifiedAccount[]): string[] {
  return accounts.filter((account) => PORTFOLIO_CATEGORIES.includes(account.category)).map((account) => account.id)
}

// Function to assemble the full three-widget FIRE dashboard on Actual's 12-column grid: net worth
// and spending side by side on the first row, crossover full-width on the row below.
export function buildFireDashboard(nonIncomeCategoryIds: string[], accountIds: string[]): ExportImportDashboard {
  return {
    version: 1,
    widgets: [buildNetWorthWidget(0, 0), buildSpendingWidget(6, 0), buildCrossoverWidget(0, 2, nonIncomeCategoryIds, accountIds)],
  }
}
