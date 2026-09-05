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
  CROSSOVER_PROJECTION_TYPE_LABELS,
  CROSSOVER_PROJECTION_TYPES,
  DEFAULT_CONFIG_PATH,
  FIRE_ACCOUNT_CATEGORIES,
  MONTE_CARLO_ALLOCATION_PRESET_LABELS,
  MONTE_CARLO_ALLOCATION_PRESETS,
  MONTE_CARLO_RETURN_MODEL_LABELS,
  MONTE_CARLO_RETURN_MODELS,
  MONTE_CARLO_TAX_MODEL_LABELS,
  MONTE_CARLO_TAX_MODELS,
  MONTE_CARLO_WITHDRAWAL_RULE_TYPE_LABELS,
  MONTE_CARLO_WITHDRAWAL_RULE_TYPES,
  MONTE_CARLO_WITHDRAWAL_STRATEGIES,
  MONTE_CARLO_WITHDRAWAL_STRATEGY_LABELS,
  classifyByHeuristic,
  findOverride,
  isPortfolioCategory,
  loadFireConfig,
  traitsForCategory,
  writeFireConfig,
} from "./fire-accounts.ts"
import type { FireAccountCategory, FireAccountOverride, FireConfig } from "./fire-accounts.ts"
import { extractConfigFromDashboard } from "./fire-dashboard.ts"
import type { ExistingDashboard, MonteCarloTaxBandMeta, MonteCarloWithdrawalRuleMeta } from "./fire-dashboard.ts"
import { DEFAULT_IRS_LIMITS_PATH, isIrsLimitsStale, loadIrsLimits } from "./irs-limits.ts"
import type { IrsLimits } from "./irs-limits.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// The API has no running-balance field; summing an account's full transaction history is the
// accounting identity used instead (see fetchAccountBalance), so this must reach back further
// than any real account could have existed.
const BALANCE_SINCE_DATE = "1970-01-01"

const DEFAULT_DASHBOARD_PATH = "fire-dashboard.json"

// The four question groups configure asks about, in the order asked. -s/--section narrows a run
// down to just the ones named, so re-running to tweak one thing (e.g. this year's contributions)
// doesn't require re-answering everything else too.
const CONFIGURE_SECTIONS = ["accounts", "personal", "crossover", "monte-carlo"] as const
type ConfigureSection = (typeof CONFIGURE_SECTIONS)[number]

interface Options {
  configPath: string
  dashboardPath: string
  irsLimitsPath: string
  sections: ConfigureSection[]
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
        {
          name: "-i, --irs-limits PATH",
          description:
            `Path to the IRS contribution limits reference file (default: ${DEFAULT_IRS_LIMITS_PATH}) -- shown next to ` +
            "retirement/HSA contribution questions. Missing is fine, just skips that context.",
        },
        {
          name: "-s, --section NAME",
          description:
            `Only ask this section's questions, leaving everything else as it already is in the config file. ` +
            `Repeatable. One of: ${CONFIGURE_SECTIONS.join(", ")}. Default: all of them. Account classification is ` +
            "always included on a first run (an empty account list would leave reports fire with no portfolio).",
        },
        { name: "-h, --help", description: "Show this message and exit." },
      ],
    },
  ],
}

// Function to build a promptChoice options array with each choice's plain-language description
// shown inline (e.g. "hampel (filters out outliers, then takes the median)") -- the descriptions
// come from fire-accounts.ts's *_LABELS maps, condensed from Actual's own real config-screen copy.
function labeledOptions<Value extends string>(values: readonly Value[], labels: Record<Value, string>): string[] {
  return values.map((value) => `${value} (${labels[value]})`)
}

// Function to print a line of context before a question -- the CLI equivalent of the "?" tooltip
// Actual's own configuration UI shows next to each of these fields. Wording below is adapted from
// that real tooltip text (Crossover.tsx, MonteCarloConfiguration.tsx, and friends), not invented,
// so the explanation here matches what a person would see clicking the same field in Actual itself.
function explain(text: string): void {
  process.stderr.write(`${text}\n`)
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
  let irsLimitsPath = DEFAULT_IRS_LIMITS_PATH
  const sections: ConfigureSection[] = []

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
    } else if (arg === "-i" || arg === "--irs-limits") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --irs-limits")
      }
      irsLimitsPath = value
      i++
    } else if (arg === "-s" || arg === "--section") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --section")
      }
      if (!(CONFIGURE_SECTIONS as readonly string[]).includes(value)) {
        usage(`Unknown section "${value}". Valid sections: ${CONFIGURE_SECTIONS.join(", ")}.`)
      }
      sections.push(value as ConfigureSection)
      i++
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { configPath, dashboardPath, irsLimitsPath, sections: sections.length > 0 ? sections : [...CONFIGURE_SECTIONS] }
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

// Function to print the relevant IRS annual contribution limit(s) as reference context before the
// monthly-contribution question, for the categories that actually have an IRS limit. "retirement-
// tax-deferred"/"retirement-roth" cover both an employer plan (401(k)/403(b)/etc.) and an IRA --
// this tool's heuristic can't tell which one a given account actually is, so both are shown and
// the person picks the number that applies. No-op if the reference file isn't present -- this is
// advisory context, never required.
function explainIrsLimits(category: FireAccountCategory, limits: IrsLimits | null): void {
  if (limits === null) {
    return
  }
  const staleWarning = isIrsLimitsStale(limits) ? ` -- these are ${limits.taxYear} figures and may be out of date` : ""
  const employerPlanLine =
    `401(k)/403(b)/457/TSP ${formatUsd(limits.employerPlan.standard)}/yr ` +
    `(${formatUsd(limits.employerPlan.standard + limits.employerPlan.catchUp50)} if 50-59 or 64+, ` +
    `${formatUsd(limits.employerPlan.standard + limits.employerPlan.catchUp60to63)} if 60-63)`
  const iraLine = `IRA ${formatUsd(limits.ira.standard)}/yr (${formatUsd(limits.ira.standard + limits.ira.catchUp50)} if 50+)`

  if (category === "retirement-tax-deferred") {
    explain(`IRS ${limits.taxYear} annual limit, whichever this account actually is${staleWarning}: ${employerPlanLine}; Traditional ${iraLine}.`)
  } else if (category === "retirement-roth") {
    explain(
      `IRS ${limits.taxYear} annual limit${staleWarning}: Roth ${iraLine} (income limits may reduce or eliminate eligibility); ` +
        `Roth 401(k) shares the employer-plan limit with a traditional 401(k): ${employerPlanLine}.`,
    )
  } else if (category === "hsa") {
    explain(
      `IRS ${limits.taxYear} annual limit${staleWarning}: ${formatUsd(limits.hsa.selfOnly)}/yr self-only coverage, ` +
        `${formatUsd(limits.hsa.family)}/yr family coverage (+${formatUsd(limits.hsa.catchUp55)} if 55+).`,
    )
  }
}

// Function to interactively classify one account: shows its name and balance, offers an existing
// override or an inferred heuristic guess as the default (in that order of preference), and forces
// an explicit choice when neither is available. Portfolio accounts additionally get an allocation
// and a monthly contribution question.
async function classifyOneAccount(
  tty: TtyInterface,
  account: Account,
  balanceCents: number,
  existingConfig: FireConfig,
  irsLimits: IrsLimits | null,
): Promise<FireAccountOverride> {
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

    explain("Paid in at the start of each year (grown to an annual amount) and invested alongside the account's own balance from then on.")
    explainIrsLimits(category, irsLimits)
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

  explain(
    "\nSafe withdrawal rate: the amount you plan to withdraw from your investable portfolio each " +
      "year to fund your living expenses (see the \"4% rule\").",
  )
  const safeWithdrawalRatePct = await promptNumber(tty, "Safe withdrawal rate, as a percent (e.g. 4 for 4%)", current.safeWithdrawalRate * 100, "%")

  explain(
    "Estimated return: the expected annual return rate for your investments, used to project " +
      "portfolio growth. Leave at 0 to let Actual compute its own historical estimate instead.",
  )
  const estimatedReturnPct = await promptNumber(
    tty,
    "Estimated annual return, as a percent (0 for Actual's own estimate)",
    current.estimatedReturn === null ? 0 : current.estimatedReturn * 100,
    "%",
  )

  explain("Expense projection method -- how past expenses are projected into the future.")
  const projectionTypeIndex = await promptChoice(
    tty,
    "Expense projection method",
    labeledOptions(CROSSOVER_PROJECTION_TYPES, CROSSOVER_PROJECTION_TYPE_LABELS),
    CROSSOVER_PROJECTION_TYPES.indexOf(current.projectionType),
    CROSSOVER_PROJECTION_TYPES,
  )

  explain(
    "Target income, as a percent of your projected expenses (Actual's own label for this field). " +
      "100 = plan for retirement income equal to your projected expenses. Above 100 = plan to " +
      "spend more in retirement (e.g. 110 pads expenses by 10%). Below 100 = plan to spend less " +
      "(e.g. 90, if you expect no more commuting or a paid-off mortgage).",
  )
  const expenseAdjustmentFactorPct = await promptNumber(tty, "Target income, as a percent of projected expenses", current.expenseAdjustmentFactor * 100, "%")

  const showHiddenCategories = await confirmOnTty(tty, "Show hidden categories in the category selector?", current.showHiddenCategories)

  return {
    safeWithdrawalRate: safeWithdrawalRatePct / 100,
    estimatedReturn: estimatedReturnPct > 0 ? estimatedReturnPct / 100 : null,
    projectionType: CROSSOVER_PROJECTION_TYPES[projectionTypeIndex] as (typeof CROSSOVER_PROJECTION_TYPES)[number],
    expenseAdjustmentFactor: expenseAdjustmentFactorPct / 100,
    showHiddenCategories,
  }
}

// Function to ask for the chosen dynamic withdrawal rule's own sub-fields, grouped exactly as
// Actual's own MonteCarloWithdrawalRuleMeta groups them. Skipped entirely for "none", the default.
async function askWithdrawalRule(tty: TtyInterface, current: MonteCarloWithdrawalRuleMeta): Promise<MonteCarloWithdrawalRuleMeta> {
  const typeIndex = await promptChoice(
    tty,
    "Dynamic withdrawal rule (adjusts spending based on portfolio performance)",
    labeledOptions(MONTE_CARLO_WITHDRAWAL_RULE_TYPES, MONTE_CARLO_WITHDRAWAL_RULE_TYPE_LABELS),
    MONTE_CARLO_WITHDRAWAL_RULE_TYPES.indexOf(current.type),
    MONTE_CARLO_WITHDRAWAL_RULE_TYPES,
  )
  const type = MONTE_CARLO_WITHDRAWAL_RULE_TYPES[typeIndex] as (typeof MONTE_CARLO_WITHDRAWAL_RULE_TYPES)[number]

  if (type === "none") {
    return { type }
  }
  if (type === "guardrails") {
    explain(
      "Guardrails (Guyton-Klinger). Capital preservation rule: if the withdrawal rate rises more " +
        "than the trigger above the planned rate, cut withdrawals by the cut percent. Prosperity " +
        "rule: if the rate falls more than the trigger below the planned rate, raise withdrawals " +
        "by the increase percent.",
    )
    const prosperityTriggerPct = await promptNumber(tty, "Prosperity trigger, as a percent below the initial rate", (current.prosperityTriggerPct ?? 0.2) * 100, "%")
    const prosperityIncreasePct = await promptNumber(tty, "Prosperity increase, as a percent", (current.prosperityIncreasePct ?? 0.1) * 100, "%")
    const preservationTriggerPct = await promptNumber(tty, "Preservation trigger, as a percent above the initial rate", (current.preservationTriggerPct ?? 0.2) * 100, "%")
    const preservationCutPct = await promptNumber(tty, "Preservation cut, as a percent", (current.preservationCutPct ?? 0.1) * 100, "%")
    return {
      type,
      prosperityTriggerPct: prosperityTriggerPct / 100,
      prosperityIncreasePct: prosperityIncreasePct / 100,
      preservationTriggerPct: preservationTriggerPct / 100,
      preservationCutPct: preservationCutPct / 100,
    }
  }
  if (type === "ratcheting") {
    explain(
      "Ratcheting (Kitces). If the accessible balance stays above the threshold multiple of its " +
        "starting level for this many years in a row, raise withdrawals by the increase percent.",
    )
    const balanceThresholdMultiple = await promptNumber(tty, "Balance threshold multiple (e.g. 1.5 = 150% of initial)", current.balanceThresholdMultiple ?? 1.5)
    const consecutiveYears = await promptNumber(tty, "Consecutive years above threshold before ratcheting up", current.consecutiveYears ?? 3)
    const ratchetIncreasePct = await promptNumber(tty, "Ratchet increase, as a percent", (current.ratchetIncreasePct ?? 0.05) * 100, "%")
    return { type, balanceThresholdMultiple, consecutiveYears, ratchetIncreasePct: ratchetIncreasePct / 100 }
  }
  if (type === "floor-ceiling") {
    explain(
      "Floor & ceiling (Bengen). Each year, withdraw the starting rate's share of the current " +
        "accessible balance, but never more than the ceiling above, or less than the floor below, " +
        "the inflation-adjusted planned amount.",
    )
    const floorPct = await promptNumber(tty, "Floor, as a percent below the inflation-adjusted initial withdrawal", (current.floorPct ?? 0.15) * 100, "%")
    const ceilingPct = await promptNumber(tty, "Ceiling, as a percent above the inflation-adjusted initial withdrawal", (current.ceilingPct ?? 0.2) * 100, "%")
    return { type, floorPct: floorPct / 100, ceilingPct: ceilingPct / 100 }
  }
  // boundaries
  explain(
    "Boundaries. If the withdrawal rate rises above the upper threshold, cut withdrawals by the " +
      "upper cut percent. If it falls below the lower threshold, raise withdrawals by the lower " +
      "increase percent.",
  )
  const upperRateThreshold = await promptNumber(tty, "Upper withdrawal-rate threshold, as a percent", (current.upperRateThreshold ?? 0.06) * 100, "%")
  const upperCutPct = await promptNumber(tty, "Cut when the upper threshold is hit, as a percent", (current.upperCutPct ?? 0.1) * 100, "%")
  const lowerRateThreshold = await promptNumber(tty, "Lower withdrawal-rate threshold, as a percent", (current.lowerRateThreshold ?? 0.04) * 100, "%")
  const lowerIncreasePct = await promptNumber(tty, "Increase when the lower threshold is hit, as a percent", (current.lowerIncreasePct ?? 0.05) * 100, "%")
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
    const ratePct = await promptNumber(tty, `Tax band ${index + 1}: rate, as a percent`, existingBand ? (existingBand.rate ?? 0) * 100 : 0, "%")
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

  explain(
    "\nWithdrawal strategy -- how the annual withdrawal is taken when you have more than one pot. " +
      "A pot not yet at its access age is always skipped until it unlocks.",
  )
  const strategyIndex = await promptChoice(
    tty,
    "Withdrawal strategy across pots",
    labeledOptions(MONTE_CARLO_WITHDRAWAL_STRATEGIES, MONTE_CARLO_WITHDRAWAL_STRATEGY_LABELS),
    MONTE_CARLO_WITHDRAWAL_STRATEGIES.indexOf(current.withdrawalStrategy),
    MONTE_CARLO_WITHDRAWAL_STRATEGIES,
  )
  const withdrawalStrategy = MONTE_CARLO_WITHDRAWAL_STRATEGIES[strategyIndex] as (typeof MONTE_CARLO_WITHDRAWAL_STRATEGIES)[number]

  explain("Return model -- how each simulated year's investment return is generated.")
  const returnModelIndex = await promptChoice(
    tty,
    "Return model",
    labeledOptions(MONTE_CARLO_RETURN_MODELS, MONTE_CARLO_RETURN_MODEL_LABELS),
    MONTE_CARLO_RETURN_MODELS.indexOf(current.returnModel),
    MONTE_CARLO_RETURN_MODELS,
  )
  const returnModel = MONTE_CARLO_RETURN_MODELS[returnModelIndex] as (typeof MONTE_CARLO_RETURN_MODELS)[number]

  explain("Dynamic withdrawal rule -- adjusts your withdrawal each year based on how the pots are doing.")
  const withdrawalRule = await askWithdrawalRule(tty, current.withdrawalRule)

  explain(
    "Minimum withdrawal: the annual withdrawal never drops below this amount, no matter what the " +
      "rule says. Only applies in years with planned spending (a $0 spending phase still takes " +
      "nothing). Rises with inflation like your planned spending. 0 = no floor.",
  )
  const minimumWithdrawalDollars = await promptNumber(tty, "Minimum annual withdrawal, in dollars (0 for no floor)", current.minimumWithdrawal / 100)

  explain("Mean inflation: your planned spending grows with it each year so its buying power is maintained. 0 = flat, uninflated withdrawals.")
  const inflationMeanPct = await promptNumber(
    tty,
    "Mean yearly inflation, as a percent (0 for flat, uninflated withdrawals)",
    current.inflationMean === null ? 0 : current.inflationMean * 100,
    "%",
  )

  explain("Inflation volatility: real-world inflation bounces around year to year rather than staying fixed -- when set, each simulated year draws its own rate around the mean.")
  const inflationStdDevPct = await promptNumber(tty, "Yearly inflation volatility, as a percent", current.inflationStdDev * 100, "%")

  explain("Tax model -- your yearly spending is what you keep after tax; the simulation withdraws extra to cover it.")
  const taxModelIndex = await promptChoice(
    tty,
    "Tax model",
    labeledOptions(MONTE_CARLO_TAX_MODELS, MONTE_CARLO_TAX_MODEL_LABELS),
    MONTE_CARLO_TAX_MODELS.indexOf(current.taxModel),
    MONTE_CARLO_TAX_MODELS,
  )
  const taxModel = MONTE_CARLO_TAX_MODELS[taxModelIndex] as (typeof MONTE_CARLO_TAX_MODELS)[number]
  const taxBands = taxModel === "bands" ? await askTaxBands(tty, current.taxBands) : current.taxBands

  explain("Simulation count: how many random scenarios to run. More gives a steadier result but takes slightly longer.")
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

  const { config: loadedConfig, found: configFound } = loadFireConfig(options.configPath)
  const irsLimits = loadIrsLimits(options.irsLimitsPath)

  let sections = options.sections
  if (!configFound && !sections.includes("accounts")) {
    console.log(`No existing ${options.configPath} found -- account classification is required at least once; including it despite -s.`)
    sections = [...sections, "accounts"]
  }
  if (sections.length < CONFIGURE_SECTIONS.length) {
    console.log(`Only asking: ${sections.join(", ")}. Everything else keeps its current value in ${options.configPath}.`)
  }

  const tty = openTtyInterface()
  try {
    const existingConfig = await maybeImportFromDashboard(tty, options.configPath, options.dashboardPath, loadedConfig)

    let overrides = existingConfig.accounts
    if (sections.includes("accounts")) {
      const accounts = await fetchAllOpenAccounts(actualConfig)
      const balances = await Promise.all(accounts.map((account) => fetchAccountBalance(actualConfig, account.id, BALANCE_SINCE_DATE)))
      overrides = []
      for (const [index, account] of accounts.entries()) {
        overrides.push(await classifyOneAccount(tty, account, balances[index] as number, existingConfig, irsLimits))
        // Write after every step, not just at the very end, so an interrupted session (ctrl-c, a
        // crash) keeps everything answered so far instead of losing it all.
        writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides })
      }
    }

    let birthDate = existingConfig.birthDate
    let retirementAges = existingConfig.retirementAges
    let planToAge = existingConfig.planToAge
    if (sections.includes("personal")) {
      birthDate = await askBirthDate(tty, existingConfig)
      writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate })

      retirementAges = await askRetirementAges(tty, existingConfig)
      writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges })

      planToAge = await askPlanToAge(tty, existingConfig)
      writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges, planToAge })
    }

    let crossover = existingConfig.crossover
    if (sections.includes("crossover")) {
      crossover = await askCrossoverAssumptions(tty, existingConfig)
      writeFireConfig(options.configPath, { ...existingConfig, accounts: overrides, birthDate, retirementAges, planToAge, crossover })
    }

    let monteCarlo = existingConfig.monteCarlo
    if (sections.includes("monte-carlo")) {
      monteCarlo = await askMonteCarloAssumptions(tty, existingConfig)
    }

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
