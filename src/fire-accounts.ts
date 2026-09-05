import { readFileSync } from "node:fs"

import { fetchAllOpenAccounts } from "./actual-helpers.ts"
import type { Account, ActualConfig } from "./actual-helpers.ts"

// Classifies accounts for FIRE reporting: which are retirement/investment/debt/cash, and enough
// detail about each (tax treatment, access age) to eventually populate a Monte Carlo "pot" in a
// later phase. Pure -- no API calls. Actual's own account API has no type field, so this combines
// a heuristic guess at the account's name with an explicit config file the guess can be
// overridden by. See ./actual report accounts for the tool that surfaces the result for review.

export type FireAccountCategory =
  | "retirement-tax-deferred"
  | "retirement-roth"
  | "hsa"
  | "taxable-investment"
  | "debt"
  | "cash-other"

export type TaxTreatment = "tax-deferred" | "tax-free" | "taxable" | "none"

export interface FireAccountTraits {
  category: FireAccountCategory
  taxTreatment: TaxTreatment
  // Age at which withdrawals become unrestricted/penalty-free; null when not applicable or not
  // yet known. Unused until a later phase's Monte Carlo pots -- computed now so the schema doesn't
  // need to change later.
  accessAge: number | null
}

export type ClassificationSource = "override" | "heuristic" | "default"

export interface ClassifiedAccount extends FireAccountTraits {
  id: string
  name: string
  offbudget: boolean
  source: ClassificationSource
}

// One user-supplied override. `match` is an account id OR an exact account name, mirroring how
// -c/--category filters already match "name or ID" elsewhere in this repo (shouldUpdateCategory).
export interface FireAccountOverride {
  match: string
  category: FireAccountCategory
  taxTreatment?: TaxTreatment
  accessAge?: number | null
}

export interface FireAccountsConfig {
  version: 1
  accounts: FireAccountOverride[]
}

export const EMPTY_FIRE_ACCOUNTS_CONFIG: FireAccountsConfig = { version: 1, accounts: [] }

export const DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH = "fire-accounts.json"

// Age at which most US tax-advantaged retirement accounts can be withdrawn from without an early
// withdrawal penalty. A rough default -- override per-account for precision (e.g. Roth
// contribution basis, or plan-specific rules like the age-55 separation-from-service exception).
const DEFAULT_ACCESS_AGE = 59

// Ordered, case-insensitive name-pattern rules. Order matters: more specific patterns (roth, hsa)
// are checked before broader ones (ira, investment) so e.g. "Roth 401k" classifies as
// retirement-roth, not retirement-tax-deferred.
interface HeuristicRule {
  pattern: RegExp
  traits: FireAccountTraits
}

const HEURISTIC_RULES: readonly HeuristicRule[] = [
  { pattern: /\bhsa\b|\bhealth savings\b/i, traits: { category: "hsa", taxTreatment: "tax-free", accessAge: null } },
  { pattern: /\broth\b/i, traits: { category: "retirement-roth", taxTreatment: "tax-free", accessAge: DEFAULT_ACCESS_AGE } },
  {
    pattern: /\b401\s?k\b|\b403\s?b\b|\b457\b|\bira\b|\bpension\b|\btsp\b/i,
    traits: { category: "retirement-tax-deferred", taxTreatment: "tax-deferred", accessAge: DEFAULT_ACCESS_AGE },
  },
  {
    pattern: /\bmortgage\b|\bloan\b|\bcredit card\b|\bline of credit\b|\bheloc\b/i,
    traits: { category: "debt", taxTreatment: "none", accessAge: null },
  },
  {
    pattern: /\bbrokerage\b|\binvestment\b|\btaxable\b/i,
    traits: { category: "taxable-investment", taxTreatment: "taxable", accessAge: null },
  },
]

// Function to classify a single account by name only, using ordered heuristic rules. Returns null
// when nothing matches, so the caller can fall back to a documented default rather than a silent
// guess.
export function classifyByHeuristic(name: string): FireAccountTraits | null {
  const rule = HEURISTIC_RULES.find((candidate) => candidate.pattern.test(name))
  return rule ? rule.traits : null
}

// Function to find a config override matching an account by id or exact name
export function findOverride(account: Pick<Account, "id" | "name">, config: FireAccountsConfig): FireAccountOverride | null {
  return config.accounts.find((override) => override.match === account.id || override.match === account.name) ?? null
}

// Function to classify every account: override > heuristic > safe default ("cash-other", tax
// treatment "none"). The "default" source is meant to be visibly flagged by callers (e.g.
// report-accounts.ts) as needing review -- it is a safe fallback, not a confident classification.
export function classifyAccounts(
  accounts: readonly Pick<Account, "id" | "name" | "offbudget">[],
  config: FireAccountsConfig,
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
        source: "override" as const,
      }
    }
    const heuristic = classifyByHeuristic(account.name)
    if (heuristic) {
      return { ...identity, ...heuristic, source: "heuristic" as const }
    }
    return { ...identity, category: "cash-other" as const, taxTreatment: "none" as const, accessAge: null, source: "default" as const }
  })
}

export interface LoadedFireAccountsConfig {
  config: FireAccountsConfig
  found: boolean
}

// Function to load the account classification overrides file. Missing is fine (an empty config,
// meaning "no overrides yet") -- `found: false` lets a caller decide whether to warn about that,
// keeping this function itself free of console side effects and easy to test. Present-but-
// malformed is always an error: silently ignoring a typo in the user's own overrides would be
// worse than failing loudly.
export function loadFireAccountsConfig(path: string): LoadedFireAccountsConfig {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return { config: EMPTY_FIRE_ACCOUNTS_CONFIG, found: false }
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
    throw new Error(`Invalid fire-accounts config in ${path}: expected { "version": 1, "accounts": [...] }`)
  }

  return { config: parsed as FireAccountsConfig, found: true }
}

export interface ClassifiedAccountsResult {
  accounts: ClassifiedAccount[]
  configFound: boolean
}

// Function to load the overrides config, fetch every open account, and classify them -- the one
// non-pure export in this module (it makes an API call), shared by report-accounts.ts and
// report-fire.ts so the "load, fetch, classify" sequence isn't duplicated between them.
export async function loadClassifiedAccounts(config: ActualConfig, configPath: string): Promise<ClassifiedAccountsResult> {
  const { config: accountsConfig, found: configFound } = loadFireAccountsConfig(configPath)
  const accounts = await fetchAllOpenAccounts(config)
  return { accounts: classifyAccounts(accounts, accountsConfig), configFound }
}
