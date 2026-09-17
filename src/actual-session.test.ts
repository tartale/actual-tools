import { unlinkSync, writeFileSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import type { ActualConfig } from "./actual-helpers.ts"
import { clearActualSession, loadActualSession, writeActualSession } from "./actual-session.ts"

const TEST_PATH = "/tmp/actual-session.test.json"

const SESSION: ActualConfig = {
  baseUrl: "https://actual.example.com",
  budgetId: "my-budget",
  apiKey: "secret-key",
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadActualSession", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadActualSession("/tmp/does-not-exist-actual-session.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(SESSION))
    expect(loadActualSession(TEST_PATH)).toEqual(SESSION)
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadActualSession(TEST_PATH)).toBeNull()
  })

  it("returns null when a required field is missing", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ baseUrl: "https://actual.example.com", budgetId: "my-budget" }))
    expect(loadActualSession(TEST_PATH)).toBeNull()
  })
})

describe("writeActualSession / clearActualSession", () => {
  it("round-trips through a write and a load", () => {
    writeActualSession(TEST_PATH, SESSION)
    expect(loadActualSession(TEST_PATH)).toEqual(SESSION)
  })

  it("removes the file so a later load returns null", () => {
    writeActualSession(TEST_PATH, SESSION)
    clearActualSession(TEST_PATH)
    expect(loadActualSession(TEST_PATH)).toBeNull()
  })

  it("is a no-op (not an error) when nothing is there to clear", () => {
    expect(() => clearActualSession(TEST_PATH)).not.toThrow()
  })
})
