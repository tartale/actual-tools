import { readFileSync } from "node:fs"

// Reference-only federal ordinary-income tax brackets and standard deductions, same convention as
// irs-limits.ts: no IRS API for this data (only annual news releases and Revenue Procedure PDFs),
// so it's a small, git-committed, hand-updated file rather than fetched live -- ask a future session
// to re-verify it (a real web search against irs.gov, not a guess) once a new tax year's brackets
// are announced, usually in the preceding fall. All dollar amounts in cents, matching this repo's
// convention everywhere else.

export type FilingStatus = "single" | "marriedFilingJointly" | "headOfHousehold"

export const FILING_STATUSES: FilingStatus[] = ["single", "marriedFilingJointly", "headOfHousehold"]

export interface TaxBracket {
  rate: number
  // Upper edge of taxable income this rate applies through, in cents; null for the top (unbounded)
  // bracket.
  upTo: number | null
}

export interface FederalTaxBrackets {
  taxYear: number
  source: string
  standardDeduction: Record<FilingStatus, number>
  brackets: Record<FilingStatus, TaxBracket[]>
}

export const DEFAULT_FEDERAL_TAX_BRACKETS_PATH = "federal-tax-brackets.json"

// Function to load the federal tax bracket reference file. Missing or malformed is never fatal --
// same reasoning as loadIrsLimits -- callers fall back to the flat WITHDRAWAL_TAX_RATES estimate
// when this returns null.
export function loadFederalTaxBrackets(path: string = DEFAULT_FEDERAL_TAX_BRACKETS_PATH): FederalTaxBrackets | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { taxYear?: unknown }).taxYear !== "number" ||
      !(parsed as { standardDeduction?: unknown }).standardDeduction ||
      !(parsed as { brackets?: unknown }).brackets
    ) {
      return null
    }
    return parsed as FederalTaxBrackets
  } catch {
    return null
  }
}

// Function to check whether the loaded brackets are for a tax year the calendar has already moved
// past -- same reasoning as isIrsLimitsStale.
export function isFederalTaxBracketsStale(brackets: FederalTaxBrackets, asOf: Date = new Date()): boolean {
  return asOf.getFullYear() > brackets.taxYear
}

// Function to compute total federal ordinary-income tax owed on a given amount of TAXABLE income
// (already net of the standard deduction) by walking the progressive bracket table -- each dollar
// is taxed at the rate for the bracket it falls in, not the top marginal rate applied to the whole
// amount. Returns cents.
export function federalTaxOwed(taxableIncomeCents: number, filingStatus: FilingStatus, table: FederalTaxBrackets): number {
  if (taxableIncomeCents <= 0) return 0
  let tax = 0
  let lastEdge = 0
  for (const bracket of table.brackets[filingStatus]) {
    const edge = bracket.upTo ?? Infinity
    const amountInBracket = Math.max(0, Math.min(taxableIncomeCents, edge) - lastEdge)
    tax += amountInBracket * bracket.rate
    if (taxableIncomeCents <= edge) break
    lastEdge = edge
  }
  return Math.round(tax)
}

// Function to find the marginal rate the NEXT dollar of taxable income would be taxed at -- this is
// the rate a gross-up calculation (see the Bridge simulation's own reasoning for why withdrawals
// need to be grossed up) should assume, not the average/effective rate on income already earned.
export function marginalRateFor(taxableIncomeCents: number, filingStatus: FilingStatus, table: FederalTaxBrackets): number {
  const brackets = table.brackets[filingStatus]
  for (const bracket of brackets) {
    if (bracket.upTo == null || taxableIncomeCents <= bracket.upTo) return bracket.rate
  }
  return (brackets[brackets.length - 1] as TaxBracket).rate
}

// Combined-income thresholds for Social Security taxability (IRC Sec. 86(c)) -- fixed by statute
// since 1984 and, unlike the bracket table above, never inflation-indexed, so these stay a plain
// constant rather than part of the yearly-updated file. Head of household uses the same thresholds
// as single (the statute only distinguishes joint returns).
const SS_TAXABILITY_BASE: Record<FilingStatus, number> = { single: 2500000, marriedFilingJointly: 3200000, headOfHousehold: 2500000 }
const SS_TAXABILITY_SECOND_TIER: Record<FilingStatus, number> = { single: 3400000, marriedFilingJointly: 4400000, headOfHousehold: 3400000 }

// Function to estimate how much of a Social Security benefit counts as taxable ordinary income,
// using the standard combined-income formula from IRS Pub. 915 (a widely used simplified version of
// the full worksheet -- accurate for the common case this app models: no tax-exempt interest, no
// other Sec. 86 adjustments -- consistent with this codebase's existing "rough, user-owned estimate"
// tax philosophy rather than a line-by-line reproduction of the 18-line worksheet).
export function taxableSocialSecurity(ssBenefitCents: number, otherIncomeCents: number, filingStatus: FilingStatus): number {
  if (ssBenefitCents <= 0) return 0
  const combinedIncome = otherIncomeCents + ssBenefitCents / 2
  const base = SS_TAXABILITY_BASE[filingStatus]
  const secondTier = SS_TAXABILITY_SECOND_TIER[filingStatus]
  if (combinedIncome <= base) return 0
  if (combinedIncome <= secondTier) {
    return Math.round(Math.min(ssBenefitCents * 0.5, (combinedIncome - base) * 0.5))
  }
  const tier1 = Math.min(ssBenefitCents * 0.5, (secondTier - base) * 0.5)
  const tier2 = (combinedIncome - secondTier) * 0.85
  return Math.round(Math.min(ssBenefitCents * 0.85, tier1 + tier2))
}

export interface MagiEstimate {
  // Gross Social Security benefit, before the taxable-portion formula above.
  socialSecurityBenefit: number
  // The portion of it that's actually taxable.
  taxableSocialSecurity: number
  // Every other item of ordinary income this app knows about for the year: gross tax-deferred
  // withdrawals, a Roth conversion (taxable in its own conversion year even though it never leaves
  // the portfolio), and pension income.
  otherOrdinaryIncome: number
  magi: number
  taxableIncome: number
  federalTax: number
  effectiveRate: number
  marginalRate: number
}

// Function to estimate one year's MAGI and federal tax, combining every ordinary-income source this
// app models. "MAGI" here is a practical approximation (AGI with nothing added back) -- good enough
// to sanity-check against ACA/IRMAA thresholds, not a line from Form 1040. effectiveRate is what
// simulateBridge's withdrawal gross-up actually needs applied to a NEW dollar of withdrawal --
// marginalRate, not the blended rate on income already committed -- see marginalRateFor.
export function estimateMagi(
  income: { grossTaxDeferredWithdrawal: number; rothConversionAmount: number; pensionIncome: number; socialSecurityBenefit: number },
  filingStatus: FilingStatus,
  table: FederalTaxBrackets,
): MagiEstimate {
  const otherOrdinaryIncome = income.grossTaxDeferredWithdrawal + income.rothConversionAmount + income.pensionIncome
  const taxableSS = taxableSocialSecurity(income.socialSecurityBenefit, otherOrdinaryIncome, filingStatus)
  const magi = otherOrdinaryIncome + taxableSS
  const taxableIncome = Math.max(0, magi - table.standardDeduction[filingStatus])
  const federalTax = federalTaxOwed(taxableIncome, filingStatus, table)
  return {
    socialSecurityBenefit: income.socialSecurityBenefit,
    taxableSocialSecurity: taxableSS,
    otherOrdinaryIncome,
    magi,
    taxableIncome,
    federalTax,
    effectiveRate: magi > 0 ? federalTax / magi : 0,
    marginalRate: marginalRateFor(taxableIncome, filingStatus, table),
  }
}
