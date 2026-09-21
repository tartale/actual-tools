import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileParseError, accountIdFromName, fileAccountDataSource, parseAccountRows } from "./file-account-data-source.ts"

describe("accountIdFromName", () => {
  it("lowercases and hyphenates a real account name", () => {
    expect(accountIdFromName("Fidelity 401k")).toBe("fidelity-401k")
  })

  it("collapses punctuation/whitespace runs into a single hyphen, trimmed at both ends", () => {
    expect(accountIdFromName("  Smith, John's IRA!!  ")).toBe("smith-john-s-ira")
  })

  it("is deterministic -- the same name always derives the same id", () => {
    expect(accountIdFromName("Ally Money Market")).toBe(accountIdFromName("Ally Money Market"))
  })

  it("falls back to a non-empty placeholder for a name with no alphanumeric characters at all", () => {
    expect(accountIdFromName("!!!")).toBe("account")
  })
})

describe("parseAccountRows", () => {
  it("parses a valid CSV with a header row", () => {
    expect(parseAccountRows("name,balance\nBrokerage,50000.00\n401k,100000\n", ",")).toEqual([
      { name: "Brokerage", balance: 50000_00 },
      { name: "401k", balance: 100000_00 },
    ])
  })

  it("parses a valid TSV the same way, just tab-delimited", () => {
    expect(parseAccountRows("name\tbalance\nBrokerage\t50000.00\n", "\t")).toEqual([{ name: "Brokerage", balance: 50000_00 }])
  })

  it("honors double-quoted fields containing the delimiter itself", () => {
    expect(parseAccountRows('name,balance\n"Smith, John\'s IRA",50000.00\n', ",")).toEqual([{ name: "Smith, John's IRA", balance: 50000_00 }])
  })

  it("rejects an empty file", () => {
    expect(() => parseAccountRows("", ",")).toThrow(FileParseError)
    expect(() => parseAccountRows("   \n  \n", ",")).toThrow(FileParseError)
  })

  it("rejects a file with the wrong header", () => {
    expect(() => parseAccountRows("account,amount\nBrokerage,50000\n", ",")).toThrow(/Expected a header row/)
  })

  it("rejects a row with the wrong number of columns", () => {
    expect(() => parseAccountRows("name,balance\nBrokerage,50000,extra\n", ",")).toThrow(/expected 2 columns/)
  })

  it("rejects a row with an empty name", () => {
    expect(() => parseAccountRows("name,balance\n,50000\n", ",")).toThrow(/name is empty/)
  })

  it("rejects a non-numeric or dollar-formatted balance -- strict schema, same plain-decimal convention as this app's own CLI input", () => {
    expect(() => parseAccountRows("name,balance\nBrokerage,not-a-number\n", ",")).toThrow(/isn't a valid dollar amount/)
    expect(() => parseAccountRows("name,balance\nBrokerage,$50,000\n", ",")).toThrow(/isn't a valid dollar amount|expected 2 columns/)
  })

  it("rejects duplicate account names (case-insensitive) -- an account's id is derived from its name", () => {
    expect(() => parseAccountRows("name,balance\nBrokerage,50000\nbrokerage,60000\n", ",")).toThrow(/duplicate account name/)
  })
})

describe("fileAccountDataSource", () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-account-data-source-test-"))
    filePath = join(dir, "accounts.csv")
    writeFileSync(filePath, "name,balance\nBrokerage,50000.00\n401k,100000.00\n")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("fetchAccounts returns one Account per row, id derived from name, always offbudget and open", async () => {
    const accounts = await fileAccountDataSource(filePath).fetchAccounts()
    expect(accounts).toEqual([
      { id: "brokerage", name: "Brokerage", offbudget: true, closed: false },
      { id: "401k", name: "401k", offbudget: true, closed: false },
    ])
  })

  it("fetchAccountBalance returns the matching row's balance", async () => {
    const dataSource = fileAccountDataSource(filePath)
    expect(await dataSource.fetchAccountBalance("brokerage")).toBe(50000_00)
    expect(await dataSource.fetchAccountBalance("401k")).toBe(100000_00)
  })

  it("fetchAccountBalance rejects an id with no matching row", async () => {
    await expect(fileAccountDataSource(filePath).fetchAccountBalance("nonexistent")).rejects.toThrow(/No account with id/)
  })

  it("fetchAccountHistory always returns empty -- no transaction ledger for a file source", async () => {
    const history = await fileAccountDataSource(filePath).fetchAccountHistory(["brokerage"], 55)
    expect(history).toEqual({ historicalAges: [], balancesByAgeAndAccount: new Map() })
  })

  it("reads the file only once per instance -- concurrent fetchAccountBalance calls share one parse", async () => {
    const dataSource = fileAccountDataSource(filePath)
    const [a, b] = await Promise.all([dataSource.fetchAccountBalance("brokerage"), dataSource.fetchAccountBalance("401k")])
    expect(a).toBe(50000_00)
    expect(b).toBe(100000_00)
    // Mutating the file after the first read shouldn't change what this SAME instance reports --
    // proves the cache is real, not just "happened to only read once in this particular test."
    writeFileSync(filePath, "name,balance\nBrokerage,999999.00\n")
    expect(await dataSource.fetchAccountBalance("brokerage")).toBe(50000_00)
  })
})
