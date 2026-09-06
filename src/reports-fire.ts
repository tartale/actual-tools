#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  ageFromBirthDate,
  averageSpent,
  fetchAccountBalance,
  fetchCategoryGroups,
  fetchHistoricalSpent,
  formatError,
  formatUsd,
  loadConfigFromEnv,
  validateDateFormat,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import { buildFireDashboard, buildMonteCarloWidgets, mergeGeneratedDashboard, portfolioAccountIds, totalMonthlyContribution } from "./fire-dashboard.ts"
import type { ExistingDashboard } from "./fire-dashboard.ts"
import { DEFAULT_CONFIG_PATH, loadClassifiedAccounts, loadFireConfig } from "./fire-accounts.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

const DEFAULT_OUTPUT_PATH = "fire-dashboard.json"
const HISTORY_MONTHS = 12
const BALANCE_SINCE_DATE = "1970-01-01"

interface Options {
  outputPath: string
  configPath: string
  dryRun: boolean
  birthDate: string | null
  retirementAges: number[]
  planToAge: number | null
}

const HELP_PAGE: HelpPage = {
  usage: "./actual reports fire [OPTIONS]",
  description:
    "Builds an Actual-native FIRE dashboard (net worth, a safe-withdrawal-rate crossover " +
    "projection, and a Monte Carlo retirement simulation -- experimental in Actual, enable it " +
    "under Settings > Advanced > Experimental features first) from your real account/category " +
    "data and the assumptions in your config file (see ./actual configure), and writes it as a " +
    "dashboard JSON file. Regenerating over an existing output file preserves any customization " +
    "you've made to it (see README). Import it into Actual yourself: create a NEW, empty " +
    "dashboard page first (e.g. \"FIRE\") -- importing REPLACES every widget already on the " +
    "target page.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-r, --retirement-age N",
          description:
            "Compare this retirement age instead of the config file's. Can be used multiple times; replaces the " +
            "whole configured list for this run (doesn't add to it) -- each age gets its own Monte Carlo widget.",
        },
        { name: "-b, --birth-date YYYY-MM-DD", description: "Use this birth date instead of the config file's." },
        { name: "-p, --plan-to-age N", description: "Use this planning horizon instead of the config file's." },
        { name: "-o, --output PATH", description: `Where to write the dashboard JSON (default: ${DEFAULT_OUTPUT_PATH}).` },
        { name: "-f, --config PATH", description: `Path to the config file (default: ${DEFAULT_CONFIG_PATH}).` },
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

// Function to parse a required numeric argument for a flag, erroring clearly if it's missing or
// not a plain positive number
function parseAgeArgument(flag: string, value: string | undefined): number {
  if (value === undefined || value.startsWith("-")) {
    usage(`Missing argument for ${flag}`)
  }
  const age = Number(value)
  if (!Number.isFinite(age) || age <= 0) {
    usage(`Invalid age for ${flag}: ${value}`)
  }
  return age
}

// Function to parse and validate command-line arguments
function parseArguments(argv: readonly string[]): Options {
  let outputPath = DEFAULT_OUTPUT_PATH
  let configPath = DEFAULT_CONFIG_PATH
  let dryRun = process.env.DRY_RUN === "true"
  let birthDate: string | null = null
  const retirementAges: number[] = []
  let planToAge: number | null = null

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
    } else if (arg === "-b" || arg === "--birth-date") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --birth-date")
      }
      validateDateFormat(value)
      birthDate = value
      i++
    } else if (arg === "-r" || arg === "--retirement-age") {
      retirementAges.push(parseAgeArgument(arg, argv[i + 1]))
      i++
    } else if (arg === "-p" || arg === "--plan-to-age") {
      planToAge = parseAgeArgument(arg, argv[i + 1])
      i++
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { outputPath, configPath, dryRun, birthDate, retirementAges, planToAge }
}

// Function to read a previously written dashboard file, if any, so mergeGeneratedDashboard can
// preserve customizations made to it. A missing file is normal (first run) and returns null
// silently; a present-but-unreadable/malformed file (never written by this tool, or corrupted)
// warns and falls back to a fresh generation rather than failing the whole run.
function loadExistingDashboard(path: string): ExistingDashboard | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { widgets?: unknown }).widgets)) {
      throw new Error("missing a widgets array")
    }
    return parsed as ExistingDashboard
  } catch (error) {
    console.warn(
      `Warning: couldn't read existing ${path} to preserve customizations (${formatError(error)}); writing fresh.`,
    )
    return null
  }
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

  const { config: fireConfig, found: configFound } = loadFireConfig(options.configPath)
  if (!configFound) {
    throw new Error(`No ${options.configPath} found. Run './actual configure' first.`)
  }

  const birthDate = options.birthDate ?? fireConfig.dashboard.birthDate
  if (!birthDate) {
    usage(`Missing birth date: set it via './actual configure' or pass --birth-date`)
  }
  validateDateFormat(birthDate)
  const currentAge = ageFromBirthDate(birthDate)

  const retirementAges = options.retirementAges.length > 0 ? options.retirementAges : fireConfig.dashboard.retirementAges
  if (retirementAges.length === 0) {
    usage("No retirement age configured: set one via './actual configure' or pass --retirement-age.")
  }

  const planToAge = options.planToAge ?? fireConfig.dashboard.planToAge
  if (planToAge <= currentAge) {
    usage(`planToAge (${planToAge}) must be greater than your current age (${currentAge})`)
  }

  const { accounts } = await loadClassifiedAccounts(config, options.configPath)

  const portfolioIds = portfolioAccountIds(accounts)
  if (portfolioIds.length === 0) {
    throw new Error(
      "No accounts are classified as retirement/HSA/investment-taxable -- nothing to build a portfolio from. " +
        `Run './actual configure' and add overrides to ${options.configPath} first.`,
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

  const generated = buildFireDashboard(expenseCategoryIds, portfolioIds, fireConfig.crossover, totalMonthlyContribution(accounts))
  generated.widgets.push(
    ...buildMonteCarloWidgets(0, 6, accounts, currentAge, retirementAges, planToAge, annualSpend, fireConfig.monteCarlo),
  )

  const existing = loadExistingDashboard(options.outputPath)
  const dashboard = mergeGeneratedDashboard(generated, existing)
  const json = JSON.stringify(dashboard, null, 2)

  if (options.dryRun) {
    console.log("\nWould write:\n")
    console.log(json)
    return
  }

  writeFileSync(options.outputPath, `${json}\n`)
  console.log(`\nWrote ${options.outputPath} (${dashboard.widgets.length} widgets: ${dashboard.widgets.map((widget) => widget.type).join(", ")}).`)
  if (existing) {
    console.log(`Preserved customizations from the existing ${options.outputPath} where present.`)
  }
  console.log(
    "\nThe Monte Carlo widget is an experimental Actual feature: enable it under Settings > " +
      "Advanced > Experimental features > Monte Carlo Analysis Report before importing, or the " +
      "widget won't render.",
  )
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
  process.stderr.write(`${formatError(error)}\n`)
  process.exit(1)
})
