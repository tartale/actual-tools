import { describe, expect, it } from "vitest"

import { detectAnomaly, median, medianAbsoluteDeviation } from "./anomaly-detect.ts"

describe("median", () => {
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0)
  })

  it("returns the middle value of an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it("averages the two middle values of an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it("doesn't care about input order", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3)
  })
})

describe("medianAbsoluteDeviation", () => {
  it("is zero when every value equals the center", () => {
    expect(medianAbsoluteDeviation([10, 10, 10], 10)).toBe(0)
  })

  it("computes the median of absolute distances from the center", () => {
    // distances from 10: 0, 10, 20 -> median 10
    expect(medianAbsoluteDeviation([10, 20, 30], 10)).toBe(10)
  })
})

describe("detectAnomaly", () => {
  const stableHistory = [12000, 11800, 12200, 11900, 12100, 12000]

  it("is not an anomaly when there isn't enough history", () => {
    const result = detectAnomaly(50000, [12000, 12000], { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result).toEqual({ isAnomaly: false, direction: null, median: 0, modifiedZScore: 0 })
  })

  it("is not an anomaly when the value matches its history", () => {
    const result = detectAnomaly(12050, stableHistory, { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result.isAnomaly).toBe(false)
    expect(result.direction).toBeNull()
  })

  it("is not an anomaly when the deviation doesn't clear the dollar floor, however large the z-score", () => {
    // A category whose history is a rock-steady $0.00 sees a single $10.00 charge -- infinitely
    // large in percentage terms, but trivial in dollars, so the floor should suppress it.
    const result = detectAnomaly(1000, [0, 0, 0, 0], { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result.isAnomaly).toBe(false)
  })

  it("flags a value far above its history as a high anomaly", () => {
    const result = detectAnomaly(45000, stableHistory, { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result.isAnomaly).toBe(true)
    expect(result.direction).toBe("high")
    expect(result.median).toBe(12000)
  })

  it("flags a value far below its history as a low anomaly", () => {
    const result = detectAnomaly(500, stableHistory, { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result.isAnomaly).toBe(true)
    expect(result.direction).toBe("low")
  })

  it("flags any deviation clearing the dollar floor when history has zero variation (MAD = 0)", () => {
    const result = detectAnomaly(20000, [15000, 15000, 15000, 15000], { minHistoryCount: 3, minDeviationCents: 5000 })
    expect(result.isAnomaly).toBe(true)
    expect(result.direction).toBe("high")
    expect(result.modifiedZScore).toBe(Infinity)
  })

  it("respects a custom minimum history count and minimum deviation", () => {
    const lenient = detectAnomaly(20000, [10000, 10000], { minHistoryCount: 2, minDeviationCents: 100 })
    expect(lenient.isAnomaly).toBe(true)

    const strict = detectAnomaly(20000, [10000, 10000], { minHistoryCount: 5, minDeviationCents: 100 })
    expect(strict.isAnomaly).toBe(false)
  })
})
