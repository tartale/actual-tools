import { unlinkSync, writeFileSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { clearFileDataSourceSession, loadFileDataSourceSession, writeFileDataSourceSession } from "./data-source-session.ts"
import type { FileDataSourceSession } from "./data-source-session.ts"

const TEST_PATH = "/tmp/data-source-session.test.json"

const SESSION: FileDataSourceSession = {
  fileName: "accounts.csv",
  content: "name,balance\nBrokerage,50000.00\n",
  lastLoadedAt: "2026-09-21T00:00:00.000Z",
  transactions: null,
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

  it("returns null (never throws) for malformed JSON", () => {
    writeFileSync(TEST_PATH, "{ not json")
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("returns null when fileName is missing", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ content: SESSION.content, lastLoadedAt: SESSION.lastLoadedAt }))
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("returns null when content is missing", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ fileName: SESSION.fileName, lastLoadedAt: SESSION.lastLoadedAt }))
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("returns null when lastLoadedAt isn't a string", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ fileName: SESSION.fileName, content: SESSION.content, lastLoadedAt: null }))
    expect(loadFileDataSourceSession(TEST_PATH)).toBeNull()
  })

  it("loads a real transactions sub-object", () => {
    const withTransactions: FileDataSourceSession = { ...SESSION, transactions: { fileName: "transactions.csv", content: "Date,Category_Group,Category,Amount\n2026-09-01,Bills,Rent,-1500.00\n" } }
    writeFileSync(TEST_PATH, JSON.stringify(withTransactions))
    expect(loadFileDataSourceSession(TEST_PATH)).toEqual(withTransactions)
  })

  it("treats an absent transactions field as null -- a session written before this field existed", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ fileName: SESSION.fileName, content: SESSION.content, lastLoadedAt: SESSION.lastLoadedAt }))
    expect(loadFileDataSourceSession(TEST_PATH)).toEqual(SESSION)
  })

  it("returns null when transactions is present but malformed", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ fileName: SESSION.fileName, content: SESSION.content, lastLoadedAt: SESSION.lastLoadedAt, transactions: { fileName: "t.csv" } }))
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
