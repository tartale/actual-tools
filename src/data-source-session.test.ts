import { unlinkSync, writeFileSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { clearFileDataSourceSession, loadFileDataSourceSession, writeFileDataSourceSession } from "./data-source-session.ts"
import type { FileDataSourceSession } from "./data-source-session.ts"

const TEST_PATH = "/tmp/data-source-session.test.json"

const SESSION: FileDataSourceSession = {
  filePath: "/home/user/accounts.csv",
  lastLoadedAt: "2026-09-21T00:00:00.000Z",
}

afterEach(() => {
  try {
    unlinkSync(TEST_PATH)
  } catch {
    // fine if the test didn't create it
  }
})

describe("loadFileDataSourceSession", () => {
  it("returns null when the file doesn't exist", () => {
    expect(loadFileDataSourceSession("/tmp/does-not-exist-data-source-session.json")).toBeNull()
  })

  it("loads a well-formed file", () => {
    writeFileSync(TEST_PATH, JSON.stringify(SESSION))
    expect(loadFileDataSourceSession(TEST_PATH)).toEqual(SESSION)
  })

  it("loads a well-formed file with a null lastLoadedAt (the brief pre-first-load state)", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ filePath: "/home/user/accounts.csv", lastLoadedAt: null }))
    expect(loadFileDataSourceSession(TEST_PATH)).toEqual({ filePath: "/home/user/accounts.csv", lastLoadedAt: null })
  })

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("returns null when filePath is missing", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ lastLoadedAt: "2026-09-21T00:00:00.000Z" }))
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("returns null when lastLoadedAt is neither a string nor null", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ filePath: "/home/user/accounts.csv", lastLoadedAt: 12345 }))
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })
})

describe("writeFileDataSourceSession / clearFileDataSourceSession", () => {
  it("round-trips through a write and a load", () => {
    writeFileDataSourceSession(TEST_PATH, SESSION)
    expect(loadFileDataSourceSession(TEST_PATH)).toEqual(SESSION)
  })

  it("removes the file so a later load returns null", () => {
    writeFileDataSourceSession(TEST_PATH, SESSION)
    clearFileDataSourceSession(TEST_PATH)
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("is a no-op (not an error) when nothing is there to clear", () => {
    expect(() => clearFileDataSourceSession(TEST_PATH)).not.toThrow()
  })
})
