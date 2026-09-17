import { describe, expect, it } from "vitest"

import { amortizationSeppAmount, rmdSeppAmount, seppAmount } from "./fire-sepp.ts"
import type { IrsLifeExpectancyTable } from "./irs-life-expectancy.ts"

const TABLE: IrsLifeExpectancyTable = {
  tableRevisionYear: 2022,
  source: "https://example.com",
  // Sparse stand-in covering just the ages these tests exercise -- lifeExpectancyFactor clamps to
  // whatever's at the requested index, so a short array is fine as long as tests stay within it.
  factorByAge: Array.from({ length: 60 }, (_, age) => (age === 50 ? 36.2 : age === 55 ? 31.6 : 80 - age)),
}

describe("rmdSeppAmount", () => {
  it("divides the balance by this age's own life expectancy factor", () => {
    // $1,000,000 / 36.2 = $27,624.31
    expect(rmdSeppAmount(1000000_00, 50, TABLE)).toBe(2762431)
  })

  it("changes with a different balance at the same age (recalculated, not locked in)", () => {
    // $500,000 / 36.2 = $13,812.15
    expect(rmdSeppAmount(500000_00, 50, TABLE)).toBe(1381215)
  })
})

describe("amortizationSeppAmount", () => {
  it("matches the standard level-payment amortization formula", () => {
    // 1,000,000 * 0.05 / (1 - 1.05^-36.2) = 60,312.23
    expect(amortizationSeppAmount(1000000_00, 50, 0.05, TABLE)).toBe(6031223)
  })

  it("degenerates to a flat balance/years split at a 0% rate", () => {
    expect(amortizationSeppAmount(1000000_00, 50, 0, TABLE)).toBe(rmdSeppAmount(1000000_00, 50, TABLE))
  })

  it("produces a larger payment than the RMD method at a positive rate (the real-world difference between the two)", () => {
    const amortized = amortizationSeppAmount(1000000_00, 50, 0.05, TABLE)
    const rmd = rmdSeppAmount(1000000_00, 50, TABLE)
    expect(amortized).toBeGreaterThan(rmd)
  })

  it("uses the START age's factor even when a later age is implied elsewhere -- the schedule locks in once", () => {
    const at50 = amortizationSeppAmount(1000000_00, 50, 0.05, TABLE)
    const at55 = amortizationSeppAmount(1000000_00, 55, 0.05, TABLE)
    expect(at50).not.toBe(at55)
  })
})

describe("seppAmount", () => {
  it("dispatches to the RMD calculation for the rmd method", () => {
    expect(seppAmount("rmd", 1000000_00, 50, null, TABLE)).toBe(rmdSeppAmount(1000000_00, 50, TABLE))
  })

  it("dispatches to the amortization calculation for the amortization method", () => {
    expect(seppAmount("amortization", 1000000_00, 50, 0.05, TABLE)).toBe(amortizationSeppAmount(1000000_00, 50, 0.05, TABLE))
  })

  it("treats a null interest rate as 0% for the amortization method", () => {
    expect(seppAmount("amortization", 1000000_00, 50, null, TABLE)).toBe(amortizationSeppAmount(1000000_00, 50, 0, TABLE))
  })
})
