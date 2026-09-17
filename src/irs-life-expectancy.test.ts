import { writeFileSync, unlinkSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { lifeExpectancyFactor, loadIrsLifeExpectancy } from "./irs-life-expectancy.ts"
import type { IrsLifeExpectancyTable } from "./irs-life-expectancy.ts"

const TEST_PATH = "/tmp/irs-life-expectancy.test.json"

const VALID_TABLE: IrsLifeExpectancyTable = {
  tableRevisionYear: 2022,
  source: "https://example.com",
  factorByAge: [84.6, 83.7, 82.8],
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadIrsLifeExpectancy", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadIrsLifeExpectancy("/tmp/does-not-exist-irs-life-expectancy.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(VALID_TABLE))
    expect(loadIrsLifeExpectancy(TEST_PATH)).toEqual(VALID_TABLE)
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadIrsLifeExpectancy(TEST_PATH)).toBeNull()
  })

  it("returns null for a well-formed JSON file missing factorByAge, or with an empty one", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ tableRevisionYear: 2022 }))
    expect(loadIrsLifeExpectancy(TEST_PATH)).toBeNull()
    writeFileSync(TEST_PATH, JSON.stringify({ ...VALID_TABLE, factorByAge: [] }))
    expect(loadIrsLifeExpectancy(TEST_PATH)).toBeNull()
  })
})

describe("lifeExpectancyFactor", () => {
  it("returns the factor for a whole-year age within the table", () => {
    expect(lifeExpectancyFactor(1, VALID_TABLE)).toBe(83.7)
  })

  it("rounds a fractional age to the nearest whole year", () => {
    expect(lifeExpectancyFactor(1.4, VALID_TABLE)).toBe(83.7)
    expect(lifeExpectancyFactor(1.6, VALID_TABLE)).toBe(82.8)
  })

  it("clamps to the table's terminal entry for an age past the end of it", () => {
    expect(lifeExpectancyFactor(200, VALID_TABLE)).toBe(82.8)
  })

  it("clamps to the table's first entry for a negative age", () => {
    expect(lifeExpectancyFactor(-5, VALID_TABLE)).toBe(84.6)
  })
})
