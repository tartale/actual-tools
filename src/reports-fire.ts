#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import {
  ageFromBirthDate,
  averageSpent,
  fetchAccountBalance,
  fetchCategoryGroups,
  fetchHistoricalSpent,
  formatUsd,
  loadConfigFromEnv,
  validateDateFormat,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryMonth } from "./actual-helpers.ts"
import { buildFireDashboard, buildMonteCarloWidgets, mergeGeneratedDashboard, portfolioAccountIds } from "./fire-dashboard.ts"
import type { ExistingDashboard } from "./fire-dashboard.ts"
import { DEFAULT_ACCOUNTS_CONFIG_PATH, loadClassifiedAccounts } from "./fire-accounts.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

const DEFAULT_OUTPUT_PATH = "fire-dashboard.json"
const HISTORY_MONTHS = 12
const BALANCE_SINCE_DATE = "1970-01-01"
// Conservative default planning horizon: assume the money needs to last to this age rather than
// asking the user to estimate their own lifespan. Overridable via --plan-to-age.
const DEFAULT_PLAN_TO_AGE = 100

interface Options {
  outputPath: string
  configPath: string
  dryRun: boolean
  birthDate: string
  retirementAges: number[]
  planToAge: number
}

const HELP_PAGE: HelpPage = {
  usage: "./actual reports fire -r N [OPTIONS]",
  description:
    "Builds an Actual-native FIRE dashboard (net worth, a safe-withdrawal-rate crossover " +
    "projection, and a Monte Carlo retirement simulation -- experimental in Actual, enable it " +
    "under Settings > Advanced > Experimental features first) from your real account and category " +
    "data, and writes it as a dashboard JSON file. Regenerating over an existing output file " +
    "preserves any customization you've made to it (see README). Import it into Actual yourself: " +
    "create a NEW, empty dashboard page first (e.g. \"FIRE\") -- importing REPLACES every widget " +
    "already on the target page.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-r, --retirement-age N",
          description:
            "The age you plan to retire (start drawing down your portfolio) at. Required, can be used " +
            "multiple times to compare retirement ages -- each gets its own Monte Carlo widget, stacked " +
            "on the dashboard (Actual has no way to overlay multiple Monte Carlo configs on one chart).",
        },
        {
          name: "-b, --birth-date YYYY-MM-DD",
          description: "Your birth date, to compute your current age. Overrides AB_BIRTH_DATE. One of the two is required.",
        },
        {
          name: "-p, --plan-to-age N",
          description: `Assume the plan needs to last to this age, instead of guessing your lifespan (default: ${DEFAULT_PLAN_TO_AGE}).`,
        },
        { name: "-o, --output PATH", description: `Where to write the dashboard JSON (default: ${DEFAULT_OUTPUT_PATH}).` },
        {
          name: "-f, --config PATH",
          description: `Path to the account classification overrides file (default: ${DEFAULT_ACCOUNTS_CONFIG_PATH}).`,
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
  let configPath = DEFAULT_ACCOUNTS_CONFIG_PATH
  let dryRun = process.env.DRY_RUN === "true"
  let birthDateArg: string | null = null
  const retirementAges: number[] = []
  let planToAge = DEFAULT_PLAN_TO_AGE

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
      birthDateArg = value
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

  const birthDate = birthDateArg ?? process.env.AB_BIRTH_DATE
  if (!birthDate) {
    usage("Missing birth date: set AB_BIRTH_DATE or pass --birth-date YYYY-MM-DD")
  }
  validateDateFormat(birthDate)
  if (retirementAges.length === 0) {
    usage("At least one --retirement-age is required.")
  }

  return { outputPath, configPath, dryRun, birthDate, retirementAges, planToAge }
}

// Function to get the current month as a yyyy-mm string
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
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
      `Warning: couldn't read existing ${path} to preserve customizations (${error instanceof Error ? error.message : String(error)}); writing fresh.`,
    )
    return null
  }
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

  const currentAge = ageFromBirthDate(options.birthDate)
  if (options.planToAge <= currentAge) {
    usage(`--plan-to-age (${options.planToAge}) must be greater than your current age (${currentAge})`)
  }

  const { accounts, configFound } = await loadClassifiedAccounts(config, options.configPath)
  if (!configFound) {
    throw new Error(`No ${options.configPath} found. Run './actual accounts classify' first to classify your accounts.`)
  }

  const portfolioIds = portfolioAccountIds(accounts)
  if (portfolioIds.length === 0) {
    throw new Error(
      "No accounts are classified as retirement/HSA/investment-taxable -- nothing to build a portfolio from. " +
        `Run './actual accounts classify' and add overrides to ${options.configPath} first.`,
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

  const generated = buildFireDashboard(expenseCategoryIds, portfolioIds)
  generated.widgets.push(
    ...buildMonteCarloWidgets(0, 6, accounts, currentAge, options.retirementAges, options.planToAge, annualSpend),
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
