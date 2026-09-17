import { writeFileSync, unlinkSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { federalPovertyGuideline, loadFederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"
import type { FederalPovertyGuidelines } from "./federal-poverty-guidelines.ts"

const TEST_PATH = "/tmp/federal-poverty-guidelines.test.json"

const TABLE: FederalPovertyGuidelines = {
  guidelineYear: 2025,
  source: "https://example.com",
  base: 1565000, // $15,650
  perAdditionalPerson: 550000, // $5,500
  subsidyCliffAt400Pct: true,
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadFederalPovertyGuidelines", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadFederalPovertyGuidelines("/tmp/does-not-exist-federal-poverty-guidelines.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(TABLE))
    expect(loadFederalPovertyGuidelines(TEST_PATH)).toEqual(TABLE)
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadFederalPovertyGuidelines(TEST_PATH)).toBeNull()
  })

  it("returns null for a well-formed JSON file missing required fields", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ guidelineYear: 2025 }))
    expect(loadFederalPovertyGuidelines(TEST_PATH)).toBeNull()
  })
})

describe("federalPovertyGuideline", () => {
  it("is just the base for a 1-person household", () => {
    expect(federalPovertyGuideline(1, TABLE)).toBe(1565000)
  })

  it("adds one increment per additional person", () => {
    expect(federalPovertyGuideline(2, TABLE)).toBe(2115000) // $21,150
    expect(federalPovertyGuideline(4, TABLE)).toBe(3215000) // $32,150
  })
})
