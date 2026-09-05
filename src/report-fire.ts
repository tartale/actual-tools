#!/usr/bin/env node

import { writeFileSync } from "node:fs"

import {
  averageSpent,
  fetchAccountBalance,
  fetchCategoryGroups,
  fetchHistoricalSpent,
  formatUsd,
  loadConfigFromEnv,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import { buildFireDashboard, portfolioAccountIds } from "./fire-dashboard.ts"
import { DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH, loadClassifiedAccounts } from "./fire-accounts.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

const DEFAULT_OUTPUT_PATH = "fire-dashboard.json"
const HISTORY_MONTHS = 12
const BALANCE_SINCE_DATE = "1970-01-01"

interface Options {
  outputPath: string
  configPath: string
  dryRun: boolean
}

const HELP_PAGE: HelpPage = {
  usage: "./actual report fire [OPTIONS]",
  description:
    "Builds an Actual-native FIRE dashboard (net worth, trailing-12-month spending, and a " +
    "safe-withdrawal-rate crossover projection) from your real account and category data, and " +
    "writes it as a dashboard JSON file. Import it into Actual yourself: create a NEW, empty " +
    "dashboard page first (e.g. \"FIRE\") -- importing REPLACES every widget already on the " +
    "target page.",
  sections: [
    {
      label: "Options",
      entries: [
        { name: "-o, --output PATH", description: `Where to write the dashboard JSON (default: ${DEFAULT_OUTPUT_PATH}).` },
        {
          name: "-f, --config PATH",
          description: `Path to the account classification overrides file (default: ${DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH}).`,
        },
        {
          name: "-n, --dry-run",
          description: "Print the plan and the JSON that would be written, without writing the file. Also enabled by setting DRY_RUN=true.",
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
  let outputPath = DEFAULT_OUTPUT_PATH
  let configPath = DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH
  let dryRun = process.env.DRY_RUN === "true"

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --output")
      }
      outputPath = value
      i++
    } else if (arg === "-f" || arg === "--config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --config")
      }
      configPath = value
      i++
    } else if (arg === "-n" || arg === "--dry-run") {
      dryRun = true
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { outputPath, configPath, dryRun }
}

// Function to get the current month as a yyyy-mm string
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Function to sum the trailing-12-month average spend across every given category, for the
// console sanity-check numbers only -- not fed into the widget itself, which computes its own
// live figures once imported into Actual.
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

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config: ActualConfig = loadConfigFromEnv()

  const { accounts, configFound } = await loadClassifiedAccounts(config, options.configPath)
  if (!configFound) {
    process.stderr.write(`No ${options.configPath} found; every account is classified by heuristic or default only.\n`)
  }

  const portfolioIds = portfolioAccountIds(accounts)
  if (portfolioIds.length === 0) {
    throw new Error(
      "No accounts are classified as retirement/HSA/taxable-investment -- nothing to build a portfolio from. " +
        `Run './actual report accounts' and add overrides to ${options.configPath} first.`,
    )
  }

  const groups = await fetchCategoryGroups(config)
  const expenseCategoryIds = groups.flatMap((group) => group.categories).filter((category) => !category.is_income && !category.hidden).map((category) => category.id)
  if (expenseCategoryIds.length === 0) {
    throw new Error("No non-income, non-hidden categories found -- the crossover widget requires at least one expense category.")
  }

  const [annualSpend, portfolioBalances] = await Promise.all([
    trailingAnnualSpend(config, expenseCategoryIds),
    Promise.all(portfolioIds.map((accountId) => fetchAccountBalance(config, accountId, BALANCE_SINCE_DATE))),
  ])
  const portfolioTotal = portfolioBalances.reduce((total, balance) => total + balance, 0)

  console.log(`Portfolio accounts (${portfolioIds.length}): current total ${formatUsd(portfolioTotal)}`)
  console.log(`Expense categories (${expenseCategoryIds.length}): trailing 12-month spend ${formatUsd(annualSpend)}/yr`)

  const dashboard = buildFireDashboard(expenseCategoryIds, portfolioIds)
  const json = JSON.stringify(dashboard, null, 2)

  if (options.dryRun) {
    console.log("\nWould write:\n")
    console.log(json)
    return
  }

  writeFileSync(options.outputPath, `${json}\n`)
  console.log(`\nWrote ${options.outputPath} (${dashboard.widgets.length} widgets: ${dashboard.widgets.map((widget) => widget.type).join(", ")}).`)
  console.log(`
To import it into Actual:
  1. Open your budget in Actual, go to the Reports/Dashboard tab.
  2. Create a NEW dashboard page (e.g. name it "FIRE") -- do NOT import onto
     an existing page you care about; import REPLACES every widget on the
     target page.
  3. On that new page, open the "..." menu -> Import, and pick this file.`)
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
