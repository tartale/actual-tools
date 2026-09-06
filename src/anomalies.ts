#!/usr/bin/env node

import {
  addMonths,
  addTagToNotes,
  fetchAllTransactionsSince,
  fetchCategoryGroups,
  fetchHistoricalSpent,
  findIncomeFilterMatches,
  formatError,
  formatUsd,
  getCachedMonthCategories,
  groupNameById,
  loadConfigFromEnv,
  monthRange,
  patchTransactionNotes,
  shouldUpdateCategory,
  validateMonthFormat,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth, Transaction } from "./actual-helpers.ts"
import { detectAnomaly } from "./anomaly-detect.ts"
import type { AnomalyDirection } from "./anomaly-detect.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// How many trailing months of history back a category/month or a transaction is judged against.
const HISTORY_MONTHS = 12

interface Options {
  categories: string[]
  tag: boolean
  dryRun: boolean
  startMonth: string
  endMonth: string
}

const HELP_PAGE: HelpPage = {
  usage: "./actual budget anomalies -c CATEGORY [-c CATEGORY]... [OPTIONS] START_MONTH [END_MONTH]",
  description:
    "Flags categories whose spending in a month deviates sharply from that category's own trailing " +
    "12-month history, using a robust (median-based) outlier test.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-c, --category CATEGORY",
          description: "Category or parent category group to check (name or ID). Required, can be used multiple times.",
        },
        {
          name: "-t, --tag",
          description:
            "Prepend a #anomaly-high or #anomaly-low tag to the notes of the transaction(s) identified as " +
            "responsible for each flagged month.",
        },
        {
          name: "-n, --dry-run",
          description: "Report what would be tagged without writing anything. Also enabled by setting DRY_RUN=true.",
        },
        { name: "-h, --help", description: "Show this message and exit." },
      ],
    },
  ],
}

// Function to report a usage error and exit
function usage(message: string): never {
  process.stderr.write(`${message}\n\n${renderHelp(process.stderr, HELP_PAGE)}\n`)
  process.exit(1)
}

// Function to parse and validate command-line arguments
function parseArguments(argv: readonly string[]): Options {
  const categories: string[] = []
  let tag = false
  let dryRun = process.env.DRY_RUN === "true"
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-c" || arg === "--category") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --category")
      }
      categories.push(value)
      i++
    } else if (arg === "-t" || arg === "--tag") {
      tag = true
    } else if (arg === "-n" || arg === "--dry-run") {
      dryRun = true
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else if (arg === "--") {
      positional.push(...argv.slice(i + 1))
      break
    } else if (arg.startsWith("-")) {
      usage(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (categories.length === 0) {
    usage("At least one -c/--category is required.")
  }
  if (positional.length < 1 || positional.length > 2) {
    usage("Expected one or two months.")
  }

  const startMonth = positional[0] as string
  const endMonth = positional[1] ?? startMonth
  try {
    validateMonthFormat(startMonth)
    validateMonthFormat(endMonth)
  } catch (error) {
    usage(formatError(error))
  }

  return { categories, tag, dryRun, startMonth, endMonth }
}

interface Finding {
  month: string
  category: CategoryMonth
  direction: AnomalyDirection
  medianSpent: number
}

// Function to format one anomaly line, matching the status-first style of the other tools
function formatAnomalyLine(month: string, direction: AnomalyDirection, spentCents: number, typicalCents: number, name: string): string {
  const status = (direction === "high" ? "Anomaly (high)" : "Anomaly (low)").padEnd(18)
  const spentCol = formatUsd(spentCents).padEnd(11)
  const typicalCol = formatUsd(typicalCents).padEnd(11)
  return `${status}; month: ${month}; spent = ${spentCol}; typical = ${typicalCol}; name: ${name}`
}

// Function to check one category/month for a spending anomaly against its own trailing history
async function checkCategoryMonth(
  config: ActualConfig,
  category: CategoryMonth,
  month: string,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<Finding | null> {
  const historicalSpent = await fetchHistoricalSpent(config, category.id, month, HISTORY_MONTHS, monthCache)
  // Spent is negative for outflows; the detector works in positive "amount spent" terms so
  // "high" reads as "spent more than usual" and "low" as "spent less than usual".
  const result = detectAnomaly(
    -category.spent,
    historicalSpent.map((spent) => -spent),
  )
  if (!result.isAnomaly || !result.direction) {
    return null
  }
  return { month, category, direction: result.direction, medianSpent: -result.median }
}

// Function to pick which transaction(s) in a flagged category/month get tagged: any transaction
// that is itself an outlier (in the same direction) against that category's own historical
// transaction sizes, or -- if none is individually anomalous -- the single largest transaction in
// that category/month, so a flagged month is never left with nothing to point at.
function findTransactionsToTag(finding: Finding, allTransactions: readonly Transaction[]): Transaction[] {
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

// Function to apply (or, in dry-run mode, report) the anomaly tag on the given transactions
async function tagTransactions(
  config: ActualConfig,
  transactions: readonly Transaction[],
  direction: AnomalyDirection,
  dryRun: boolean,
): Promise<void> {
  const tag = `#anomaly-${direction}`
  for (const transaction of transactions) {
    const newNotes = addTagToNotes(transaction.notes, tag)
    const payee = transaction.imported_payee ?? "unknown payee"
    if (newNotes === transaction.notes) {
      console.log(`  Already tagged   ; ${transaction.date}; ${formatUsd(transaction.amount)}; ${payee}`)
      continue
    }
    if (dryRun) {
      console.log(`  Would tag        ; ${transaction.date}; ${formatUsd(transaction.amount)}; ${payee}`)
      continue
    }
    await patchTransactionNotes(config, transaction.id, newNotes)
    console.log(`  Tagged           ; ${transaction.date}; ${formatUsd(transaction.amount)}; ${payee}`)
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  const groups = await fetchCategoryGroups(config)
  const incomeFilters = findIncomeFilterMatches(options.categories, groups)
  if (incomeFilters.length > 0) {
    throw new Error(`-c matched an income category or group, which is never a valid target: ${incomeFilters.join(", ")}`)
  }
  const groupNames = groupNameById(groups)

  const months = monthRange(options.startMonth, options.endMonth)
  const monthCache = new Map<string, CategoryMonth[]>()
  const findings: Finding[] = []

  for (const month of months) {
    const categories = await getCachedMonthCategories(config, month, monthCache)
    for (const category of categories) {
      if (!shouldUpdateCategory(category, options.categories, groupNames)) {
        continue
      }
      const finding = await checkCategoryMonth(config, category, month, monthCache)
      if (finding) {
        findings.push(finding)
        console.log(formatAnomalyLine(finding.month, finding.direction, finding.category.spent, finding.medianSpent, finding.category.name))
      }
    }
  }

  if (findings.length === 0) {
    console.log("No anomalies found.")
    return
  }

  if (options.tag) {
    const earliestMonth = months.reduce((earliest, month) => (month < earliest ? month : earliest))
    const sinceDate = `${addMonths(earliestMonth, -HISTORY_MONTHS)}-01`
    const allTransactions = await fetchAllTransactionsSince(config, sinceDate)

    for (const finding of findings) {
      const toTag = findTransactionsToTag(finding, allTransactions)
      if (toTag.length === 0) {
        console.log(`  No transactions found for ${finding.category.name} in ${finding.month}; nothing to tag.`)
        continue
      }
      await tagTransactions(config, toTag, finding.direction, options.dryRun)
    }
  }
}

// Piping into head/grep closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0)
  }
  throw error
})

main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exit(1)
})
