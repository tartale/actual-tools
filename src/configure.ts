#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs"

import {
  confirmOnTty,
  fetchAccountBalance,
  fetchAllOpenAccounts,
  formatUsd,
  loadConfigFromEnv,
  openTtyInterface,
  promptChoice,
  promptNumber,
  validateDateFormat,
} from "./actual-helpers.ts"
import type { Account, ActualConfig, TtyInterface } from "./actual-helpers.ts"
import {
  CROSSOVER_PROJECTION_TYPES,
  DEFAULT_CONFIG_PATH,
  FIRE_ACCOUNT_CATEGORIES,
  MONTE_CARLO_ALLOCATION_PRESET_LABELS,
  MONTE_CARLO_ALLOCATION_PRESETS,
  MONTE_CARLO_RETURN_MODELS,
  MONTE_CARLO_TAX_MODELS,
  MONTE_CARLO_WITHDRAWAL_RULE_TYPES,
  MONTE_CARLO_WITHDRAWAL_STRATEGIES,
  classifyByHeuristic,
  findOverride,
  isPortfolioCategory,
  loadFireConfig,
  traitsForCategory,
  writeFireConfig,
} from "./fire-accounts.ts"
import type { FireAccountOverride, FireConfig } from "./fire-accounts.ts"
import { extractConfigFromDashboard } from "./fire-dashboard.ts"
import type { ExistingDashboard, MonteCarloTaxBandMeta, MonteCarloWithdrawalRuleMeta } from "./fire-dashboard.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// The API has no running-balance field; summing an account's full transaction history is the
// accounting identity used instead (see fetchAccountBalance), so this must reach back further
// than any real account could have existed.
const BALANCE_SINCE_DATE = "1970-01-01"

const DEFAULT_DASHBOARD_PATH = "fire-dashboard.json"

interface Options {
  configPath: string
  dashboardPath: string
}

const HELP_PAGE: HelpPage = {
  usage: "./actual configure [OPTIONS]",
  description:
    "Interactively configures everything ./actual reports fire needs: classifies every open " +
    "account for FIRE reporting -- retirement, taxable investment, HSA, debt, cash, or other -- " +
    "then asks about your birth date, retirement age(s), and every crossover/Monte Carlo chart " +
    "assumption those widgets expose. An existing entry in the config file is offered as the " +
    "default for every question. Replaces ./actual accounts classify.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-f, --config PATH",
          description: `Path to the config file to read defaults from and write (default: ${DEFAULT_CONFIG_PATH}).`,
        },
        {
          name: "-d, --dashboard PATH",
          description:
            `Path to a previously generated dashboard JSON (default: ${DEFAULT_DASHBOARD_PATH}) -- if it looks newer ` +
            "than the config file, offers to import its assumptions first.",
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
  let configPath = DEFAULT_CONFIG_PATH
  let dashboardPath = DEFAULT_DASHBOARD_PATH

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-f" || arg === "--config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --config")
      }
      configPath = value
      i++
    } else if (arg === "-d" || arg === "--dashboard") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --dashboard")
      }
      dashboardPath = value
      i++
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { configPath, dashboardPath }
}

// Function to read a dashboard JSON file, tolerating anything that doesn't parse as one -- this is
// only ever used to OFFER an import, never required, so a missing or malformed file is silently
// treated as "nothing to offer," not an error.
function tryLoadDashboard(path: string): ExistingDashboard | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { widgets?: unknown }).widgets)) {
      return null
    }
    return parsed as ExistingDashboard
  } catch {
    return null
  }
}

// Function to offer importing a newer dashboard file's customizations into the config, if one
// exists and looks newer than the config file itself -- e.g. after tweaking an assumption in
// Actual's own Monte Carlo configuration UI and copying the widget JSON back. Returns the config
// unchanged if there's nothing to offer, the dashboard isn't newer, or the user declines.
async function maybeImportFromDashboard(tty: TtyInterface, configPath: string, dashboardPath: string, config: FireConfig): Promise<FireConfig> {
  if (!existsSync(dashboardPath)) {
    return config
  }
  if (existsSync(configPath) && statSync(dashboardPath).mtimeMs <= statSync(configPath).mtimeMs) {
    return config
  }
  const dashboard = tryLoadDashboard(dashboardPath)
  if (!dashboard) {
    return config
  }
  const importIt = await confirmOnTty(
    tty,
    `\n${dashboardPath} looks newer than ${configPath} -- import its crossover/Monte Carlo assumptions, contributions, and retirement ages into ${configPath} first?`,
  )
  return importIt ? extractConfigFromDashboard(dashboard, config) : config
}

// Function to interactively classify one account: shows its name and balance, offers an existing
// override or an inferred heuristic guess as the default (in that order of preference), and forces
// an explicit choice when neither is available. Portfolio accounts additionally get an allocation
// and a monthly contribution question.
async function classifyOneAccount(tty: TtyInterface, account: Account, balanceCents: number, existingConfig: FireConfig): Promise<FireAccountOverride> {
  const override = findOverride(account, existingConfig)
  const heuristic = classifyByHeuristic(account.name)
  const defaultCategory = override?.category ?? heuristic?.category ?? null
  const defaultIndex = defaultCategory === null ? null : FIRE_ACCOUNT_CATEGORIES.indexOf(defaultCategory)

  process.stderr.write(`\n${account.name} -- current balance ${formatUsd(balanceCents)}\n`)
  const chosenIndex = await promptChoice(tty, "What kind of account is this?", FIRE_ACCOUNT_CATEGORIES, defaultIndex)
  const category = FIRE_ACCOUNT_CATEGORIES[chosenIndex] as (typeof FIRE_ACCOUNT_CATEGORIES)[number]

  // If the account keeps the category it already had, preserve any customized taxTreatment/
  // accessAge/allocationPreset/monthlyContribution from the existing file rather than resetting
  // them to the category's plain defaults every time configure is re-run. A category CHANGE
  // starts fresh from the new category's defaults instead, since customizations tuned for the old
  // category don't necessarily make sense for the new one.
  const carryOver = override?.category === category ? override : null
  const traits = traitsForCategory(category)
  const taxTreatment = carryOver?.taxTreatment ?? traits.taxTreatment
  const accessAge = carryOver?.accessAge ?? traits.accessAge

  let allocationPreset = traits.allocationPreset
  let monthlyContribution: number | undefined
  if (isPortfolioCategory(category)) {
    const defaultPreset = carryOver?.allocationPreset ?? traits.allocationPreset
    const defaultPresetIndex = defaultPreset === null ? null : MONTE_CARLO_ALLOCATION_PRESETS.indexOf(defaultPreset)
    const presetOptions = MONTE_CARLO_ALLOCATION_PRESETS.map((preset) => `${preset} (${MONTE_CARLO_ALLOCATION_PRESET_LABELS[preset]})`)
    const presetIndex = await promptChoice(
      tty,
      "What's an estimate of the stock/bond mix for this account?",
      presetOptions,
      defaultPresetIndex,
      MONTE_CARLO_ALLOCATION_PRESETS,
    )
    allocationPreset = MONTE_CARLO_ALLOCATION_PRESETS[presetIndex] as (typeof MONTE_CARLO_ALLOCATION_PRESETS)[number]

    const defaultMonthlyDollars = carryOver?.monthlyContribution ? carryOver.monthlyContribution / 100 : 0
    const monthlyDollars = await promptNumber(tty, "Monthly contribution to this account, in dollars (0 for none)", defaultMonthlyDollars)
    monthlyContribution = monthlyDollars > 0 ? Math.round(monthlyDollars * 100) : undefined
  }

  return { match: account.id, category, taxTreatment, accessAge, allocationPreset, monthlyContribution }
}

// Function to ask for a birth date, defaulting to (and validating the same way as) the existing
// config's, if present.
async function askBirthDate(tty: TtyInterface, existing: FireConfig): Promise<string> {
  const defaultLabel = existing.birthDate ? ` [${existing.birthDate}]` : ""
  while (true) {
    const answer = (await tty.question(`\nYour birth date (YYYY-MM-DD)${defaultLabel}: `)).trim()
    const value = answer === "" && existing.birthDate ? existing.birthDate : answer
    try {
      validateDateFormat(value)
      return value
    } catch {
      process.stderr.write("Please enter a date as YYYY-MM-DD.\n")
    }
  }
}

// Function to ask for one or more retirement ages, defaulting to the existing config's list --
// including defaulting "add another?" to yes when the existing config already had more ages than
// asked so far, so re-running configure against a multi-age config doesn't silently drop any.
async function askRetirementAges(tty: TtyInterface, existing: FireConfig): Promise<number[]> {
  const ages: number[] = [await promptNumber(tty, "\nAge you plan to retire at", existing.retirementAges[0] ?? null)]
  while (await confirmOnTty(tty, "Compare another retirement age too?", ages.length < existing.retirementAges.length)) {
    ages.push(await promptNumber(tty, "Another retirement age", existing.retirementAges[ages.length] ?? null))
  }
  return ages
}

// Function to ask how long the plan should be assumed to last -- a conservative default (see
// DEFAULT_PLAN_TO_AGE), not a lifespan estimate.
async function askPlanToAge(tty: TtyInterface, existing: FireConfig): Promise<number> {
  return promptNumber(tty, "\nAssume the plan needs to last to this age (a conservative default, not a lifespan estimate)", existing.planToAge)
}

// Function to ask for every crossover-card assumption. Percent-style fields are asked as
// human-friendly numbers (e.g. "4" for 4%) and divided by 100 for storage.
async function askCrossoverAssumptions(tty: TtyInterface, existing: FireConfig): Promise<FireConfig["crossover"]> {
  const current = existing.crossover

  const safeWithdrawalRatePct = await promptNumber(tty, "\nSafe withdrawal rate, as a percent (e.g. 4 for 4%)", current.safeWithdrawalRate * 100)
  const estimatedReturnPct = await promptNumber(
    tty,
    "Estimated annual return, as a percent (0 to let Actual compute its own historical estimate)",
    current.estimatedReturn === null ? 0 : current.estimatedReturn * 100,
  )
  const projectionTypeIndex = await promptChoice(
    tty,
    "Expense projection method",
    CROSSOVER_PROJECTION_TYPES,
    CROSSOVER_PROJECTION_TYPES.indexOf(current.projectionType),
  )
  const expenseAdjustmentFactor = await promptNumber(tty, "Expense adjustment factor (1 = use expenses as-is)", current.expenseAdjustmentFactor)
  const showHiddenCategories = await confirmOnTty(tty, "Show hidden categories in the category selector?", current.showHiddenCategories)

  return {
    safeWithdrawalRate: safeWithdrawalRatePct / 100,
    estimatedReturn: estimatedReturnPct > 0 ? estimatedReturnPct / 100 : null,
    projectionType: CROSSOVER_PROJECTION_TYPES[projectionTypeIndex] as (typeof CROSSOVER_PROJECTION_TYPES)[number],
    expenseAdjustmentFactor,
    showHiddenCategories,
  }
}

// Function to ask for the chosen dynamic withdrawal rule's own sub-fields, grouped exactly as
// Actual's own MonteCarloWithdrawalRuleMeta groups them. Skipped entirely for "none", the default.
async function askWithdrawalRule(tty: TtyInterface, current: MonteCarloWithdrawalRuleMeta): Promise<MonteCarloWithdrawalRuleMeta> {
  const typeIndex = await promptChoice(
    tty,
    "Dynamic withdrawal rule (adjusts spending based on portfolio performance)",
    MONTE_CARLO_WITHDRAWAL_RULE_TYPES,
    MONTE_CARLO_WITHDRAWAL_RULE_TYPES.indexOf(current.type),
  )
  const type = MONTE_CARLO_WITHDRAWAL_RULE_TYPES[typeIndex] as (typeof MONTE_CARLO_WITHDRAWAL_RULE_TYPES)[number]

  if (type === "none") {
    return { type }
  }
  if (type === "guardrails") {
    const prosperityTriggerPct = await promptNumber(tty, "Prosperity trigger, as a percent below the initial rate", (current.prosperityTriggerPct ?? 0.2) * 100)
    const prosperityIncreasePct = await promptNumber(tty, "Prosperity increase, as a percent", (current.prosperityIncreasePct ?? 0.1) * 100)
    const preservationTriggerPct = await promptNumber(tty, "Preservation trigger, as a percent above the initial rate", (current.preservationTriggerPct ?? 0.2) * 100)
    const preservationCutPct = await promptNumber(tty, "Preservation cut, as a percent", (current.preservationCutPct ?? 0.1) * 100)
    return {
      type,
      prosperityTriggerPct: prosperityTriggerPct / 100,
      prosperityIncreasePct: prosperityIncreasePct / 100,
      preservationTriggerPct: preservationTriggerPct / 100,
      preservationCutPct: preservationCutPct / 100,
    }
  }
  if (type === "ratcheting") {
    const balanceThresholdMultiple = await promptNumber(tty, "Balance threshold multiple (e.g. 1.5 = 150% of initial)", current.balanceThresholdMultiple ?? 1.5)
    const consecutiveYears = await promptNumber(tty, "Consecutive years above threshold before ratcheting up", current.consecutiveYears ?? 3)
    const ratchetIncreasePct = await promptNumber(tty, "Ratchet increase, as a percent", (current.ratchetIncreasePct ?? 0.05) * 100)
    return { type, balanceThresholdMultiple, consecutiveYears, ratchetIncreasePct: ratchetIncreasePct / 100 }
  }
  if (type === "floor-ceiling") {
    const floorPct = await promptNumber(tty, "Floor, as a percent below the inflation-adjusted initial withdrawal", (current.floorPct ?? 0.15) * 100)
    const ceilingPct = await promptNumber(tty, "Ceiling, as a percent above the inflation-adjusted initial withdrawal", (current.ceilingPct ?? 0.2) * 100)
    return { type, floorPct: floorPct / 100, ceilingPct: ceilingPct / 100 }
  }
  // boundaries
  const upperRateThreshold = await promptNumber(tty, "Upper withdrawal-rate threshold, as a percent", (current.upperRateThreshold ?? 0.06) * 100)
  const upperCutPct = await promptNumber(tty, "Cut when the upper threshold is hit, as a percent", (current.upperCutPct ?? 0.1) * 100)
  const lowerRateThreshold = await promptNumber(tty, "Lower withdrawal-rate threshold, as a percent", (current.lowerRateThreshold ?? 0.04) * 100)
  const lowerIncreasePct = await promptNumber(tty, "Increase when the lower threshold is hit, as a percent", (current.lowerIncreasePct ?? 0.05) * 100)
  return {
    type,
    upperRateThreshold: upperRateThreshold / 100,
    upperCutPct: upperCutPct / 100,
    lowerRateThreshold: lowerRateThreshold / 100,
    lowerIncreasePct: lowerIncreasePct / 100,
  }
}

// Function to ask for one or more progressive tax bands, only ever called when taxModel is
// "bands" -- "flat", the default, skips this entirely.
async function askTaxBands(tty: TtyInterface, existing: readonly MonteCarloTaxBandMeta[]): Promise<MonteCarloTaxBandMeta[]> {
  const bands: MonteCarloTaxBandMeta[] = []
  let index = 0
  do {
    const existingBand = existing[index]
    const fromDollars = await promptNumber(tty, `Tax band ${index + 1}: income threshold, in dollars`, existingBand ? (existingBand.from ?? 0) / 100 : 0)
    const ratePct = await promptNumber(tty, `Tax band ${index + 1}: rate, as a percent`, existingBand ? (existingBand.rate ?? 0) * 100 : 0)
    bands.push({ id: `band-${index + 1}`, from: Math.round(fromDollars * 100), rate: ratePct / 100 })
    index++
  } while (await confirmOnTty(tty, "Add another tax band?", index < existing.length))
  return bands
}

// Function to ask for every monte-carlo-card assumption not already derived from account
// classification (pots) or the personal/retirement-age answers above (spendingPhases, currentAge,
// targetAge).
async function askMonteCarloAssumptions(tty: TtyInterface, existing: FireConfig): Promise<FireConfig["monteCarlo"]> {
  const current = existing.monteCarlo

  const strategyIndex = await promptChoice(
    tty,
    "\nWithdrawal strategy across pots",
    MONTE_CARLO_WITHDRAWAL_STRATEGIES,
    MONTE_CARLO_WITHDRAWAL_STRATEGIES.indexOf(current.withdrawalStrategy),
  )
  const withdrawalStrategy = MONTE_CARLO_WITHDRAWAL_STRATEGIES[strategyIndex] as (typeof MONTE_CARLO_WITHDRAWAL_STRATEGIES)[number]

  const returnModelIndex = await promptChoice(tty, "Return model", MONTE_CARLO_RETURN_MODELS, MONTE_CARLO_RETURN_MODELS.indexOf(current.returnModel))
  const returnModel = MONTE_CARLO_RETURN_MODELS[returnModelIndex] as (typeof MONTE_CARLO_RETURN_MODELS)[number]

  const withdrawalRule = await askWithdrawalRule(tty, current.withdrawalRule)

  const minimumWithdrawalDollars = await promptNumber(tty, "Minimum annual withdrawal, in dollars (0 for no floor)", current.minimumWithdrawal / 100)
  const inflationMeanPct = await promptNumber(
    tty,
    "Mean yearly inflation, as a percent (0 for flat, uninflated withdrawals)",
    current.inflationMean === null ? 0 : current.inflationMean * 100,
  )
  const inflationStdDevPct = await promptNumber(tty, "Yearly inflation volatility, as a percent", current.inflationStdDev * 100)

  const taxModelIndex = await promptChoice(tty, "Tax model", MONTE_CARLO_TAX_MODELS, MONTE_CARLO_TAX_MODELS.indexOf(current.taxModel))
  const taxModel = MONTE_CARLO_TAX_MODELS[taxModelIndex] as (typeof MONTE_CARLO_TAX_MODELS)[number]
  const taxBands = taxModel === "bands" ? await askTaxBands(tty, current.taxBands) : current.taxBands

  const simulationCount = await promptNumber(tty, "Number of simulations to run", current.simulationCount)

  return {
    withdrawalStrategy,
    returnModel,
    withdrawalRule,
    minimumWithdrawal: Math.round(minimumWithdrawalDollars * 100),
    inflationMean: inflationMeanPct > 0 ? inflationMeanPct / 100 : null,
    inflationStdDev: inflationStdDevPct / 100,
    taxModel,
    taxBands,
    simulationCount,
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const actualConfig: ActualConfig = loadConfigFromEnv()

  const accounts = await fetchAllOpenAccounts(actualConfig)
  const { config: loadedConfig } = loadFireConfig(options.configPath)
  const balances = await Promise.all(accounts.map((account) => fetchAccountBalance(actualConfig, account.id, BALANCE_SINCE_DATE)))

  const tty = openTtyInterface()
  try {
    const existingConfig = await maybeImportFromDashboard(tty, options.configPath, options.dashboardPath, loadedConfig)

    const overrides: FireAccountOverride[] = []
    for (const [index, account] of accounts.entries()) {
      overrides.push(await classifyOneAccount(tty, account, balances[index] as number, existingConfig))
      // Write after every step, not just at the very end, so an interrupted session (ctrl-c, a
      // crash) keeps everything answered so far instead of losing it all.
      writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides })
    }

    const birthDate = await askBirthDate(tty, existingConfig)
    writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate })

    const retirementAges = await askRetirementAges(tty, existingConfig)
    writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges })

    const planToAge = await askPlanToAge(tty, existingConfig)
    writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges, planToAge })

    const crossover = await askCrossoverAssumptions(tty, existingConfig)
    writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges, planToAge, crossover })

    const monteCarlo = await askMonteCarloAssumptions(tty, existingConfig)
    const finalConfig: FireConfig = { ...existingConfig, accounts: overrides, birthDate, retirementAges, planToAge, crossover, monteCarlo }
    writeFireConfig(options.configPath, finalConfig)

    console.log(`\nWrote ${options.configPath}.`)
  } finally {
    tty.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
