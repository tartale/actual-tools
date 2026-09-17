import { writeFileSync, unlinkSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import {
  estimateMagi,
  federalTaxOwed,
  isFederalTaxBracketsStale,
  loadFederalTaxBrackets,
  marginalRateFor,
  taxableSocialSecurity,
} from "./federal-tax-brackets.ts"
import type { FederalTaxBrackets } from "./federal-tax-brackets.ts"

const TEST_PATH = "/tmp/federal-tax-brackets.test.json"

const TABLE: FederalTaxBrackets = {
  taxYear: 2026,
  source: "https://example.com",
  standardDeduction: { single: 1610000, marriedFilingJointly: 3220000, headOfHousehold: 2415000 },
  brackets: {
    single: [
      { rate: 0.1, upTo: 1240000 },
      { rate: 0.12, upTo: 5040000 },
      { rate: 0.22, upTo: 10570000 },
      { rate: 0.24, upTo: 20177500 },
      { rate: 0.32, upTo: 25622500 },
      { rate: 0.35, upTo: 64060000 },
      { rate: 0.37, upTo: null },
    ],
    marriedFilingJointly: [
      { rate: 0.1, upTo: 2480000 },
      { rate: 0.12, upTo: 10080000 },
      { rate: 0.22, upTo: 21140000 },
      { rate: 0.24, upTo: 40355000 },
      { rate: 0.32, upTo: 51245000 },
      { rate: 0.35, upTo: 76870000 },
      { rate: 0.37, upTo: null },
    ],
    headOfHousehold: [
      { rate: 0.1, upTo: 1770000 },
      { rate: 0.12, upTo: 6745000 },
      { rate: 0.22, upTo: 10570000 },
      { rate: 0.24, upTo: 20177500 },
      { rate: 0.32, upTo: 25620000 },
      { rate: 0.35, upTo: 64060000 },
      { rate: 0.37, upTo: null },
    ],
  },
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadFederalTaxBrackets", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadFederalTaxBrackets("/tmp/does-not-exist-federal-tax-brackets.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(TABLE))
    expect(loadFederalTaxBrackets(TEST_PATH)).toEqual(TABLE)
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadFederalTaxBrackets(TEST_PATH)).toBeNull()
  })

  it("returns null for a well-formed JSON file missing required sections", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ taxYear: 2026 }))
    expect(loadFederalTaxBrackets(TEST_PATH)).toBeNull()
  })
})

describe("isFederalTaxBracketsStale", () => {
  it("is not stale the same year, or before, the brackets are for", () => {
    expect(isFederalTaxBracketsStale(TABLE, new Date("2026-06-01"))).toBe(false)
    expect(isFederalTaxBracketsStale(TABLE, new Date("2025-06-01"))).toBe(false)
  })

  it("is stale once the calendar year has moved past the brackets' tax year", () => {
    expect(isFederalTaxBracketsStale(TABLE, new Date("2027-01-01"))).toBe(true)
  })
})

describe("federalTaxOwed", () => {
  it("is zero for zero or negative taxable income", () => {
    expect(federalTaxOwed(0, "single", TABLE)).toBe(0)
    expect(federalTaxOwed(-100, "single", TABLE)).toBe(0)
  })

  it("taxes only the first bracket when income stays within it", () => {
    expect(federalTaxOwed(1000000, "single", TABLE)).toBe(Math.round(1000000 * 0.1))
  })

  it("applies each bracket's rate only to the income within that bracket", () => {
    // $100,000 taxable, single: 10%*12,400 + 12%*38,000 + 22%*49,600 = 1,240+4,560+10,912 = 16,712
    expect(federalTaxOwed(100000_00, "single", TABLE)).toBe(1671200)
  })

  it("applies the top bracket's rate above its own floor with no upper bound", () => {
    const justAboveTop = 64060000 + 100
    const tax = federalTaxOwed(justAboveTop, "single", TABLE)
    const taxAtEdge = federalTaxOwed(64060000, "single", TABLE)
    expect(tax - taxAtEdge).toBe(Math.round(100 * 0.37))
  })
})

describe("marginalRateFor", () => {
  it("returns the rate for the bracket the amount falls in", () => {
    expect(marginalRateFor(40000_00, "single", TABLE)).toBe(0.12)
    expect(marginalRateFor(60000_00, "single", TABLE)).toBe(0.22)
    expect(marginalRateFor(100000_00, "single", TABLE)).toBe(0.22)
  })

  it("returns the top bracket's rate for income above every bound", () => {
    expect(marginalRateFor(1000000_00, "single", TABLE)).toBe(0.37)
  })
})

describe("taxableSocialSecurity", () => {
  it("is zero below the base combined-income threshold", () => {
    expect(taxableSocialSecurity(20000_00, 5000_00, "single")).toBe(0)
  })

  it("taxes up to 50% in the middle tier", () => {
    // combined = 20,000 (other) + 10,000 (half of 20,000 SS) = 30,000; base 25,000, tier2 34,000
    // taxable = min(0.5*20,000, 0.5*(30,000-25,000)) = min(10,000, 2,500) = 2,500
    expect(taxableSocialSecurity(20000_00, 20000_00, "single")).toBe(2500_00)
  })

  it("taxes up to 85% above the second tier", () => {
    // combined = 60,000 + 10,000 = 70,000; tier1 = min(10,000, 0.5*(34,000-25,000)=4,500) = 4,500
    // tier2 = (70,000-34,000)*0.85 = 30,600; total = 35,100, capped at 0.85*20,000 = 17,000
    expect(taxableSocialSecurity(20000_00, 60000_00, "single")).toBe(17000_00)
  })

  it("is zero for a zero benefit", () => {
    expect(taxableSocialSecurity(0, 100000_00, "single")).toBe(0)
  })
})

describe("estimateMagi", () => {
  it("combines every ordinary-income source and applies the standard deduction", () => {
    const est = estimateMagi(
      { grossTaxDeferredWithdrawal: 60000_00, rothConversionAmount: 0, pensionIncome: 0, socialSecurityBenefit: 20000_00 },
      "single",
      TABLE,
    )
    expect(est.taxableSocialSecurity).toBe(17000_00)
    expect(est.magi).toBe(77000_00)
    expect(est.taxableIncome).toBe(60900_00)
    expect(est.federalTax).toBe(811000)
    expect(est.marginalRate).toBe(0.22)
  })

  it("counts a Roth conversion as ordinary income in its own conversion year", () => {
    const withConversion = estimateMagi(
      { grossTaxDeferredWithdrawal: 0, rothConversionAmount: 50000_00, pensionIncome: 0, socialSecurityBenefit: 0 },
      "single",
      TABLE,
    )
    const withoutConversion = estimateMagi(
      { grossTaxDeferredWithdrawal: 0, rothConversionAmount: 0, pensionIncome: 0, socialSecurityBenefit: 0 },
      "single",
      TABLE,
    )
    expect(withConversion.magi).toBe(50000_00)
    expect(withConversion.federalTax).toBeGreaterThan(withoutConversion.federalTax)
  })
})
