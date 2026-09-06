import { readFileSync } from "node:fs"

// Reference-only IRS annual contribution limits, shown as context next to the retirement/HSA
// monthly-contribution question in ./actual configure. There's no IRS API for this data (only
// annual news releases and Revenue Procedure PDFs), so it's a small, git-committed, hand-updated
// file rather than fetched live -- ask a future session to re-verify it (a real web search against
// irs.gov, not a guess) once a new tax year's limits are announced, usually in the preceding fall.
// All dollar amounts in cents, matching this repo's convention everywhere else.

export interface IrsLimits {
  taxYear: number
  source: string
  // 401(k)/403(b)/most 457 plans/the federal TSP -- one shared limit across pre-tax and Roth
  // contributions to the same plan. `annualAdditions` is the separate, much larger IRC Sec. 415(c)
  // ceiling on employee + employer money TOGETHER (elective deferrals, employer match/profit-
  // sharing, after-tax contributions) -- the same catchUp50/catchUp60to63 amounts apply on top of
  // this limit too, confirmed via a real web search (not assumed): the 2026 figures are identical
  // dollar amounts to the elective-deferral catch-ups.
  employerPlan: { standard: number; catchUp50: number; catchUp60to63: number; annualAdditions: number }
  // Traditional + Roth IRA combined annual limit (not per-account).
  ira: { standard: number; catchUp50: number }
  hsa: { selfOnly: number; family: number; catchUp55: number }
}

export const DEFAULT_IRS_LIMITS_PATH = "irs-limits.json"

// Function to load the IRS limits reference file. Missing or malformed is never fatal -- this is
// advisory context for a prompt, not required data -- so any problem just means callers show no
// reference line at all.
export function loadIrsLimits(path: string = DEFAULT_IRS_LIMITS_PATH): IrsLimits | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { taxYear?: unknown }).taxYear !== "number" ||
      !(parsed as { employerPlan?: { annualAdditions?: unknown } }).employerPlan?.annualAdditions ||
      !(parsed as { ira?: unknown }).ira ||
      !(parsed as { hsa?: unknown }).hsa
    ) {
      return null
    }
    return parsed as IrsLimits
  } catch {
    return null
  }
}

// Function to check whether the loaded limits are for a tax year the calendar has already moved
// past -- IRS limits are announced annually, so a file left over from a prior year is stale, not
// wrong outright (some figures don't change every year), but worth flagging rather than presenting
// silently as current.
export function isIrsLimitsStale(limits: IrsLimits, asOf: Date = new Date()): boolean {
  return asOf.getFullYear() > limits.taxYear
}
