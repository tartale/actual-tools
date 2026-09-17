import { readFileSync } from "node:fs"

// Reference-only HHS federal poverty guidelines (48 contiguous states + DC only -- no state is
// tracked anywhere else in this app, matching federal-tax-brackets.ts's own "federal only, no state
// modeling" precedent, so Alaska/Hawaii's higher guidelines are deliberately not vendored here),
// same convention as irs-limits.ts/federal-tax-brackets.ts: no HHS API for this data, so it's a
// small, git-committed, hand-updated file rather than fetched live -- ask a future session to
// re-verify it (a real web search against aspe.hhs.gov, not a guess) once a new guideline year is
// published, usually in mid-January. All dollar amounts in cents, matching this repo's convention
// everywhere else.
//
// guidelineYear is the HHS publication year, NOT the ACA coverage year that uses it -- eligibility
// for a given coverage year uses the PRIOR year's guidelines (2026 coverage -> 2025 guidelines),
// since open enrollment happens before the new year's guidelines are published. Callers pass in
// whichever coverage year they care about; this file only ever stores one guideline year at a time.
export interface FederalPovertyGuidelines {
  guidelineYear: number
  source: string
  // 1-person household, 48 states + DC.
  base: number
  // Added per person beyond the first.
  perAdditionalPerson: number
  // A CURRENT-LAW fact, not a permanent one -- the ARPA/IRA enhanced premium tax credit removed the
  // 400% FPL subsidy cliff from 2021 through 2025; it reverted (cliff back) for 2026 under current
  // law. Kept as data, not a constant in code, so a future session can flip it without a code change
  // once it re-verifies the law for whatever plan year is current then.
  subsidyCliffAt400Pct: boolean
}

export const DEFAULT_FEDERAL_POVERTY_GUIDELINES_PATH = "federal-poverty-guidelines.json"

// Function to load the federal poverty guidelines reference file. Missing or malformed is never
// fatal -- same reasoning as loadFederalTaxBrackets -- callers simply skip the %FPL/ACA line of the
// MAGI finding when this returns null.
export function loadFederalPovertyGuidelines(path: string = DEFAULT_FEDERAL_POVERTY_GUIDELINES_PATH): FederalPovertyGuidelines | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { guidelineYear?: unknown }).guidelineYear !== "number" ||
      typeof (parsed as { base?: unknown }).base !== "number" ||
      typeof (parsed as { perAdditionalPerson?: unknown }).perAdditionalPerson !== "number"
    ) {
      return null
    }
    return parsed as FederalPovertyGuidelines
  } catch {
    return null
  }
}

// Function to compute the poverty guideline for a given household size -- a straight line (base
// plus a fixed per-person increment), which is how HHS itself publishes it rather than a lookup
// table with its own rounding per size.
export function federalPovertyGuideline(householdSize: number, table: FederalPovertyGuidelines): number {
  return table.base + table.perAdditionalPerson * (householdSize - 1)
}
