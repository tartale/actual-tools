import { readFileSync, writeFileSync } from "node:fs"

import { ageFromBirthDate, fetchAllOpenAccounts, formatUsd } from "./actual-helpers.ts"
import type { Account, ActualConfig } from "./actual-helpers.ts"
import { DEFAULT_IRS_LIMITS_PATH, loadIrsLimits } from "./irs-limits.ts"
import type { IrsLimits } from "./irs-limits.ts"

// Classifies accounts for FIRE reporting: which are retirement/investment/debt/cash, and enough
// detail about each (tax treatment, access age) to populate a Monte Carlo "pot." Pure -- no API
// calls (loadClassifiedAccounts at the bottom is the one exception, shared by app-server.ts).
// Actual's own account API has no type field, so this combines a heuristic guess at the account's
// name with an explicit config file the guess can be overridden by.
//
// This module also owns the FireConfig schema -- the single config.json file the app reads
// defaults from and writes. It covers account classification only: the crossover/Monte Carlo
// widget assumptions Actual itself exposes once a dashboard is imported are no longer stored here
// at all (see fire-dashboard.ts's DEFAULT_CROSSOVER_ASSUMPTIONS/DEFAULT_MONTE_CARLO_ASSUMPTIONS,
// used only the first time a dashboard is generated).

export type FireAccountCategory =
  | "retirement-tax-deferred"
  | "retirement-roth"
  | "hsa"
  | "investment-taxable"
  | "debt"
  | "cash"
  | "other"

export const FIRE_ACCOUNT_CATEGORIES: readonly FireAccountCategory[] = [
  "retirement-tax-deferred",
  "retirement-roth",
  "hsa",
  "investment-taxable",
  "debt",
  "cash",
  "other",
]

export type TaxTreatment = "tax-deferred" | "tax-free" | "taxable" | "none"

export const TAX_TREATMENTS: readonly TaxTreatment[] = ["tax-deferred", "tax-free", "taxable", "none"]

// Mirrors Actual's own MonteCarloAllocationPreset, minus "custom"/"custom-mix". Every account gets
// one of these 5 concrete labels -- purely descriptive of its real stock/bond mix -- and
// separately, optionally, its own customReturnMean/customReturnStdDev override (see
// returnAssumptionsFor in fire-dashboard.ts) for when its real historical return doesn't match the
// preset's own illustrative number (a growth fund and blue chips can both be "100% stocks" with
// very different actual returns). A standalone "custom" preset value existed briefly for this same
// purpose but was redundant once overrides work independently of which preset is selected --
// removed rather than kept as a second way to do the same thing. Actual's own "custom-mix" (a
// stocks/bonds/cash percentage split blended against historical return series) stays unsupported --
// this app has no arbitrary-mix editor, only the fixed labels below plus a numeric override. See
// fire-dashboard.ts for the exact mean/stdDev each preset implies (ALLOCATION_PRESET_RETURNS,
// vendored from Actual's own source).
export type MonteCarloAllocationPreset = "equity-100" | "equity-80" | "equity-60" | "equity-40" | "cash"

export const MONTE_CARLO_ALLOCATION_PRESETS: readonly MonteCarloAllocationPreset[] = [
  "equity-100",
  "equity-80",
  "equity-60",
  "equity-40",
  "cash",
]

// Plain-language description of each preset's stock/bond mix, for display next to the preset name
// in the account editor.
export const MONTE_CARLO_ALLOCATION_PRESET_LABELS: Record<MonteCarloAllocationPreset, string> = {
  "equity-100": "100% stocks",
  "equity-80": "80% stocks / 20% bonds",
  "equity-60": "60% stocks / 40% bonds",
  "equity-40": "40% stocks / 60% bonds",
  cash: "100% cash",
}

// Mirrors Actual's own MonteCarloWithdrawalStrategy/MonteCarloReturnModel (see fire-dashboard.ts's
// MonteCarloCardMeta) -- declared here, one level below fire-dashboard.ts, same as
// MonteCarloAllocationPreset above, since DashboardConfig (this file) needs them for the
// once-for-every-age-comparison simulation settings a person can pin in this app instead of
// Actual's own per-widget UI (see retirementIncomeStreams's sibling, monteCarloSettingsOverride, in
// fire-dashboard.ts). withdrawalRule and taxBands are pinned as whole values rather than
// field-by-field scalars like these (see DashboardConfig.monteCarloWithdrawalRule/
// monteCarloTaxBands below) since each carries its own internal shape -- a withdrawal rule's
// parameters vary by its own type (guardrails, ratcheting, floor/ceiling, boundaries), and tax
// bands are an open-ended list -- rather than a single enum this file's other pinnable fields are.
export type MonteCarloWithdrawalStrategy = "proportional" | "sequential" | "best-performer" | "target-mix"
export const MONTE_CARLO_WITHDRAWAL_STRATEGIES: readonly MonteCarloWithdrawalStrategy[] = ["proportional", "sequential", "best-performer", "target-mix"]

export type MonteCarloReturnModel = "normal" | "historical-bootstrap" | "historical-sequence"
export const MONTE_CARLO_RETURN_MODELS: readonly MonteCarloReturnModel[] = ["normal", "historical-bootstrap", "historical-sequence"]

// The flat/bands choice itself is a single enum, no different from withdrawalStrategy/returnModel,
// so it's just as pinnable as a flat scalar -- taxBands (the "bands" model's own open-ended list of
// thresholds) is the part pinned as a whole value instead (see DashboardConfig.monteCarloTaxBands).
export type MonteCarloTaxModel = "flat" | "bands"
export const MONTE_CARLO_TAX_MODELS: readonly MonteCarloTaxModel[] = ["flat", "bands"]

// Mirrors Actual's own crossover-card projection type (see fire-dashboard.ts's CrossoverCardMeta)
// -- moved here from fire-dashboard.ts, same reasoning as the Monte Carlo enums above: this file's
// DashboardConfig needs it for the crossover assumptions a person can pin instead of opening
// Actual's own crossover config UI (see fire-dashboard.ts's crossoverAssumptionsWithOverrides).
export type CrossoverProjectionType = "hampel" | "median" | "mean"
export const CROSSOVER_PROJECTION_TYPES: readonly CrossoverProjectionType[] = ["hampel", "median", "mean"]

// Moved here from fire-dashboard.ts for the same reason as CrossoverProjectionType above --
// DashboardConfig (this file) needs it to let a person pin a withdrawal rule (see
// fire-dashboard.ts's monteCarloAssumptionsWithOverrides), and fire-accounts.ts cannot import from
// fire-dashboard.ts (the dependency only runs the other direction).
export type MonteCarloWithdrawalRuleType = "none" | "guardrails" | "ratcheting" | "floor-ceiling" | "boundaries"
export const MONTE_CARLO_WITHDRAWAL_RULE_TYPES: readonly MonteCarloWithdrawalRuleType[] = ["none", "guardrails", "ratcheting", "floor-ceiling", "boundaries"]

// Parameters for every rule type are kept side by side (all optional) so switching between rules
// preserves each rule's own settings, matching Actual's own MonteCarloWithdrawalRuleMeta shape.
export interface MonteCarloWithdrawalRuleMeta {
  type: MonteCarloWithdrawalRuleType
  // Guardrails (Guyton-Klinger)
  prosperityTriggerPct?: number
  prosperityIncreasePct?: number
  preservationTriggerPct?: number
  preservationCutPct?: number
  // Ratcheting (Kitces)
  balanceThresholdMultiple?: number
  consecutiveYears?: number
  ratchetIncreasePct?: number
  // Floor & ceiling (Bengen)
  floorPct?: number
  ceilingPct?: number
  // Boundaries
  upperRateThreshold?: number
  upperCutPct?: number
  lowerRateThreshold?: number
  lowerIncreasePct?: number
}

export interface MonteCarloTaxBandMeta {
  id: string
  from?: number
  rate?: number
}

// The IRS contribution-limit pool an account type draws from, if any. Both employer-plan and IRA
// limits are shared across every account of that kind (not per-account) -- see
// resolveMonthlyContributions for how a "max" contribution splits a shared pool. HSA's limit is
// technically shared per tax household too, but self-only vs. family coverage isn't tracked
// per-account here -- see annualContributionLimit's doc comment for that deliberate simplification.
export type ContributionLimitGroup = "employer-plan" | "ira" | "hsa"

// A concrete kind of account, one level more specific than FireAccountCategory -- specific enough
// to know whether Rule of 55 can ever apply (never for an IRA) and which IRS limit, if any,
// governs its contributions. Every downstream FireAccountCategory-keyed consumer (isPortfolioCategory,
// the withdrawal-tax-rate table, ...) is unaffected: `category` is just one more trait each type
// implies, computed once here rather than re-derived at every call site.
export type AccountType =
  | "traditional-401k"
  | "roth-401k"
  | "traditional-ira"
  | "roth-ira"
  | "inherited-ira"
  | "hsa"
  | "brokerage"
  | "savings"
  | "debt"
  | "cash"
  | "other"

// Order shown in the account-type picker.
export const ACCOUNT_TYPES: readonly AccountType[] = [
  "traditional-401k",
  "roth-401k",
  "traditional-ira",
  "roth-ira",
  "inherited-ira",
  "hsa",
  "brokerage",
  "savings",
  "debt",
  "cash",
  "other",
]

export interface AccountTypeTraits {
  category: FireAccountCategory
  taxTreatment: TaxTreatment
  // Age at which withdrawals become unrestricted/penalty-free; null when not applicable. An
  // inherited/beneficiary IRA is null here deliberately, not a gap -- IRC Sec. 72(t)(2)(A)(iv)
  // exempts inherited IRAs from the 10% early-withdrawal penalty at any age, a real, well-
  // established rule this tool asserted incorrectly (a blanket 59) before AccountType existed.
  accessAge: number | null
  // Equity/bond mix for a Monte Carlo "pot"; null for non-portfolio types (debt/cash/other).
  allocationPreset: MonteCarloAllocationPreset | null
  // Whether IRC Sec. 72(t)(2)(A)(v) (separating from an employer at 55+ unlocks that employer's
  // OWN plan penalty-free) can ever apply -- true only for the two employer-plan types. An IRA
  // (traditional, Roth, or inherited) never qualifies, no matter the age.
  ruleOf55Eligible: boolean
  // Which IRS annual limit, if any, this type's contributions draw from.
  limitGroup: ContributionLimitGroup | null
  // Display label -- used both in the type picker and in contributionLimitLines' output.
  label: string
}

// Age at which most US tax-advantaged retirement accounts can be withdrawn from without an early
// withdrawal penalty. Per-type default -- overridable per-account for precision.
const DEFAULT_ACCESS_AGE = 59

export const ACCOUNT_TYPE_TRAITS: Record<AccountType, AccountTypeTraits> = {
  "traditional-401k": {
    category: "retirement-tax-deferred",
    taxTreatment: "tax-deferred",
    accessAge: DEFAULT_ACCESS_AGE,
    allocationPreset: "equity-80",
    ruleOf55Eligible: true,
    limitGroup: "employer-plan",
    label: "Traditional 401(k)/403(b)/457/TSP",
  },
  "roth-401k": {
    category: "retirement-roth",
    taxTreatment: "tax-free",
    accessAge: DEFAULT_ACCESS_AGE,
    allocationPreset: "equity-80",
    ruleOf55Eligible: true,
    limitGroup: "employer-plan",
    label: "Roth 401(k)/403(b)",
  },
  "traditional-ira": {
    category: "retirement-tax-deferred",
    taxTreatment: "tax-deferred",
    accessAge: DEFAULT_ACCESS_AGE,
    allocationPreset: "equity-80",
    ruleOf55Eligible: false,
    limitGroup: "ira",
    label: "Traditional IRA",
  },
  "roth-ira": {
    category: "retirement-roth",
    taxTreatment: "tax-free",
    accessAge: DEFAULT_ACCESS_AGE,
    allocationPreset: "equity-80",
    ruleOf55Eligible: false,
    limitGroup: "ira",
    label: "Roth IRA",
  },
  "inherited-ira": {
    category: "retirement-tax-deferred",
    taxTreatment: "tax-deferred",
    accessAge: null,
    allocationPreset: "equity-80",
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "Inherited/Beneficiary IRA",
  },
  hsa: {
    category: "hsa",
    taxTreatment: "tax-free",
    accessAge: null,
    allocationPreset: "equity-60",
    ruleOf55Eligible: false,
    limitGroup: "hsa",
    label: "HSA",
  },
  brokerage: {
    category: "investment-taxable",
    taxTreatment: "taxable",
    accessAge: null,
    allocationPreset: "equity-80",
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "Taxable brokerage / investment account",
  },
  // A high-yield savings account or money market: interest is taxed as it's earned (same rough
  // "taxable" treatment as a brokerage's withdrawals), but there's no age-based withdrawal
  // restriction at all, and the balance itself doesn't fluctuate with the market -- hence "cash"
  // as the default allocation rather than brokerage's equity-80. Still fully portfolio-eligible:
  // counted in the withdrawal pots and open to a monthly contribution, same as any other taxable
  // account.
  savings: {
    category: "investment-taxable",
    taxTreatment: "taxable",
    accessAge: null,
    allocationPreset: "cash",
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "High-yield savings / money market",
  },
  debt: {
    category: "debt",
    taxTreatment: "none",
    accessAge: null,
    allocationPreset: null,
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "Debt (mortgage/loan/credit card)",
  },
  cash: {
    category: "cash",
    taxTreatment: "none",
    accessAge: null,
    allocationPreset: null,
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "Cash (checking/savings)",
  },
  other: {
    category: "other",
    taxTreatment: "none",
    accessAge: null,
    allocationPreset: null,
    ruleOf55Eligible: false,
    limitGroup: null,
    label: "Other / not applicable",
  },
}

export type ClassificationSource = "override" | "heuristic" | "default"

export interface ClassifiedAccount {
  id: string
  name: string
  offbudget: boolean
  type: AccountType
  category: FireAccountCategory
  taxTreatment: TaxTreatment
  accessAge: number | null
  allocationPreset: MonteCarloAllocationPreset | null
  // The account's own hand-entered expected return/volatility (decimal fractions, e.g. 0.07 for
  // 7%), overriding allocationPreset's own table value -- independently of each other, and
  // independently of which preset is selected, so two "100% stocks" accounts can assume different
  // real returns without either giving up the label. Null means "use the preset's own default"
  // (see returnAssumptionsFor in fire-dashboard.ts).
  customReturnMean: number | null
  customReturnStdDev: number | null
  // Overrides WITHDRAWAL_TAX_RATES[taxTreatment]'s rough, type-wide estimate (fire-dashboard.ts's
  // own doc comment already calls these "deliberately rough, user-owned estimates... you own the
  // number") with a number specific to this account, e.g. because you know your real marginal
  // bracket differs from the flat 22% assumed for every tax-deferred account. Null means "use the
  // type's rough estimate," same as every other optional per-account override.
  customWithdrawalTaxRate: number | null
  source: ClassificationSource
  // A monthly contribution amount in cents, or null if none is configured. Already resolved --
  // a "max" override (see resolveMonthlyContributions) has been turned into a concrete number by
  // the time an account reaches this shape, so every reader of this field is unaffected by the
  // sentinel's existence.
  monthlyContribution: number | null
  // The age this account's owner expects to separate from the employer holding it, or null. Its
  // mere presence asserts "this is a real, currently-held 401(k)/403(b)" -- only ever meaningful
  // when the account's type has ruleOf55Eligible: true. See fire-dashboard.ts's effectiveAccessAge.
  ruleOf55SeparationAge: number | null
  // Employer-match inputs -- see FireAccountOverride's doc comment. Pass-through fields, not
  // resolved to anything here; employerContributionSummary does the actual math once an account's
  // resolved monthlyContribution is known.
  annualSalary: number | null
  employerMatchRate: number | null
  employerMatchCapRate: number | null
  // hsa only; null for every other type (there's no "self/family coverage" concept elsewhere).
  hsaCoverage: "self" | "family" | null
  // debt only; see FireAccountOverride's doc comment and calculateMortgagePayoff.
  mortgageInterestRate: number | null
  mortgageMonthlyPayment: number | null
  mortgageBalanceAsOfDate: string | null
  mortgageBalanceAsOf: number | null
  // roth-ira only -- cumulative contributions ever made (cost basis), in cents. IRC
  // Sec. 408A(d)(4)'s ordering rule lets a Roth IRA's own contributions/conversions be withdrawn
  // tax- and penalty-free at any age, before touching earnings, unlike every other retirement
  // account here (and unlike a Roth 401(k)/403(b), which has no such rule pre-rollover). Null
  // means "not entered" -- the account is still treated as 100% locked until accessAge, same as
  // today. See toBridgeAccounts (fire-analysis.ts) for where this actually splits the account into
  // an always-accessible and a locked portion; deliberately NOT threaded into the Monte Carlo
  // dashboard widget Actual itself simulates -- see toBridgeAccounts's own doc comment for why.
  rothBasis: number | null
  // Where this account's pot sits in the "drain pots in order" (sequential) withdrawal strategy --
  // Actual's own simulation engine drains pots in exactly the order the pots array lists them
  // (monteCarloSimulation.ts's drainOrder), so this is the one thing that array order encodes.
  // Null means "no explicit order set yet"; buildMonteCarloWidget falls back to each account's
  // natural (Actual account list) order for anything left null, so setting this for a handful of
  // accounts and leaving the rest alone still produces a sane, stable order. Meaningless for every
  // other withdrawal strategy (proportional/best-performer/target-mix don't read pot order at
  // all), which is why the UI only exposes drag-to-reorder while "sequential" is selected.
  withdrawalOrder: number | null
}

// One user-supplied override. `match` is an account id OR an exact account name, mirroring how
// -c/--category filters already match "name or ID" elsewhere in this repo (shouldUpdateCategory).
//
// `category` is a LEGACY field, present only on a config.json written before AccountType existed.
// classifyAccounts guesses a `type` for a legacy override using the real account name (see
// guessTypeFromLegacyCategory below) -- `match` is often an account id, not a name, so the guess
// can't happen here in the schema/validation layer, only where a real name is available. The next
// write of a migrated override always includes `type` and drops `category`.
export interface FireAccountOverride {
  match: string
  type?: AccountType
  /** @deprecated legacy field from before AccountType existed; see the doc comment above. */
  category?: FireAccountCategory
  taxTreatment?: TaxTreatment
  accessAge?: number | null
  allocationPreset?: MonteCarloAllocationPreset | null
  // See ClassifiedAccount's doc comment.
  customReturnMean?: number | null
  customReturnStdDev?: number | null
  // See ClassifiedAccount's doc comment.
  customWithdrawalTaxRate?: number | null
  // A sentinel, not a resolved amount -- see resolveMonthlyContributions. Stored as the literal
  // string so it re-resolves correctly as IRS limits change yearly and as the account owner
  // crosses the 50/60-63 age-tier boundaries, rather than going stale the moment it's set.
  monthlyContribution?: number | "max"
  ruleOf55SeparationAge?: number | null
  // Only meaningful for the two employer-plan types (traditional-401k/roth-401k) -- used together
  // to estimate the employer's own contribution against the combined IRC Sec. 415(c) "annual
  // additions" limit (employee + employer together), a separate, much larger ceiling than the
  // elective-deferral limit above. See employerContributionSummary. A simple "match% up to cap% of
  // pay" model -- doesn't represent a tiered formula (e.g. "100% on the first 3%, 50% on the next
  // 2%"), which wasn't asked for and would need more than these two numbers.
  annualSalary?: number
  employerMatchRate?: number
  employerMatchCapRate?: number
  // Only meaningful for hsa -- which of the two IRS limits (see contributionLimitLines) applies to
  // this account. Defaults to "self" when absent, since that's the smaller, safer assumption.
  hsaCoverage?: "self" | "family"
  // Only meaningful for debt -- independent of Actual's own ledger balance for the account (a
  // mortgage servicer's real payoff balance often isn't what a synced/manually-tracked Actual
  // account reflects), so this is its own anchor point: what the balance was, as of when. See
  // calculateMortgagePayoff in fire-analysis.ts for how these four become a payoff date.
  mortgageInterestRate?: number
  mortgageMonthlyPayment?: number
  mortgageBalanceAsOfDate?: string
  mortgageBalanceAsOf?: number
  // See ClassifiedAccount's doc comment -- only meaningful for roth-ira.
  rothBasis?: number | null
  // See ClassifiedAccount's doc comment -- only meaningful for the "sequential" withdrawal strategy.
  withdrawalOrder?: number | null
}

// Which of the three SSA-statement reference ages (the ones the statement itself reports a
// payout for) a person actually plans to claim at.
export type SocialSecurityClaimingAge = 62 | 67 | 70

// The plan-wide inputs the app needs that aren't a per-account fact: your birth date, the
// retirement age(s) to compare, how long the plan should last, and the two guaranteed-income
// sources (pension, Social Security) that reduce how much the portfolio itself needs to fund once
// each starts. Both are optional and independent of each other and of account classification --
// neither is tied to any one Actual account.
export interface DashboardConfig {
  birthDate: string | null
  retirementAges: number[]
  planToAge: number
  // Cents/mo, null until entered. A pension with no start age (or vice versa) isn't applied --
  // see retirementIncomeStreams in fire-dashboard.ts.
  pensionStartAge: number | null
  pensionMonthlyAmount: number | null
  // The three SSA-statement figures are kept independently of which age is actually claimed, so
  // switching the plan (e.g. deciding to wait until 70) doesn't lose the other two numbers.
  socialSecurityClaimingAge: SocialSecurityClaimingAge | null
  socialSecurityMonthlyAt62: number | null
  socialSecurityMonthlyAt67: number | null
  socialSecurityMonthlyAt70: number | null
  // Every Monte Carlo widget this tool generates (one per retirement age being compared) is its
  // own independently-named widget in Actual, so tuning one inside Actual's own UI never reaches
  // its siblings -- comparing retirement ages fairly needs the SAME simulation settings on all of
  // them. Setting any of these here makes it the pinned, always-regenerated value for every
  // widget (see fire-dashboard.ts's mergeMonteCarloMeta pinnedFields), overriding whatever that
  // widget's own live/local settings say; leaving a field null keeps today's behavior (preserved
  // per-widget from Actual). withdrawalRule and taxBands are pinned as whole values below instead
  // of flat scalars here -- see MonteCarloWithdrawalStrategy's doc comment above for why.
  monteCarloWithdrawalStrategy: MonteCarloWithdrawalStrategy | null
  monteCarloReturnModel: MonteCarloReturnModel | null
  monteCarloTaxModel: MonteCarloTaxModel | null
  // Decimal fractions (0.03 = 3%), matching every other rate in this file.
  monteCarloInflationMean: number | null
  monteCarloInflationStdDev: number | null
  // Cents/yr.
  monteCarloMinimumWithdrawal: number | null
  monteCarloSimulationCount: number | null
  // The expense categories Generate/Check use for annual spend (and, for Generate, seed onto the
  // crossover widget) instead of Actual's own crossover-card checklist -- set once here and every
  // simulation (Bridge, Monte Carlo, the Current numbers box) uses it without anyone opening
  // Actual. Null means "not set yet": every non-income, non-hidden category, today's implicit
  // default -- see fire-generate.ts's expenseCategoryIds. Never an empty array (see
  // CrossoverCardMeta's own expenseCategoryIds doc comment for why); the Plan PATCH route and the
  // config loader below both reject one.
  crossoverExpenseCategoryIds: string[] | null
  // The crossover widget's own remaining assumptions a person can pin here instead of opening
  // Actual's own crossover config UI, same "pin it here, it always wins on regenerate" mechanism
  // as the monteCarlo* fields above (see fire-dashboard.ts's crossoverAssumptionsWithOverrides/
  // pinnedCrossoverFields). Unlike the Monte Carlo fields, three of these four (everything but
  // crossoverExpenseAdjustmentFactor) only affect how Actual's own crossover widget renders --
  // this app's own Bridge/Monte Carlo math has no crossover-date concept to feed them into. Decimal
  // fraction (0.04 = 4%), null "not entered" leaves it to Actual/the plain default, same convention
  // as every other rate field here.
  crossoverSafeWithdrawalRate: number | null
  // Null means "auto" to Actual's own widget -- this app's own convention (a not-entered field
  // leaves it alone) happens to coincide with that meaning, so there's no separate "pin auto"
  // state; picking a fixed rate is the only thing pinning this field can add over the default.
  crossoverEstimatedReturn: number | null
  crossoverProjectionType: CrossoverProjectionType | null
  // Actual calls this "Target Income (% of expenses)." The one field here that also feeds this
  // app's own local-selection spend calculation (see fire-generate.ts's spendFromLocalSelection),
  // not just the exported widget -- see CrossoverAssumptions.expenseAdjustmentFactor.
  crossoverExpenseAdjustmentFactor: number | null
  // The two Monte Carlo fields the doc comment on MonteCarloWithdrawalStrategy above calls out as
  // deliberately NOT exposed as flat pinnable scalars -- each carries its own internal shape
  // (a withdrawal rule's parameters vary by its own type; tax bands are an open-ended list), so
  // each is pinned as one whole value rather than field-by-field like the monteCarlo* scalars
  // above. Same "null means leave it to Actual/the widget's own live value" convention; pinning
  // `{ type: "none" }` is how a person forces every widget back to no rule, distinct from not
  // pinning at all. An empty taxBands array is a valid pinned value (mid-edit, or "no bands yet"),
  // unlike crossoverExpenseCategoryIds -- Actual's own tax computation just falls back sensibly.
  monteCarloWithdrawalRule: MonteCarloWithdrawalRuleMeta | null
  monteCarloTaxBands: MonteCarloTaxBandMeta[] | null
}

export interface FireConfig {
  version: 1
  accounts: FireAccountOverride[]
  dashboard: DashboardConfig
}

// Conservative default planning horizon: assume the money needs to last to this age rather than
// asking the user to estimate their own lifespan.
export const DEFAULT_PLAN_TO_AGE = 100

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  birthDate: null,
  retirementAges: [],
  planToAge: DEFAULT_PLAN_TO_AGE,
  pensionStartAge: null,
  pensionMonthlyAmount: null,
  socialSecurityClaimingAge: null,
  socialSecurityMonthlyAt62: null,
  socialSecurityMonthlyAt67: null,
  socialSecurityMonthlyAt70: null,
  monteCarloWithdrawalStrategy: null,
  monteCarloReturnModel: null,
  monteCarloTaxModel: null,
  monteCarloInflationMean: null,
  monteCarloInflationStdDev: null,
  monteCarloMinimumWithdrawal: null,
  monteCarloSimulationCount: null,
  crossoverExpenseCategoryIds: null,
  crossoverSafeWithdrawalRate: null,
  crossoverEstimatedReturn: null,
  crossoverProjectionType: null,
  crossoverExpenseAdjustmentFactor: null,
  monteCarloWithdrawalRule: null,
  monteCarloTaxBands: null,
}

export const EMPTY_FIRE_CONFIG: FireConfig = {
  version: 1,
  accounts: [],
  dashboard: DEFAULT_DASHBOARD_CONFIG,
}

export const DEFAULT_CONFIG_PATH = "config.json"

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

// Shared name patterns -- used both by the fresh-account heuristic (classifyByHeuristic) and by
// the legacy category->type migration (guessTypeFromLegacyCategory), which both need to tell a
// 401(k)-family plan apart from an IRA, and an inherited IRA apart from either.
const HSA_PATTERN = /\bhsa\b|\bhealth savings\b/i
const INHERITED_IRA_PATTERN = /\bbda\b|\bbeneficiary\b|\binherited\b/i
const ROTH_PATTERN = /\broth\b/i
const EMPLOYER_PLAN_PATTERN = /\b401\s?k\b|\b403\s?b\b|\b457\b|\btsp\b|\bpension\b/i
const IRA_PATTERN = /\bira\b/i
const DEBT_PATTERN = /\bmortgage\b|\bloan\b|\bcredit card\b|\bline of credit\b|\bheloc\b/i
// Checked before the broader BROKERAGE_PATTERN -- "high-yield savings" and "money market" are
// otherwise generic enough to slip past it. Deliberately does NOT match a bare "savings" (an
// ordinary low-yield savings account is more often meant as a cash buffer, not part of the
// investable portfolio), only the specific terms that name an investment-like cash vehicle.
const SAVINGS_PATTERN = /\bmoney market\b|\bhysa\b|\bhigh.?yield savings\b/i
const BROKERAGE_PATTERN = /\bbrokerage\b|\binvestment\b|\btaxable\b/i

// Function to classify a single account by name only. Returns null when nothing matches, so the
// caller can fall back to a documented default rather than a silent guess. Checked in an order
// that resolves overlaps correctly: HSA and "inherited/BDA" are checked before the generic IRA
// pattern (an inherited IRA's name usually also contains "IRA"), and Roth is combined with the
// employer-plan/IRA checks rather than a plain ordered list, since "Roth 401k" and "Roth IRA" need
// to land on two different AccountTypes, not one shared "roth" category.
export function classifyByHeuristic(name: string): AccountType | null {
  if (HSA_PATTERN.test(name)) {
    return "hsa"
  }
  if (INHERITED_IRA_PATTERN.test(name)) {
    return "inherited-ira"
  }
  const isRoth = ROTH_PATTERN.test(name)
  const isEmployerPlan = EMPLOYER_PLAN_PATTERN.test(name)
  const isIra = IRA_PATTERN.test(name)
  if (isRoth) {
    return isIra && !isEmployerPlan ? "roth-ira" : "roth-401k"
  }
  if (isEmployerPlan) {
    return "traditional-401k"
  }
  if (isIra) {
    return "traditional-ira"
  }
  if (DEBT_PATTERN.test(name)) {
    return "debt"
  }
  if (SAVINGS_PATTERN.test(name)) {
    return "savings"
  }
  if (BROKERAGE_PATTERN.test(name)) {
    return "brokerage"
  }
  return null
}

// Function to guess an AccountType for a legacy override (category only, no type) using the real
// account name -- unlike classifyByHeuristic, this always returns something (never null), since a
// legacy override already has a definite category to fall back to; the name only sharpens which
// type within that category. Called from classifyAccounts, not loadFireConfig, since only
// classifyAccounts has the account's actual name -- `match` is frequently an id instead.
function guessTypeFromLegacyCategory(category: FireAccountCategory, name: string): AccountType {
  switch (category) {
    case "retirement-tax-deferred":
      if (INHERITED_IRA_PATTERN.test(name)) {
        return "inherited-ira"
      }
      return IRA_PATTERN.test(name) && !EMPLOYER_PLAN_PATTERN.test(name) ? "traditional-ira" : "traditional-401k"
    case "retirement-roth":
      return IRA_PATTERN.test(name) && !EMPLOYER_PLAN_PATTERN.test(name) ? "roth-ira" : "roth-401k"
    case "hsa":
      return "hsa"
    case "investment-taxable":
      return SAVINGS_PATTERN.test(name) ? "savings" : "brokerage"
    case "debt":
      return "debt"
    case "cash":
      return "cash"
    case "other":
      return "other"
  }
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

// Function to get one type's core classification fields, for spreading into a ClassifiedAccount --
// deliberately narrower than AccountTypeTraits (drops label/ruleOf55Eligible/limitGroup, which
// aren't ClassifiedAccount fields).
function classifiedFieldsForType(type: AccountType): Pick<AccountTypeTraits, "category" | "taxTreatment" | "accessAge" | "allocationPreset"> {
  const { category, taxTreatment, accessAge, allocationPreset } = ACCOUNT_TYPE_TRAITS[type]
  return { category, taxTreatment, accessAge, allocationPreset }
}

// Function to resolve an override's effective type: its own `type` if set, else a guess from its
// legacy `category` plus the real account name (see guessTypeFromLegacyCategory).
function resolveOverrideType(override: FireAccountOverride, accountName: string): AccountType {
  if (override.type) {
    return override.type
  }
  if (override.category) {
    return guessTypeFromLegacyCategory(override.category, accountName)
  }
  return "other"
}

// Function to compute one limit group's age-tiered annual contribution limit, in cents. Employer-
// plan and IRA both follow the real IRS tiers (employer-plan: standard, +catchUp50 at 50-59 or
// 64+, +catchUp60to63 at exactly 60-63; IRA: standard, +catchUp50 at 50+). HSA is deliberately
// simplified to the self-only limit -- family-vs-self-only coverage isn't tracked per account here
// (nothing asked for it), so a family-coverage HSA should use an explicit monthly number rather
// than "max", which will undercount it.
export function annualContributionLimit(
  limitGroup: ContributionLimitGroup,
  age: number,
  irsLimits: IrsLimits,
  hsaCoverage: "self" | "family" = "self",
): number {
  if (limitGroup === "employer-plan") {
    if (age >= 60 && age <= 63) {
      return irsLimits.employerPlan.standard + irsLimits.employerPlan.catchUp60to63
    }
    return age >= 50 ? irsLimits.employerPlan.standard + irsLimits.employerPlan.catchUp50 : irsLimits.employerPlan.standard
  }
  if (limitGroup === "ira") {
    return age >= 50 ? irsLimits.ira.standard + irsLimits.ira.catchUp50 : irsLimits.ira.standard
  }
  const hsaBase = hsaCoverage === "family" ? irsLimits.hsa.family : irsLimits.hsa.selfOnly
  return age >= 55 ? hsaBase + irsLimits.hsa.catchUp55 : hsaBase
}

// Function to compute the combined IRC Sec. 415(c) "annual additions" limit -- employee elective
// deferrals PLUS employer contributions together, a separate and much larger ceiling than
// annualContributionLimit("employer-plan", ...) above. The age-50/60-63 catch-up amounts are the
// same dollar figures as the elective-deferral catch-ups (confirmed via a real web search, not
// assumed) and apply on top of this limit the same way.
export function combinedAnnualAdditionsLimit(age: number, irsLimits: IrsLimits): number {
  const { annualAdditions, catchUp50, catchUp60to63 } = irsLimits.employerPlan
  if (age >= 60 && age <= 63) {
    return annualAdditions + catchUp60to63
  }
  return age >= 50 ? annualAdditions + catchUp50 : annualAdditions
}

// Function to estimate an employer's own 401(k)/403(b) contribution from a flat "match% up to
// cap% of pay" formula -- e.g. employerMatchRate 1.0 (100%) and employerMatchCapRate 0.04 (4%)
// means the employer matches dollar-for-dollar up to 4% of salary. Deliberately doesn't represent
// a tiered formula (e.g. "100% on the first 3%, 50% on the next 2%"), which needs more than two
// numbers and wasn't asked for. Returns 0, not null, when any input is missing -- this is meant to
// be added directly to an employee contribution, and "unknown" and "zero" should behave the same
// way for that purpose.
export function computeEmployerContribution(
  annualSalary: number | null,
  employerMatchRate: number | null,
  employerMatchCapRate: number | null,
  employeeAnnualContribution: number,
): number {
  if (annualSalary == null || employerMatchRate == null || employerMatchCapRate == null) {
    return 0
  }
  const matchedBase = Math.min(employeeAnnualContribution, Math.round(annualSalary * employerMatchCapRate))
  return Math.round(matchedBase * employerMatchRate)
}

export interface EmployerContributionSummary {
  employerAnnualContribution: number
  combinedAnnual: number
  combinedLimit: number
  exceedsLimit: boolean
}

// Function to summarize an employer-plan account's combined-limit standing, once salary and match
// info are provided -- null when they aren't (nothing to combine), so a caller can skip showing
// anything rather than displaying a summary built from assumed zeros.
export function employerContributionSummary(
  account: Pick<ClassifiedAccount, "annualSalary" | "employerMatchRate" | "employerMatchCapRate" | "monthlyContribution">,
  age: number,
  irsLimits: IrsLimits,
): EmployerContributionSummary | null {
  if (account.annualSalary == null || account.employerMatchRate == null || account.employerMatchCapRate == null) {
    return null
  }
  const employeeAnnualContribution = (account.monthlyContribution ?? 0) * 12
  const employerAnnualContribution = computeEmployerContribution(
    account.annualSalary,
    account.employerMatchRate,
    account.employerMatchCapRate,
    employeeAnnualContribution,
  )
  const combinedAnnual = employeeAnnualContribution + employerAnnualContribution
  const combinedLimit = combinedAnnualAdditionsLimit(age, irsLimits)
  return { employerAnnualContribution, combinedAnnual, combinedLimit, exceedsLimit: combinedAnnual > combinedLimit }
}

// Function to resolve every account's monthlyContribution, turning the "max" sentinel into a
// concrete cents/month figure. Within each limit group, every EXPLICIT (non-"max") contribution is
// summed and subtracted from that group's annual limit first; the one account (if any) left as
// "max" gets whatever remains, divided by 12. If more than one account in the same group is left
// as "max" -- the UI is meant to prevent this (at most one "max" per group) -- each independently
// gets the full remainder, which double-counts; this is a deliberately unhandled edge case rather
// than added complexity for a state the UI already disallows.
// Missing birthDate/irsLimits resolves every "max" to nothing (absent from the returned map) rather
// than throwing -- IRS limits are advisory context everywhere else in this repo, never required.
export function resolveMonthlyContributions(
  overrides: readonly FireAccountOverride[],
  birthDate: string | null,
  irsLimits: IrsLimits | null,
  // Real accounts, so a LEGACY (category-only) override's type can be guessed from its actual
  // name -- `override.match` is frequently an account id, not a name (see resolveOverrideType's
  // doc comment), and guessing straight from an id-shaped `match` silently mis-groups a legacy
  // override into the wrong limit group (e.g. a legacy Roth IRA guessed as roth-401k, landing in
  // "employer-plan" instead of "ira"). Optional and defaulting to empty only so callers that
  // already know every override carries a real `type` (no legacy guessing needed) aren't forced
  // to plumb the account list through for nothing.
  accounts: readonly Pick<Account, "id" | "name">[] = [],
): Map<string, number> {
  const resolved = new Map<string, number>()
  const claimedAnnualByGroup = new Map<ContributionLimitGroup, number>()
  const nameForOverride = (override: FireAccountOverride): string =>
    accounts.find((account) => account.id === override.match || account.name === override.match)?.name ?? override.match

  for (const override of overrides) {
    if (typeof override.monthlyContribution === "number") {
      resolved.set(override.match, override.monthlyContribution)
      const limitGroup = ACCOUNT_TYPE_TRAITS[resolveOverrideType(override, nameForOverride(override))].limitGroup
      if (limitGroup) {
        claimedAnnualByGroup.set(limitGroup, (claimedAnnualByGroup.get(limitGroup) ?? 0) + override.monthlyContribution * 12)
      }
    }
  }

  if (birthDate === null || irsLimits === null) {
    return resolved
  }

  const age = ageFromBirthDate(birthDate)
  for (const override of overrides) {
    if (override.monthlyContribution !== "max") {
      continue
    }
    const limitGroup = ACCOUNT_TYPE_TRAITS[resolveOverrideType(override, nameForOverride(override))].limitGroup
    if (!limitGroup) {
      continue
    }
    const annualLimit = annualContributionLimit(limitGroup, age, irsLimits, override.hsaCoverage ?? "self")
    const alreadyClaimed = claimedAnnualByGroup.get(limitGroup) ?? 0
    resolved.set(override.match, Math.round(Math.max(0, annualLimit - alreadyClaimed) / 12))
  }

  return resolved
}

// Function to describe an account type's IRS contribution limit(s) as ready-to-display lines, one
// per age tier, e.g. ["Roth IRA: $7500.00/yr [$625.00/mo]", "Roth IRA age 50+: $8600.00/yr
// [$716.67/mo]"]. Empty for a type with no limitGroup (debt/cash/other/inherited-ira -- an
// inherited IRA can't be contributed to at all) or when irsLimits isn't available.
export function contributionLimitLines(type: AccountType, irsLimits: IrsLimits | null, hsaCoverage: "self" | "family" = "self"): string[] {
  const { limitGroup, label } = ACCOUNT_TYPE_TRAITS[type]
  if (limitGroup === null || irsLimits === null) {
    return []
  }
  const line = (tierLabel: string, annualCents: number): string =>
    `${tierLabel}: ${formatUsd(annualCents)}/yr [${formatUsd(Math.round(annualCents / 12))}/mo]`

  if (limitGroup === "employer-plan") {
    const { standard, catchUp50, catchUp60to63 } = irsLimits.employerPlan
    return [
      line(label, standard),
      line(`${label} age 50-59, 64+`, standard + catchUp50),
      line(`${label} age 60-63`, standard + catchUp60to63),
    ]
  }
  if (limitGroup === "ira") {
    const { standard, catchUp50 } = irsLimits.ira
    return [line(label, standard), line(`${label} age 50+`, standard + catchUp50)]
  }
  // hsa -- shows whichever coverage tier is actually selected for this account, not both, matching
  // the "one limit that actually applies" pattern used for every other type above.
  const base = hsaCoverage === "family" ? irsLimits.hsa.family : irsLimits.hsa.selfOnly
  const coverageLabel = hsaCoverage === "family" ? "family" : "self-only"
  return [line(`${label} (${coverageLabel})`, base), line(`${label} (${coverageLabel}) age 55+`, base + irsLimits.hsa.catchUp55)]
}

// Function to classify every account: override > heuristic > safe default ("other"). "other" --
// not "cash" -- is the fallback, since a name the heuristic can't recognize might not be cash at
// all; "cash" itself is only ever chosen explicitly. The "default" source is meant to be visibly
// flagged by callers as needing review -- it is a safe fallback, not a confident classification.
// birthDate/irsLimits are only used to resolve a "max" monthlyContribution (see
// resolveMonthlyContributions) -- both default to null, so a caller that doesn't care about "max"
// (most tests) can omit them.
export function classifyAccounts(
  accounts: readonly Pick<Account, "id" | "name" | "offbudget">[],
  config: Pick<FireConfig, "accounts">,
  birthDate: string | null = null,
  irsLimits: IrsLimits | null = null,
): ClassifiedAccount[] {
  const resolvedContributions = resolveMonthlyContributions(config.accounts, birthDate, irsLimits, accounts)

  return accounts.map((account) => {
    const identity = { id: account.id, name: account.name, offbudget: account.offbudget }
    const override = findOverride(account, config)
    if (override) {
      const type = resolveOverrideType(override, account.name)
      const defaults = classifiedFieldsForType(type)
      // A legacy (category-only) override always had taxTreatment/accessAge written out
      // explicitly by the old category-based configure -- every account got these two fields
      // regardless of whether the person customized anything, so they're the OLD category's
      // defaults pinned to disk, not a deliberate per-account override. Trusting them here would
      // silently defeat the whole point of a more specific type for exactly the accounts that need
      // it most (e.g. an inherited IRA guessed from a legacy "retirement-tax-deferred" override
      // would otherwise stay stuck at the old category's accessAge: 59 forever, instead of the
      // correct null). allocationPreset/monthlyContribution/ruleOf55SeparationAge were always real,
      // individually-asked answers, so those are still honored from a legacy override.
      // Once an override carries `type` (this migration's own next write, or a fresh account),
      // taxTreatment/accessAge become legitimate per-account overrides again.
      const isLegacy = override.type === undefined
      return {
        ...identity,
        type,
        category: defaults.category,
        taxTreatment: isLegacy ? defaults.taxTreatment : (override.taxTreatment ?? defaults.taxTreatment),
        accessAge: isLegacy ? defaults.accessAge : (override.accessAge ?? defaults.accessAge),
        allocationPreset: override.allocationPreset ?? defaults.allocationPreset,
        customReturnMean: override.customReturnMean ?? null,
        customReturnStdDev: override.customReturnStdDev ?? null,
        customWithdrawalTaxRate: override.customWithdrawalTaxRate ?? null,
        monthlyContribution: resolvedContributions.get(override.match) ?? null,
        ruleOf55SeparationAge: override.ruleOf55SeparationAge ?? null,
        annualSalary: override.annualSalary ?? null,
        employerMatchRate: override.employerMatchRate ?? null,
        employerMatchCapRate: override.employerMatchCapRate ?? null,
        hsaCoverage: type === "hsa" ? (override.hsaCoverage ?? "self") : null,
        mortgageInterestRate: override.mortgageInterestRate ?? null,
        mortgageMonthlyPayment: override.mortgageMonthlyPayment ?? null,
        mortgageBalanceAsOfDate: override.mortgageBalanceAsOfDate ?? null,
        mortgageBalanceAsOf: override.mortgageBalanceAsOf ?? null,
        rothBasis: override.rothBasis ?? null,
        withdrawalOrder: override.withdrawalOrder ?? null,
        source: "override" as const,
      }
    }
    const heuristicType = classifyByHeuristic(account.name)
    if (heuristicType) {
      return {
        ...identity,
        type: heuristicType,
        ...classifiedFieldsForType(heuristicType),
        customReturnMean: null,
        customReturnStdDev: null,
        customWithdrawalTaxRate: null,
        monthlyContribution: null,
        ruleOf55SeparationAge: null,
        annualSalary: null,
        employerMatchRate: null,
        employerMatchCapRate: null,
        hsaCoverage: heuristicType === "hsa" ? "self" : null,
        mortgageInterestRate: null,
        mortgageMonthlyPayment: null,
        mortgageBalanceAsOfDate: null,
        mortgageBalanceAsOf: null,
        rothBasis: null,
        withdrawalOrder: null,
        source: "heuristic" as const,
      }
    }
    return {
      ...identity,
      type: "other" as const,
      ...classifiedFieldsForType("other"),
      customReturnMean: null,
      customReturnStdDev: null,
      customWithdrawalTaxRate: null,
      monthlyContribution: null,
      ruleOf55SeparationAge: null,
      annualSalary: null,
      employerMatchRate: null,
      employerMatchCapRate: null,
      hsaCoverage: null,
      mortgageInterestRate: null,
      mortgageMonthlyPayment: null,
      mortgageBalanceAsOfDate: null,
      mortgageBalanceAsOf: null,
      rothBasis: null,
      withdrawalOrder: null,
      source: "default" as const,
    }
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
// this schema grew a `dashboard` section, or before AccountType existed) is NOT an error -- see the
// migration notes on FireAccountOverride/DashboardConfig above; read-compatible with both older
// shapes, the next write always produces the current one.
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

  // The pre-`dashboard`-section shape had birthDate/retirementAges/planToAge directly at the top
  // level -- read them from there as a fallback when `dashboard` itself isn't present.
  const partial = parsed as Partial<FireConfig> & { version: 1; accounts: FireAccountOverride[] } & Partial<DashboardConfig>

  for (const override of partial.accounts) {
    if (override.type !== undefined) {
      if (!ACCOUNT_TYPES.includes(override.type)) {
        throw new Error(
          `Invalid config in ${path}: unknown type "${override.type}" for "${override.match}". Valid types: ${ACCOUNT_TYPES.join(", ")}.`,
        )
      }
    } else if (override.category !== undefined) {
      if (!FIRE_ACCOUNT_CATEGORIES.includes(override.category)) {
        throw new Error(
          `Invalid config in ${path}: unknown category "${override.category}" for "${override.match}". ` +
            `Valid categories: ${FIRE_ACCOUNT_CATEGORIES.join(", ")}.`,
        )
      }
    } else {
      throw new Error(`Invalid config in ${path}: "${override.match}" has neither type nor category.`)
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
    if (override.customReturnMean != null && typeof override.customReturnMean !== "number") {
      throw new Error(`Invalid config in ${path}: customReturnMean for "${override.match}" must be a number.`)
    }
    if (override.customReturnStdDev != null && (typeof override.customReturnStdDev !== "number" || override.customReturnStdDev < 0)) {
      throw new Error(`Invalid config in ${path}: customReturnStdDev for "${override.match}" must be a non-negative number.`)
    }
    if (override.rothBasis != null && (typeof override.rothBasis !== "number" || override.rothBasis < 0)) {
      throw new Error(`Invalid config in ${path}: rothBasis for "${override.match}" must be a non-negative number.`)
    }
    if (override.customWithdrawalTaxRate != null && (typeof override.customWithdrawalTaxRate !== "number" || override.customWithdrawalTaxRate < 0)) {
      throw new Error(`Invalid config in ${path}: customWithdrawalTaxRate for "${override.match}" must be a non-negative number.`)
    }
    if (
      override.monthlyContribution !== undefined &&
      override.monthlyContribution !== "max" &&
      (typeof override.monthlyContribution !== "number" || override.monthlyContribution <= 0)
    ) {
      throw new Error(`Invalid config in ${path}: monthlyContribution for "${override.match}" must be a positive number or "max".`)
    }
    if (override.ruleOf55SeparationAge != null && (typeof override.ruleOf55SeparationAge !== "number" || override.ruleOf55SeparationAge <= 0)) {
      throw new Error(`Invalid config in ${path}: ruleOf55SeparationAge for "${override.match}" must be a positive number.`)
    }
    if (override.withdrawalOrder != null && (typeof override.withdrawalOrder !== "number" || !Number.isInteger(override.withdrawalOrder) || override.withdrawalOrder < 0)) {
      throw new Error(`Invalid config in ${path}: withdrawalOrder for "${override.match}" must be a non-negative integer.`)
    }
  }

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
  if (dashboardSource.pensionStartAge != null && (typeof dashboardSource.pensionStartAge !== "number" || dashboardSource.pensionStartAge <= 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.pensionStartAge must be a positive number.`)
  }
  if (dashboardSource.pensionMonthlyAmount != null && (typeof dashboardSource.pensionMonthlyAmount !== "number" || dashboardSource.pensionMonthlyAmount <= 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.pensionMonthlyAmount must be a positive number.`)
  }
  if (dashboardSource.socialSecurityClaimingAge != null && ![62, 67, 70].includes(dashboardSource.socialSecurityClaimingAge)) {
    throw new Error(`Invalid config in ${path}: dashboard.socialSecurityClaimingAge must be 62, 67, or 70.`)
  }
  for (const field of ["socialSecurityMonthlyAt62", "socialSecurityMonthlyAt67", "socialSecurityMonthlyAt70"] as const) {
    const value = dashboardSource[field]
    if (value != null && (typeof value !== "number" || value <= 0)) {
      throw new Error(`Invalid config in ${path}: dashboard.${field} must be a positive number.`)
    }
  }
  if (dashboardSource.monteCarloWithdrawalStrategy != null && !MONTE_CARLO_WITHDRAWAL_STRATEGIES.includes(dashboardSource.monteCarloWithdrawalStrategy)) {
    throw new Error(`Invalid config in ${path}: dashboard.monteCarloWithdrawalStrategy must be one of ${MONTE_CARLO_WITHDRAWAL_STRATEGIES.join(", ")}, or null.`)
  }
  if (dashboardSource.monteCarloReturnModel != null && !MONTE_CARLO_RETURN_MODELS.includes(dashboardSource.monteCarloReturnModel)) {
    throw new Error(`Invalid config in ${path}: dashboard.monteCarloReturnModel must be one of ${MONTE_CARLO_RETURN_MODELS.join(", ")}, or null.`)
  }
  if (dashboardSource.monteCarloTaxModel != null && !MONTE_CARLO_TAX_MODELS.includes(dashboardSource.monteCarloTaxModel)) {
    throw new Error(`Invalid config in ${path}: dashboard.monteCarloTaxModel must be one of ${MONTE_CARLO_TAX_MODELS.join(", ")}, or null.`)
  }
  for (const field of ["monteCarloInflationMean", "monteCarloInflationStdDev"] as const) {
    const value = dashboardSource[field]
    if (value != null && (typeof value !== "number" || value < 0)) {
      throw new Error(`Invalid config in ${path}: dashboard.${field} must be a non-negative number.`)
    }
  }
  if (dashboardSource.monteCarloMinimumWithdrawal != null && (typeof dashboardSource.monteCarloMinimumWithdrawal !== "number" || dashboardSource.monteCarloMinimumWithdrawal < 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.monteCarloMinimumWithdrawal must be a non-negative number.`)
  }
  if (dashboardSource.monteCarloSimulationCount != null && (typeof dashboardSource.monteCarloSimulationCount !== "number" || dashboardSource.monteCarloSimulationCount <= 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.monteCarloSimulationCount must be a positive number.`)
  }
  if (
    dashboardSource.crossoverExpenseCategoryIds != null &&
    (!Array.isArray(dashboardSource.crossoverExpenseCategoryIds) ||
      dashboardSource.crossoverExpenseCategoryIds.length === 0 ||
      dashboardSource.crossoverExpenseCategoryIds.some((id) => typeof id !== "string"))
  ) {
    throw new Error(`Invalid config in ${path}: dashboard.crossoverExpenseCategoryIds must be a non-empty array of category id strings, or null.`)
  }
  if (dashboardSource.crossoverSafeWithdrawalRate != null && (typeof dashboardSource.crossoverSafeWithdrawalRate !== "number" || dashboardSource.crossoverSafeWithdrawalRate <= 0)) {
    throw new Error(`Invalid config in ${path}: dashboard.crossoverSafeWithdrawalRate must be a positive number.`)
  }
  if (dashboardSource.crossoverEstimatedReturn != null && typeof dashboardSource.crossoverEstimatedReturn !== "number") {
    throw new Error(`Invalid config in ${path}: dashboard.crossoverEstimatedReturn must be a number.`)
  }
  if (dashboardSource.crossoverProjectionType != null && !CROSSOVER_PROJECTION_TYPES.includes(dashboardSource.crossoverProjectionType)) {
    throw new Error(`Invalid config in ${path}: dashboard.crossoverProjectionType must be one of ${CROSSOVER_PROJECTION_TYPES.join(", ")}, or null.`)
  }
  if (
    dashboardSource.crossoverExpenseAdjustmentFactor != null &&
    (typeof dashboardSource.crossoverExpenseAdjustmentFactor !== "number" || dashboardSource.crossoverExpenseAdjustmentFactor <= 0)
  ) {
    throw new Error(`Invalid config in ${path}: dashboard.crossoverExpenseAdjustmentFactor must be a positive number.`)
  }
  if (dashboardSource.monteCarloWithdrawalRule != null) {
    const rule = dashboardSource.monteCarloWithdrawalRule
    if (typeof rule !== "object" || Array.isArray(rule) || !MONTE_CARLO_WITHDRAWAL_RULE_TYPES.includes(rule.type)) {
      throw new Error(`Invalid config in ${path}: dashboard.monteCarloWithdrawalRule.type must be one of ${MONTE_CARLO_WITHDRAWAL_RULE_TYPES.join(", ")}.`)
    }
    for (const [key, value] of Object.entries(rule)) {
      if (key !== "type" && typeof value !== "number") {
        throw new Error(`Invalid config in ${path}: dashboard.monteCarloWithdrawalRule.${key} must be a number.`)
      }
    }
  }
  if (dashboardSource.monteCarloTaxBands != null) {
    if (!Array.isArray(dashboardSource.monteCarloTaxBands)) {
      throw new Error(`Invalid config in ${path}: dashboard.monteCarloTaxBands must be an array, or null.`)
    }
    for (const band of dashboardSource.monteCarloTaxBands) {
      if (
        typeof band !== "object" ||
        band === null ||
        typeof band.id !== "string" ||
        (band.from !== undefined && typeof band.from !== "number") ||
        (band.rate !== undefined && typeof band.rate !== "number")
      ) {
        throw new Error(`Invalid config in ${path}: each dashboard.monteCarloTaxBands entry must have a string id and numeric from/rate.`)
      }
    }
  }

  const config: FireConfig = {
    version: 1,
    accounts: partial.accounts,
    dashboard: {
      birthDate: dashboardSource.birthDate ?? DEFAULT_DASHBOARD_CONFIG.birthDate,
      retirementAges: dashboardSource.retirementAges ?? DEFAULT_DASHBOARD_CONFIG.retirementAges,
      planToAge: dashboardSource.planToAge ?? DEFAULT_DASHBOARD_CONFIG.planToAge,
      pensionStartAge: dashboardSource.pensionStartAge ?? DEFAULT_DASHBOARD_CONFIG.pensionStartAge,
      pensionMonthlyAmount: dashboardSource.pensionMonthlyAmount ?? DEFAULT_DASHBOARD_CONFIG.pensionMonthlyAmount,
      socialSecurityClaimingAge: dashboardSource.socialSecurityClaimingAge ?? DEFAULT_DASHBOARD_CONFIG.socialSecurityClaimingAge,
      socialSecurityMonthlyAt62: dashboardSource.socialSecurityMonthlyAt62 ?? DEFAULT_DASHBOARD_CONFIG.socialSecurityMonthlyAt62,
      socialSecurityMonthlyAt67: dashboardSource.socialSecurityMonthlyAt67 ?? DEFAULT_DASHBOARD_CONFIG.socialSecurityMonthlyAt67,
      socialSecurityMonthlyAt70: dashboardSource.socialSecurityMonthlyAt70 ?? DEFAULT_DASHBOARD_CONFIG.socialSecurityMonthlyAt70,
      monteCarloWithdrawalStrategy: dashboardSource.monteCarloWithdrawalStrategy ?? DEFAULT_DASHBOARD_CONFIG.monteCarloWithdrawalStrategy,
      monteCarloReturnModel: dashboardSource.monteCarloReturnModel ?? DEFAULT_DASHBOARD_CONFIG.monteCarloReturnModel,
      monteCarloTaxModel: dashboardSource.monteCarloTaxModel ?? DEFAULT_DASHBOARD_CONFIG.monteCarloTaxModel,
      monteCarloInflationMean: dashboardSource.monteCarloInflationMean ?? DEFAULT_DASHBOARD_CONFIG.monteCarloInflationMean,
      monteCarloInflationStdDev: dashboardSource.monteCarloInflationStdDev ?? DEFAULT_DASHBOARD_CONFIG.monteCarloInflationStdDev,
      monteCarloMinimumWithdrawal: dashboardSource.monteCarloMinimumWithdrawal ?? DEFAULT_DASHBOARD_CONFIG.monteCarloMinimumWithdrawal,
      monteCarloSimulationCount: dashboardSource.monteCarloSimulationCount ?? DEFAULT_DASHBOARD_CONFIG.monteCarloSimulationCount,
      crossoverExpenseCategoryIds: dashboardSource.crossoverExpenseCategoryIds ?? DEFAULT_DASHBOARD_CONFIG.crossoverExpenseCategoryIds,
      crossoverSafeWithdrawalRate: dashboardSource.crossoverSafeWithdrawalRate ?? DEFAULT_DASHBOARD_CONFIG.crossoverSafeWithdrawalRate,
      crossoverEstimatedReturn: dashboardSource.crossoverEstimatedReturn ?? DEFAULT_DASHBOARD_CONFIG.crossoverEstimatedReturn,
      crossoverProjectionType: dashboardSource.crossoverProjectionType ?? DEFAULT_DASHBOARD_CONFIG.crossoverProjectionType,
      crossoverExpenseAdjustmentFactor: dashboardSource.crossoverExpenseAdjustmentFactor ?? DEFAULT_DASHBOARD_CONFIG.crossoverExpenseAdjustmentFactor,
      monteCarloWithdrawalRule: dashboardSource.monteCarloWithdrawalRule ?? DEFAULT_DASHBOARD_CONFIG.monteCarloWithdrawalRule,
      monteCarloTaxBands: dashboardSource.monteCarloTaxBands ?? DEFAULT_DASHBOARD_CONFIG.monteCarloTaxBands,
    },
  }

  return { config, found: true }
}

// Function to write config.json, e.g. after an account edit in the app's web UI
export function writeFireConfig(path: string, config: FireConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

export interface ClassifiedAccountsResult {
  accounts: ClassifiedAccount[]
  configFound: boolean
}

// Function to load config.json (plus the IRS limits reference file, for resolving a "max"
// contribution), fetch every open account, and classify them -- the one non-pure export in this
// module (it makes API calls), shared by app-server.ts's routes.
export async function loadClassifiedAccounts(
  config: ActualConfig,
  configPath: string,
  irsLimitsPath: string = DEFAULT_IRS_LIMITS_PATH,
): Promise<ClassifiedAccountsResult> {
  const { config: fireConfig, found: configFound } = loadFireConfig(configPath)
  const irsLimits = loadIrsLimits(irsLimitsPath)
  const accounts = await fetchAllOpenAccounts(config)
  return { accounts: classifyAccounts(accounts, fireConfig, fireConfig.dashboard.birthDate, irsLimits), configFound }
}
