import { readFileSync, writeFileSync } from "node:fs"

import { fetchAllOpenAccounts } from "./actual-helpers.ts"
import type { Account, ActualConfig } from "./actual-helpers.ts"
import type {
  CrossoverAssumptions,
  CrossoverProjectionType,
  MonteCarloAssumptions,
  MonteCarloReturnModel,
  MonteCarloTaxModel,
  MonteCarloWithdrawalRuleType,
  MonteCarloWithdrawalStrategy,
} from "./fire-dashboard.ts"

// Classifies accounts for FIRE reporting: which are retirement/investment/debt/cash, and enough
// detail about each (tax treatment, access age) to eventually populate a Monte Carlo "pot" in a
// later phase. Pure -- no API calls. Actual's own account API has no type field, so this combines
// a heuristic guess at the account's name with an explicit config file the guess can be
// overridden by. See ./actual configure for the tool that surfaces the result for review.
//
// This module also owns the FireConfig schema -- the single config.json file ./actual configure
// reads defaults from and writes, covering both account classification (below) and every
// crossover/Monte Carlo assumption those charts expose. The assumption-shaped types
// (CrossoverAssumptions, MonteCarloAssumptions, and the enums they're built from) are defined in
// fire-dashboard.ts, since that's this project's one home for vendored Actual widget shapes -- only
// type-only imports flow back here, which Node's --experimental-strip-types erases entirely, so
// there's no runtime import cycle with fire-dashboard.ts's own (real, value) import of
// portfolioAccounts from this file.

export type FireAccountCategory =
  | "retirement-tax-deferred"
  | "retirement-roth"
  | "hsa"
  | "investment-taxable"
  | "debt"
  | "cash"
  | "other"

export type TaxTreatment = "tax-deferred" | "tax-free" | "taxable" | "none"

export const TAX_TREATMENTS: readonly TaxTreatment[] = ["tax-deferred", "tax-free", "taxable", "none"]

// Mirrors Actual's own MonteCarloAllocationPreset, minus "custom" -- we always generate a concrete
// preset, never ask for hand-typed return/volatility numbers. See fire-dashboard.ts for the exact
// mean/stdDev each preset implies (ALLOCATION_PRESET_RETURNS, vendored from Actual's own source).
export type MonteCarloAllocationPreset = "equity-100" | "equity-80" | "equity-60" | "equity-40" | "cash"

export const MONTE_CARLO_ALLOCATION_PRESETS: readonly MonteCarloAllocationPreset[] = [
  "equity-100",
  "equity-80",
  "equity-60",
  "equity-40",
  "cash",
]

// Plain-language description of each preset's stock/bond mix, for display next to the preset name
// wherever a person is picking one (e.g. ./actual configure's interactive prompt).
export const MONTE_CARLO_ALLOCATION_PRESET_LABELS: Record<MonteCarloAllocationPreset, string> = {
  "equity-100": "100% stocks",
  "equity-80": "80% stocks / 20% bonds",
  "equity-60": "60% stocks / 40% bonds",
  "equity-40": "40% stocks / 60% bonds",
  cash: "100% cash",
}

export interface FireAccountTraits {
  category: FireAccountCategory
  taxTreatment: TaxTreatment
  // Age at which withdrawals become unrestricted/penalty-free; null when not applicable or not
  // yet known. Unused until a later phase's Monte Carlo pots -- computed now so the schema doesn't
  // need to change later.
  accessAge: number | null
  // Equity/bond mix for a Monte Carlo "pot"; null for non-portfolio categories (debt/cash/other),
  // which are never pots at all.
  allocationPreset: MonteCarloAllocationPreset | null
}

export type ClassificationSource = "override" | "heuristic" | "default"

export interface ClassifiedAccount extends FireAccountTraits {
  id: string
  name: string
  offbudget: boolean
  source: ClassificationSource
  // A monthly contribution amount in cents, or null if none is configured. Has no category-based
  // default (unlike the FireAccountTraits fields above) -- it only ever comes from an override.
  monthlyContribution: number | null
  // The age this account's owner expects to separate from the employer holding it, or null. Its
  // mere presence asserts "this is a real, currently-held 401(k)/403(b), not an IRA" -- an IRA (or
  // a rolled-over former employer plan) never qualifies for Rule of 55 no matter what age is given.
  // Has no category-based default, same as monthlyContribution -- see fire-dashboard.ts's
  // effectiveAccessAge for how this turns into an earlier accessAge when it's 55 or older.
  ruleOf55SeparationAge: number | null
}

// One user-supplied override. `match` is an account id OR an exact account name, mirroring how
// -c/--category filters already match "name or ID" elsewhere in this repo (shouldUpdateCategory).
export interface FireAccountOverride {
  match: string
  category: FireAccountCategory
  taxTreatment?: TaxTreatment
  accessAge?: number | null
  allocationPreset?: MonteCarloAllocationPreset | null
  monthlyContribution?: number
  ruleOf55SeparationAge?: number | null
}

// The plan-wide inputs ./actual reports fire needs that aren't a crossover/Monte Carlo widget
// assumption and aren't derived from account data -- your birth date, the retirement age(s) to
// compare, and how long the plan should last. Its own top-level config.json section (like
// crossover/monteCarlo below) since these are the "dashboard configurable items" `reports fire`
// itself asks for, distinct from the per-widget assumptions.
export interface DashboardConfig {
  birthDate: string | null
  retirementAges: number[]
  planToAge: number
}

export interface FireConfig {
  version: 1
  accounts: FireAccountOverride[]
  dashboard: DashboardConfig
  crossover: CrossoverAssumptions
  monteCarlo: MonteCarloAssumptions
}

// Conservative default planning horizon: assume the money needs to last to this age rather than
// asking the user to estimate their own lifespan. Overridable in ./actual configure.
export const DEFAULT_PLAN_TO_AGE = 100

export const CROSSOVER_PROJECTION_TYPES: readonly CrossoverProjectionType[] = ["hampel", "median", "mean"]
export const MONTE_CARLO_WITHDRAWAL_STRATEGIES: readonly MonteCarloWithdrawalStrategy[] = [
  "proportional",
  "sequential",
  "best-performer",
  "target-mix",
]
export const MONTE_CARLO_RETURN_MODELS: readonly MonteCarloReturnModel[] = ["normal", "historical-bootstrap", "historical-sequence"]
export const MONTE_CARLO_WITHDRAWAL_RULE_TYPES: readonly MonteCarloWithdrawalRuleType[] = [
  "none",
  "guardrails",
  "ratcheting",
  "floor-ceiling",
  "boundaries",
]
export const MONTE_CARLO_TAX_MODELS: readonly MonteCarloTaxModel[] = ["flat", "bands"]

// Plain-language description of each choice, for display next to it in an interactive prompt --
// same idea as MONTE_CARLO_ALLOCATION_PRESET_LABELS above. Condensed from Actual's own real
// config-screen copy (Crossover.tsx/MonteCarloConfiguration.tsx/MonteCarloWithdrawalRuleConfiguration.tsx
// /MonteCarloTaxConfiguration.tsx), not invented.
export const CROSSOVER_PROJECTION_TYPE_LABELS: Record<CrossoverProjectionType, string> = {
  hampel: "filters out outliers, then takes the median",
  median: "the median, no filtering",
  mean: "the plain average",
}

export const MONTE_CARLO_WITHDRAWAL_STRATEGY_LABELS: Record<MonteCarloWithdrawalStrategy, string> = {
  proportional: "split across pots based on their current balances",
  sequential: "drain the first pot before touching the next",
  "best-performer": "each year, drain last year's highest-returning pot",
  "target-mix": "withdraw from whichever pots grew above their starting share",
}

export const MONTE_CARLO_RETURN_MODEL_LABELS: Record<MonteCarloReturnModel, string> = {
  normal: "drawn from a normal distribution around each pot's return/volatility",
  "historical-bootstrap": "drawn from actual US market years (1928+) in random order",
  "historical-sequence": "replays real market history, one scenario per starting year",
}

export const MONTE_CARLO_WITHDRAWAL_RULE_TYPE_LABELS: Record<MonteCarloWithdrawalRuleType, string> = {
  none: "fixed, inflation-adjusted withdrawals",
  guardrails: "Guyton-Klinger capital-preservation/prosperity triggers",
  ratcheting: "Kitces: raise withdrawals after sustained gains",
  "floor-ceiling": "Bengen: a bounded share of the current balance",
  boundaries: "cut/raise when the withdrawal rate crosses a threshold",
}

export const MONTE_CARLO_TAX_MODEL_LABELS: Record<MonteCarloTaxModel, string> = {
  flat: "one effective tax rate per pot",
  bands: "your own progressive bands, by taxable share per pot",
}

export const DEFAULT_CROSSOVER_CONFIG: CrossoverAssumptions = {
  safeWithdrawalRate: 0.04,
  estimatedReturn: null,
  projectionType: "hampel",
  expenseAdjustmentFactor: 1.0,
  showHiddenCategories: false,
}

export const DEFAULT_MONTE_CARLO_CONFIG: MonteCarloAssumptions = {
  withdrawalStrategy: "proportional",
  returnModel: "normal",
  withdrawalRule: { type: "none" },
  minimumWithdrawal: 0,
  inflationMean: 0.03,
  inflationStdDev: 0.02,
  taxModel: "flat",
  taxBands: [],
  simulationCount: 5000,
}

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  birthDate: null,
  retirementAges: [],
  planToAge: DEFAULT_PLAN_TO_AGE,
}

export const EMPTY_FIRE_CONFIG: FireConfig = {
  version: 1,
  accounts: [],
  dashboard: DEFAULT_DASHBOARD_CONFIG,
  crossover: DEFAULT_CROSSOVER_CONFIG,
  monteCarlo: DEFAULT_MONTE_CARLO_CONFIG,
}

export const DEFAULT_CONFIG_PATH = "config.json"

// Age at which most US tax-advantaged retirement accounts can be withdrawn from without an early
// withdrawal penalty. A rough default -- override per-account for precision (e.g. Roth
// contribution basis, or plan-specific rules like the age-55 separation-from-service exception).
const DEFAULT_ACCESS_AGE = 59

// Every category, in the order shown to the user when picking one interactively, with the default
// tax treatment/access age that category implies -- the single source of truth both the heuristic
// rules below and the interactive classifier (./actual configure) derive traits from.
export const FIRE_ACCOUNT_CATEGORIES: readonly FireAccountCategory[] = [
  "retirement-tax-deferred",
  "retirement-roth",
  "hsa",
  "investment-taxable",
  "debt",
  "cash",
  "other",
]

export const CATEGORY_TRAITS: Record<FireAccountCategory, Omit<FireAccountTraits, "category">> = {
  "retirement-tax-deferred": { taxTreatment: "tax-deferred", accessAge: DEFAULT_ACCESS_AGE, allocationPreset: "equity-80" },
  "retirement-roth": { taxTreatment: "tax-free", accessAge: DEFAULT_ACCESS_AGE, allocationPreset: "equity-80" },
  hsa: { taxTreatment: "tax-free", accessAge: null, allocationPreset: "equity-60" },
  "investment-taxable": { taxTreatment: "taxable", accessAge: null, allocationPreset: "equity-80" },
  debt: { taxTreatment: "none", accessAge: null, allocationPreset: null },
  cash: { taxTreatment: "none", accessAge: null, allocationPreset: null },
  other: { taxTreatment: "none", accessAge: null, allocationPreset: null },
}

// Function to build the full traits for a category, using CATEGORY_TRAITS' defaults
export function traitsForCategory(category: FireAccountCategory): FireAccountTraits {
  return { category, ...CATEGORY_TRAITS[category] }
}

// Categories that count as part of an investable portfolio -- eligible for a Monte Carlo "pot"
// and for the crossover-card's safe-withdrawal-rate calculation. Debt isn't investable; cash/other
// are a spending buffer, not portfolio.
const PORTFOLIO_CATEGORIES: readonly FireAccountCategory[] = [
  "retirement-tax-deferred",
  "retirement-roth",
  "hsa",
  "investment-taxable",
]

// Function to test whether a category counts as part of the investable portfolio
export function isPortfolioCategory(category: FireAccountCategory): boolean {
  return PORTFOLIO_CATEGORIES.includes(category)
}

// Function to filter classified accounts down to the investable portfolio
export function portfolioAccounts(accounts: readonly ClassifiedAccount[]): ClassifiedAccount[] {
  return accounts.filter((account) => isPortfolioCategory(account.category))
}

// Ordered, case-insensitive name-pattern rules. Order matters: more specific patterns (roth, hsa)
// are checked before broader ones (ira, investment) so e.g. "Roth 401k" classifies as
// retirement-roth, not retirement-tax-deferred.
interface HeuristicRule {
  pattern: RegExp
  category: FireAccountCategory
}

const HEURISTIC_RULES: readonly HeuristicRule[] = [
  { pattern: /\bhsa\b|\bhealth savings\b/i, category: "hsa" },
  { pattern: /\broth\b/i, category: "retirement-roth" },
  { pattern: /\b401\s?k\b|\b403\s?b\b|\b457\b|\bira\b|\bpension\b|\btsp\b/i, category: "retirement-tax-deferred" },
  { pattern: /\bmortgage\b|\bloan\b|\bcredit card\b|\bline of credit\b|\bheloc\b/i, category: "debt" },
  { pattern: /\bbrokerage\b|\binvestment\b|\btaxable\b/i, category: "investment-taxable" },
]

// Function to classify a single account by name only, using ordered heuristic rules. Returns null
// when nothing matches, so the caller can fall back to a documented default rather than a silent
// guess.
export function classifyByHeuristic(name: string): FireAccountTraits | null {
  const rule = HEURISTIC_RULES.find((candidate) => candidate.pattern.test(name))
  return rule ? traitsForCategory(rule.category) : null
}

// Function to locate an account's override by id or exact name, returning -1 when it has none.
// Callers that rewrite an entry must go through this rather than matching on id alone: an override
// keyed by name would be missed, and appending an id-keyed duplicate beside it would be silently
// dead, since findOverride takes the FIRST match.
export function overrideIndexFor(overrides: readonly FireAccountOverride[], account: Pick<Account, "id" | "name">): number {
  return overrides.findIndex((override) => override.match === account.id || override.match === account.name)
}

// Function to find a config override matching an account by id or exact name
export function findOverride(account: Pick<Account, "id" | "name">, config: Pick<FireConfig, "accounts">): FireAccountOverride | null {
  const index = overrideIndexFor(config.accounts, account)
  return index === -1 ? null : (config.accounts[index] as FireAccountOverride)
}

// Function to drop overrides for accounts that are no longer open. Only safe to apply after every
// open account has actually been visited -- run against a partial pass it would delete the entries
// the pass had not reached yet.
export function pruneStaleOverrides(
  overrides: readonly FireAccountOverride[],
  openAccountIds: readonly string[],
): FireAccountOverride[] {
  const open = new Set(openAccountIds)
  return overrides.filter((override) => open.has(override.match))
}

// Function to classify every account: override > heuristic > safe default ("other", tax
// treatment "none"). "other" -- not "cash" -- is the fallback, since a name the heuristic can't
// recognize might not be cash at all; "cash" itself is only ever chosen explicitly (an override,
// or an interactive answer). The "default" source is meant to be visibly flagged by callers (e.g.
// configure.ts) as needing review -- it is a safe fallback, not a confident classification.
export function classifyAccounts(
  accounts: readonly Pick<Account, "id" | "name" | "offbudget">[],
  config: Pick<FireConfig, "accounts">,
): ClassifiedAccount[] {
  return accounts.map((account) => {
    const identity = { id: account.id, name: account.name, offbudget: account.offbudget }
    const override = findOverride(account, config)
    if (override) {
      return {
        ...identity,
        category: override.category,
        taxTreatment: override.taxTreatment ?? "none",
        accessAge: override.accessAge ?? null,
        allocationPreset: override.allocationPreset ?? null,
        monthlyContribution: override.monthlyContribution ?? null,
        ruleOf55SeparationAge: override.ruleOf55SeparationAge ?? null,
        source: "override" as const,
      }
    }
    const heuristic = classifyByHeuristic(account.name)
    if (heuristic) {
      return { ...identity, ...heuristic, monthlyContribution: null, ruleOf55SeparationAge: null, source: "heuristic" as const }
    }
    return { ...identity, ...traitsForCategory("other"), monthlyContribution: null, ruleOf55SeparationAge: null, source: "default" as const }
  })
}

export interface LoadedFireConfig {
  config: FireConfig
  found: boolean
}

// Function to load config.json. Missing is fine (an empty, unconfigured config) -- `found: false`
// lets a caller decide whether to warn about that, keeping this function itself free of console
// side effects and easy to test. Present-but-malformed is always an error: silently ignoring a
// typo in the user's own config would be worse than failing loudly. An old-shape file (from before
// this schema grew these sections) is NOT an error -- missing sections are treated as "not yet
// configured" and backfilled with defaults, so ./actual configure can pick up where an old file
// left off. This also migrates birthDate/retirementAges/planToAge from their original flat
// top-level placement (pre-dating the `dashboard` section below) if there's no `dashboard` object
// yet -- read-compatible with the old shape; the next write always produces the new nested one.
export function loadFireConfig(path: string): LoadedFireConfig {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return { config: EMPTY_FIRE_CONFIG, found: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { accounts?: unknown }).accounts)
  ) {
    throw new Error(`Invalid config in ${path}: expected { "version": 1, "accounts": [...] }`)
  }

  // The pre-`dashboard`-section shape (still what this repo's own config.json used before this
  // change) had these three fields directly at the top level -- read them from there as a fallback
  // when `dashboard` itself isn't present, so upgrading this schema doesn't silently discard a real
  // birth date/retirement ages/plan-to-age already on disk.
  const partial = parsed as Partial<FireConfig> & { version: 1; accounts: FireAccountOverride[] } & Partial<DashboardConfig>

  for (const override of partial.accounts) {
    // Catches a config left over from before a category/tax-treatment value was renamed, not just
    // a hand-typo -- letting either through would silently misbehave downstream (e.g. an unknown
    // category can't be found in FIRE_ACCOUNT_CATEGORIES, breaking the interactive default index)
    // rather than failing loudly here where the problem is obvious.
    if (!FIRE_ACCOUNT_CATEGORIES.includes(override.category)) {
      throw new Error(
        `Invalid config in ${path}: unknown category "${override.category}" for "${override.match}". ` +
          `Valid categories: ${FIRE_ACCOUNT_CATEGORIES.join(", ")}.`,
      )
    }
    if (override.taxTreatment !== undefined && !TAX_TREATMENTS.includes(override.taxTreatment)) {
      throw new Error(
        `Invalid config in ${path}: unknown taxTreatment "${override.taxTreatment}" for "${override.match}". ` +
          `Valid values: ${TAX_TREATMENTS.join(", ")}.`,
      )
    }
    if (override.allocationPreset != null && !MONTE_CARLO_ALLOCATION_PRESETS.includes(override.allocationPreset)) {
      throw new Error(
        `Invalid config in ${path}: unknown allocationPreset "${override.allocationPreset}" for "${override.match}". ` +
          `Valid values: ${MONTE_CARLO_ALLOCATION_PRESETS.join(", ")}.`,
      )
    }
    if (override.ruleOf55SeparationAge != null && (typeof override.ruleOf55SeparationAge !== "number" || override.ruleOf55SeparationAge <= 0)) {
      throw new Error(`Invalid config in ${path}: ruleOf55SeparationAge for "${override.match}" must be a positive number.`)
    }
  }

  // `dashboard` if the file already has the new nested section; otherwise fall back to the old
  // flat top-level fields (see the comment on `partial` above) -- either way, `dashboardSource` is
  // just the un-validated candidate values, validated and defaulted below like every other section.
  const dashboardSource: Partial<DashboardConfig> = partial.dashboard ?? {
    birthDate: partial.birthDate,
    retirementAges: partial.retirementAges,
    planToAge: partial.planToAge,
  }

  if (dashboardSource.retirementAges !== undefined) {
    if (!Array.isArray(dashboardSource.retirementAges) || dashboardSource.retirementAges.some((age) => typeof age !== "number" || age <= 0)) {
      throw new Error(`Invalid config in ${path}: dashboard.retirementAges must be an array of positive numbers.`)
    }
  }
  if (dashboardSource.planToAge !== undefined && (typeof dashboardSource.planToAge !== "number" || dashboardSource.planToAge <= 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.planToAge must be a positive number.`)
  }
  if (partial.crossover?.projectionType !== undefined && !CROSSOVER_PROJECTION_TYPES.includes(partial.crossover.projectionType)) {
    throw new Error(
      `Invalid config in ${path}: unknown crossover.projectionType "${partial.crossover.projectionType}". ` +
        `Valid values: ${CROSSOVER_PROJECTION_TYPES.join(", ")}.`,
    )
  }
  if (
    partial.monteCarlo?.withdrawalStrategy !== undefined &&
    !MONTE_CARLO_WITHDRAWAL_STRATEGIES.includes(partial.monteCarlo.withdrawalStrategy)
  ) {
    throw new Error(
      `Invalid config in ${path}: unknown monteCarlo.withdrawalStrategy "${partial.monteCarlo.withdrawalStrategy}". ` +
        `Valid values: ${MONTE_CARLO_WITHDRAWAL_STRATEGIES.join(", ")}.`,
    )
  }
  if (partial.monteCarlo?.returnModel !== undefined && !MONTE_CARLO_RETURN_MODELS.includes(partial.monteCarlo.returnModel)) {
    throw new Error(
      `Invalid config in ${path}: unknown monteCarlo.returnModel "${partial.monteCarlo.returnModel}". ` +
        `Valid values: ${MONTE_CARLO_RETURN_MODELS.join(", ")}.`,
    )
  }
  if (
    partial.monteCarlo?.withdrawalRule?.type !== undefined &&
    !MONTE_CARLO_WITHDRAWAL_RULE_TYPES.includes(partial.monteCarlo.withdrawalRule.type)
  ) {
    throw new Error(
      `Invalid config in ${path}: unknown monteCarlo.withdrawalRule.type "${partial.monteCarlo.withdrawalRule.type}". ` +
        `Valid values: ${MONTE_CARLO_WITHDRAWAL_RULE_TYPES.join(", ")}.`,
    )
  }
  if (partial.monteCarlo?.taxModel !== undefined && !MONTE_CARLO_TAX_MODELS.includes(partial.monteCarlo.taxModel)) {
    throw new Error(
      `Invalid config in ${path}: unknown monteCarlo.taxModel "${partial.monteCarlo.taxModel}". ` +
        `Valid values: ${MONTE_CARLO_TAX_MODELS.join(", ")}.`,
    )
  }

  const config: FireConfig = {
    version: 1,
    accounts: partial.accounts,
    dashboard: {
      birthDate: dashboardSource.birthDate ?? DEFAULT_DASHBOARD_CONFIG.birthDate,
      retirementAges: dashboardSource.retirementAges ?? DEFAULT_DASHBOARD_CONFIG.retirementAges,
      planToAge: dashboardSource.planToAge ?? DEFAULT_DASHBOARD_CONFIG.planToAge,
    },
    crossover: { ...DEFAULT_CROSSOVER_CONFIG, ...partial.crossover },
    monteCarlo: {
      ...DEFAULT_MONTE_CARLO_CONFIG,
      ...partial.monteCarlo,
      withdrawalRule: { ...DEFAULT_MONTE_CARLO_CONFIG.withdrawalRule, ...partial.monteCarlo?.withdrawalRule },
    },
  }

  return { config, found: true }
}

// Function to write config.json, e.g. after an interactive configuration session (./actual
// configure) has collected a fresh answer for every question.
export function writeFireConfig(path: string, config: FireConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

export interface ClassifiedAccountsResult {
  accounts: ClassifiedAccount[]
  configFound: boolean
}

// Function to load config.json, fetch every open account, and classify them -- the one non-pure
// export in this module (it makes an API call), shared by configure.ts and reports-fire.ts so the
// "load, fetch, classify" sequence isn't duplicated between them.
export async function loadClassifiedAccounts(config: ActualConfig, configPath: string): Promise<ClassifiedAccountsResult> {
  const { config: fireConfig, found: configFound } = loadFireConfig(configPath)
  const accounts = await fetchAllOpenAccounts(config)
  return { accounts: classifyAccounts(accounts, fireConfig), configFound }
}
