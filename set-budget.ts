#!/usr/bin/env node

import {
  ACTIONS,
  HISTORY_MONTHS,
  computeBalanceBudget,
  computeHistoricalBudget,
  confirmViaTty,
  fetchCategoryGroups,
  formatCategoryLine,
  formatUsd,
  getCachedMonthCategories,
  groupNameById,
  isAction,
  loadConfigFromEnv,
  monthRange,
  patchCategoryBudget,
  shouldUpdateCategory,
  validateMonthFormat,
} from "./actual-helpers.ts"
import type { Action, CategoryMonth } from "./actual-helpers.ts"

interface Options {
  action: Action
  startMonth: string
  endMonth: string
  categories: string[]
  interactive: boolean
  dryRun: boolean
}

const USAGE = `usage: set-budget.ts [-c CATEGORY]... [-i] ACTION yyyy-mm [yyyy-mm]

Actions:
  ${ACTIONS.join(", ")}

  balance       Set the budget so the category's balance for the month becomes zero.
  previous      Set the budget to the previous month's actual spending.
  previous-3    Set the budget to the average actual spending of the previous 3 months.
  previous-12   Set the budget to the average actual spending of the previous 12 months.

Options:
  -c, --category CATEGORY   Only update categories matching the specified category or
                             parent category group (name or ID). Can be used multiple times.
  -i, --interactive         Ask for confirmation before each update.
  -n, --dry-run             Report what would change without writing anything.
                             Also enabled by setting DRY_RUN=true.`

// Function to report a usage error and exit
function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`)
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

  const action = positional[0] as string
  if (!isAction(action)) {
    usage(`Unknown action: ${action}`)
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

// Function to compute the budgeted amount a given action wants for a category
async function computeNewBudget(
  config: ReturnType<typeof loadConfigFromEnv>,
  action: Action,
  category: CategoryMonth,
  month: string,
  monthCache: Map<string, CategoryMonth[]>,
): Promise<number> {
  if (action === "balance") {
    return computeBalanceBudget(category)
  }
  return computeHistoricalBudget(config, category.id, month, HISTORY_MONTHS[action], monthCache)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  const groupNames =
    options.categories.length > 0 ? groupNameById(await fetchCategoryGroups(config)) : new Map<string, string>()

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
