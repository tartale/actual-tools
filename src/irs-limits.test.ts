import { writeFileSync, unlinkSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { isIrsLimitsStale, loadIrsLimits } from "./irs-limits.ts"
import type { IrsLimits } from "./irs-limits.ts"

const TEST_PATH = "/tmp/irs-limits.test.json"

const VALID_LIMITS: IrsLimits = {
  taxYear: 2026,
  source: "https://example.com",
  employerPlan: { standard: 2450000, catchUp50: 800000, catchUp60to63: 1125000, annualAdditions: 7200000 },
  ira: { standard: 750000, catchUp50: 110000 },
  hsa: { selfOnly: 440000, family: 875000, catchUp55: 100000 },
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadIrsLimits", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadIrsLimits("/tmp/does-not-exist-irs-limits.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(VALID_LIMITS))
    expect(loadIrsLimits(TEST_PATH)).toEqual(VALID_LIMITS)
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadIrsLimits(TEST_PATH)).toBeNull()
  })

  it("returns null for a well-formed JSON file missing required sections", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ taxYear: 2026 }))
    expect(loadIrsLimits(TEST_PATH)).toBeNull()
  })
})

describe("isIrsLimitsStale", () => {
  it("is not stale the same year, or before, the limits are for", () => {
    expect(isIrsLimitsStale(VALID_LIMITS, new Date("2026-06-01"))).toBe(false)
    expect(isIrsLimitsStale(VALID_LIMITS, new Date("2025-06-01"))).toBe(false)
  })

  it("is stale once the calendar year has moved past the limits' tax year", () => {
    expect(isIrsLimitsStale(VALID_LIMITS, new Date("2027-01-01"))).toBe(true)
  })
})
