#!/usr/bin/env node

import { pathToFileURL } from "node:url"

import {
  confirmViaTty,
  formatCategoryLine,
  formatError,
  formatUsd,
  isAction,
  loadConfigFromEnv,
  parseDollarAmount,
  validateMonthFormat,
} from "./actual-helpers.ts"
import type { Action } from "./actual-helpers.ts"
import { setBudgetValues } from "./budget-tools.ts"
import type { BudgetLineResult } from "./budget-tools.ts"
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
        { name: "spent", description: "Set the budget to the previous month's actual spending." },
        { name: "spent-3", description: "Set the budget to the average actual spending of the previous 3 months." },
        { name: "spent-12", description: "Set the budget to the average actual spending of the previous 12 months." },
        { name: "previous", description: "Set the budget to the same amount budgeted the previous month." },
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
export function parseArguments(argv: readonly string[]): Options {
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
    usage(formatError(error))
  }

  return { action, startMonth, endMonth, categories, interactive, dryRun }
}

// Function to print one result line in this CLI's own status-first format, matching exactly what
// the pre-refactor inline loop printed for each case.
function printLine(line: BudgetLineResult): void {
  const label =
    line.status === "unchanged" ? "Update not needed" : line.status === "would-update" ? "Would update" : line.status === "skipped" ? "Update skipped" : "Update applied"
  const displayedBudgeted = line.status === "unchanged" || line.status === "skipped" ? line.oldBudgeted : line.newBudgeted
  console.log(formatCategoryLine(line.month, label, displayedBudgeted, line.balance, line.categoryName))
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  const monthResults = await setBudgetValues(config, {
    action: options.action,
    startMonth: options.startMonth,
    endMonth: options.endMonth,
    categories: options.categories,
    dryRun: options.dryRun,
    confirm: options.interactive
      ? async (line) => confirmViaTty(`Confirm update for month ${line.month}, category ${line.categoryName}, new value ${formatUsd(line.newBudgeted)}? [y/N] `)
      : undefined,
  })

  for (const { month, lines } of monthResults) {
    for (const line of lines) {
      printLine(line)
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

// Only runs when this file is the program being executed, so a test can import parseArguments
// above without the CLI running itself on the way in. Invoked through the ./actual dispatcher or
// its package.json bin entry, this is exactly the file node was pointed at.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`)
    process.exit(1)
  })
}
