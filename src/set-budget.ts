#!/usr/bin/env node

import {
  HISTORY_MONTHS,
  computeBalanceBudget,
  computeHistoricalBudget,
  confirmViaTty,
  fetchCategoryGroups,
  fetchPreviousBudgeted,
  findIncomeFilterMatches,
  formatCategoryLine,
  formatUsd,
  getCachedMonthCategories,
  groupNameById,
  isAction,
  loadConfigFromEnv,
  monthRange,
  parseDollarAmount,
  patchCategoryBudget,
  shouldUpdateCategory,
  validateMonthFormat,
} from "./actual-helpers.ts"
import type { Action, CategoryMonth } from "./actual-helpers.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

interface Options {
  action: Action | number
  startMonth: string
  endMonth: string
  categories: string[]
  interactive: boolean
  dryRun: boolean
}

const HELP_PAGE: HelpPage = {
  usage: "./actual budget set-values [OPTIONS] ACTION START_MONTH [END_MONTH]",
  description: "Sets category budgets for a month, or an inclusive range of months.",
  sections: [
    {
      label: "Actions",
      entries: [
        { name: "balance", description: "Set the budget so the category's balance for the month becomes zero." },
        { name: "previous", description: "Set the budget to the previous month's actual spending." },
        { name: "previous-3", description: "Set the budget to the average actual spending of the previous 3 months." },
        { name: "previous-12", description: "Set the budget to the average actual spending of the previous 12 months." },
        { name: "repeat", description: "Set the budget to the same amount budgeted the previous month." },
        { name: "NUMBER", description: "Set the budget to exactly this dollar amount, e.g. 500 or 249.99." },
      ],
    },
    {
      label: "Options",
      entries: [
        {
          name: "-c, --category CATEGORY",
          description:
            "Only update categories matching this category or parent category group (name or ID). Can be used multiple times.",
        },
        { name: "-i, --interactive", description: "Ask for confirmation before each update." },
        {
          name: "-n, --dry-run",
          description: "Report what would change without writing anything. Also enabled by setting DRY_RUN=true.",
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
  let interactive = false
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
    } else if (arg === "-i" || arg === "--interactive") {
      interactive = true
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

  if (positional.length < 2 || positional.length > 3) {
    usage("Expected an action and one or two months.")
  }

  const actionArgument = positional[0] as string
  let action: Action | number
  if (isAction(actionArgument)) {
    action = actionArgument
  } else {
    const amount = parseDollarAmount(actionArgument)
    if (amount === null) {
      usage(`Unknown action: ${actionArgument}`)
    }
    action = amount
  }

  const startMonth = positional[1] as string
  const endMonth = positional[2] ?? startMonth
  try {
    validateMonthFormat(startMonth)
    validateMonthFormat(endMonth)
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error))
  }

  return { action, startMonth, endMonth, categories, interactive, dryRun }
}

// Function to compute the budgeted amount a given action (or literal dollar amount) wants for a category
async function computeNewBudget(
  config: ReturnType<typeof loadConfigFromEnv>,
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
  if (action === "repeat") {
    return fetchPreviousBudgeted(config, category.id, month, monthCache)
  }
  return computeHistoricalBudget(config, category.id, month, HISTORY_MONTHS[action], monthCache)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  let groupNames = new Map<string, string>()
  if (options.categories.length > 0) {
    const groups = await fetchCategoryGroups(config)
    const incomeFilters = findIncomeFilterMatches(options.categories, groups)
    if (incomeFilters.length > 0) {
      throw new Error(
        `-c matched an income category or group, which is never a valid update target: ${incomeFilters.join(", ")}`,
      )
    }
    groupNames = groupNameById(groups)
  }

  const monthCache = new Map<string, CategoryMonth[]>()

  for (const month of monthRange(options.startMonth, options.endMonth)) {
    const categories = await getCachedMonthCategories(config, month, monthCache)

    for (const category of categories) {
      if (!shouldUpdateCategory(category, options.categories, groupNames)) {
        continue
      }
      // The balance action has nothing to zero out when the month saw no activity at all.
      if (options.action === "balance" && category.spent === 0 && category.balance === 0) {
        continue
      }

      const newBudgeted = await computeNewBudget(config, options.action, category, month, monthCache)
      if (newBudgeted === category.budgeted) {
        console.log(formatCategoryLine(month, "Update not needed", category.budgeted, category.balance, category.name))
        continue
      }

      if (options.dryRun) {
        console.log(formatCategoryLine(month, "Would update", newBudgeted, category.balance, category.name))
        continue
      }

      if (options.interactive) {
        const confirmed = await confirmViaTty(
          `Confirm update for month ${month}, category ${category.name}, new value ${formatUsd(newBudgeted)}? [y/N] `,
        )
        if (!confirmed) {
          console.log(formatCategoryLine(month, "Update skipped", category.budgeted, category.balance, category.name))
          continue
        }
      }

      console.log(formatCategoryLine(month, "Update applied", newBudgeted, category.balance, category.name))
      await patchCategoryBudget(config, month, category.id, newBudgeted)
    }

    console.log(`All categories updated for month ${month}.`)
  }

  console.log("All months processed.")
}

// Piping into head/grep closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0)
  }
  throw error
})

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
