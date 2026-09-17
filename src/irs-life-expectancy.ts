import { readFileSync } from "node:fs"

// Reference-only IRS Single Life Expectancy table (Pub. 590-B, Table I), same convention as
// irs-limits.ts/federal-tax-brackets.ts: no IRS API for this data, so it's a small, git-committed,
// hand-updated file rather than fetched live. Unlike those two, this one doesn't change annually --
// it was last revised for distribution years beginning 2022 (a mortality-assumption update, not a
// routine inflation adjustment) -- so there's no per-year staleness check here; ask a future session
// to re-verify it (a real web search against irs.gov, not a guess) only if the IRS announces another
// such revision.

export interface IrsLifeExpectancyTable {
  tableRevisionYear: number
  source: string
  // Index is age in whole years, 0 through the table's own terminal entry (120). See
  // lifeExpectancyFactor for how an age past the end of this array is handled.
  factorByAge: number[]
}

export const DEFAULT_IRS_LIFE_EXPECTANCY_PATH = "irs-life-expectancy.json"

// Function to load the life expectancy reference file. Missing or malformed is never fatal -- same
// reasoning as loadIrsLimits/loadFederalTaxBrackets -- callers simply can't offer the SEPP
// calculators without it.
export function loadIrsLifeExpectancy(path: string = DEFAULT_IRS_LIFE_EXPECTANCY_PATH): IrsLifeExpectancyTable | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { factorByAge?: unknown }).factorByAge) ||
      (parsed as { factorByAge: unknown[] }).factorByAge.length === 0
    ) {
      return null
    }
    return parsed as IrsLifeExpectancyTable
  } catch {
    return null
  }
}

// Function to look up the single life expectancy factor for a given age, clamping to the table's
// own terminal entry (age 120) for anything at or beyond it, and to age 0 for anything below --
// the IRS table itself has no entries outside that range, and clamping means a caller never has to
// special-case the edges itself. Ages are rounded to the nearest whole year -- the table itself has
// no notion of a fractional age.
export function lifeExpectancyFactor(age: number, table: IrsLifeExpectancyTable): number {
  const index = Math.max(0, Math.min(Math.round(age), table.factorByAge.length - 1))
  return table.factorByAge[index] as number
}
