import { describe, expect, it } from "vitest"

import { FileParseError, accountIdFromName, categoryGroupsFromTransactions, categoryIdFromName, fileAccountDataSource, parseAccountRows, parseTransactionRows, transactionCutoff } from "./file-account-data-source.ts"
import type { FileTransactionRow } from "./file-account-data-source.ts"

// Dates relative to "now" (not hardcoded) -- see fire-generate.test.ts's own monthsAgo for why.
function monthsAgo(n: number): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}

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
  const content = "name,balance\nBrokerage,50000.00\n401k,100000.00\n"

  it("fetchAccounts returns one Account per row, id derived from name, always offbudget and open", async () => {
    const accounts = await fileAccountDataSource("accounts.csv", content).fetchAccounts()
    expect(accounts).toEqual([
      { id: "brokerage", name: "Brokerage", offbudget: true, closed: false },
      { id: "401k", name: "401k", offbudget: true, closed: false },
    ])
  })

  it("fetchAccountBalance returns the matching row's balance", async () => {
    const dataSource = fileAccountDataSource("accounts.csv", content)
    expect(await dataSource.fetchAccountBalance("brokerage")).toBe(50000_00)
    expect(await dataSource.fetchAccountBalance("401k")).toBe(100000_00)
  })

  it("fetchAccountBalance rejects an id with no matching row", async () => {
    await expect(fileAccountDataSource("accounts.csv", content).fetchAccountBalance("nonexistent")).rejects.toThrow(/No account with id/)
  })

  it("fetchAccountHistory always returns empty -- no transaction ledger for a file source", async () => {
    const history = await fileAccountDataSource("accounts.csv", content).fetchAccountHistory(["brokerage"], 55)
    expect(history).toEqual({ historicalAges: [], balancesByAgeAndAccount: new Map() })
  })

  it("picks the delimiter from the file's own extension -- .tsv tab-delimited, anything else comma", async () => {
    const tsvSource = fileAccountDataSource("accounts.tsv", "name\tbalance\nBrokerage\t50000.00\n")
    expect(await tsvSource.fetchAccountBalance("brokerage")).toBe(50000_00)
  })
})

describe("parseTransactionRows", () => {
  // The real header row Actual's own export produces (confirmed 2026-09-21) -- Account/Payee/
  // Notes/Split_Amount/Cleared are all present but never read.
  const REAL_HEADER = "Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared"

  it("parses a real export shape, ignoring the columns it doesn't use", () => {
    const content = `${REAL_HEADER}\nChecking,2026-09-01,Landlord,,Bills,Rent,-1500.00,,Cleared\n`
    expect(parseTransactionRows(content, ",")).toEqual([{ date: "2026-09-01", categoryGroup: "Bills", category: "Rent", amount: -1500_00 }])
  })

  it("works with the required columns in a different order, and extra/missing optional ones", () => {
    expect(parseTransactionRows("Amount,Category,Category_Group,Date\n-50.00,Groceries,Food,2026-08-15\n", ",")).toEqual([
      { date: "2026-08-15", categoryGroup: "Food", category: "Groceries", amount: -50_00 },
    ])
  })

  it("parses TSV the same way", () => {
    expect(parseTransactionRows("Date\tCategory_Group\tCategory\tAmount\n2026-08-15\tFood\tGroceries\t-50.00\n", "\t")).toEqual([
      { date: "2026-08-15", categoryGroup: "Food", category: "Groceries", amount: -50_00 },
    ])
  })

  it("rejects a file missing a required column, naming which one(s)", () => {
    expect(() => parseTransactionRows("Date,Category,Amount\n2026-08-15,Groceries,-50.00\n", ",")).toThrow(/Missing required column.*Category_Group/)
  })

  it("rejects an empty file", () => {
    expect(() => parseTransactionRows("", ",")).toThrow(FileParseError)
  })

  it("rejects a row with an unrecognizable date", () => {
    expect(() => parseTransactionRows(`${REAL_HEADER}\nChecking,not-a-date,Landlord,,Bills,Rent,-1500.00,,Cleared\n`, ",")).toThrow(/isn't a recognizable date/)
  })

  it("allows an empty category -- a real export has these for uncategorized transactions/transfers", () => {
    // Reported live (2026-09-21) against a real export: an empty category threw and blocked the
    // whole file from importing, even though it's a normal, valid row.
    expect(parseTransactionRows(`${REAL_HEADER}\nChecking,2026-09-01,Landlord,,Bills,,-1500.00,,Cleared\n`, ",")).toEqual([{ date: "2026-09-01", categoryGroup: "Bills", category: "", amount: -1500_00 }])
  })

  it("rejects a row with a non-numeric amount", () => {
    expect(() => parseTransactionRows(`${REAL_HEADER}\nChecking,2026-09-01,Landlord,,Bills,Rent,not-a-number,,Cleared\n`, ",")).toThrow(/isn't a valid dollar amount/)
  })

  it("accepts a positive amount (income/refund row) same as a negative one", () => {
    expect(parseTransactionRows(`${REAL_HEADER}\nChecking,2026-09-01,Employer,,Income,Paycheck,5000.00,,Cleared\n`, ",")).toEqual([
      { date: "2026-09-01", categoryGroup: "Income", category: "Paycheck", amount: 5000_00 },
    ])
  })
})

describe("categoryGroupsFromTransactions", () => {
  it("builds one group per unique Category_Group, one category per unique (group, category) pair", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 }, // duplicate -- same category, not listed twice
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Phone", amount: -60_00 },
      { date: monthsAgo(1), categoryGroup: "Fun", category: "Movies", amount: -20_00 },
    ]
    const groups = categoryGroupsFromTransactions(rows, 12)
    expect(groups).toEqual([
      {
        id: "bills",
        name: "Bills",
        is_income: false,
        hidden: false,
        categories: [
          { id: categoryIdFromName("Bills", "Rent"), name: "Rent", is_income: false, hidden: false, group_id: "bills" },
          { id: categoryIdFromName("Bills", "Phone"), name: "Phone", is_income: false, hidden: false, group_id: "bills" },
        ],
      },
      { id: "fun", name: "Fun", is_income: false, hidden: false, categories: [{ id: categoryIdFromName("Fun", "Movies"), name: "Movies", is_income: false, hidden: false, group_id: "fun" }] },
    ])
  })

  it("skips rows with an empty Category_Group or Category -- transfers/split-parent rows, not real categories", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "", category: "", amount: -100_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "", amount: -100_00 },
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
    ]
    expect(categoryGroupsFromTransactions(rows, 12)).toEqual([{ id: "bills", name: "Bills", is_income: false, hidden: false, categories: [{ id: categoryIdFromName("Bills", "Rent"), name: "Rent", is_income: false, hidden: false, group_id: "bills" }] }])
  })

  it("marks an Income group is_income (case-insensitive)", () => {
    const groups = categoryGroupsFromTransactions([{ date: monthsAgo(1), categoryGroup: "income", category: "Paycheck", amount: 5000_00 }], 12)
    expect(groups[0]).toMatchObject({ is_income: true, categories: [expect.objectContaining({ is_income: true })] })
  })

  // Requested live (2026-09-21): a category with no activity in the trailing spend-history window
  // (an old one-off trip, a category no longer used) has nothing to contribute to the projection
  // either way, so it shouldn't show up as a pickable checkbox that looks live but isn't.
  it("excludes a category with no rows inside the trailing window", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
      { date: monthsAgo(24), categoryGroup: "Vacation 2024", category: "Hotel", amount: -800_00 }, // outside a 12-month window
    ]
    const groups = categoryGroupsFromTransactions(rows, 12)
    expect(groups.map((g) => g.name)).toEqual(["Bills"])
  })

  it("includes a category the moment any of its rows fall inside the window, even if others don't", () => {
    const rows: FileTransactionRow[] = [
      { date: monthsAgo(1), categoryGroup: "Bills", category: "Rent", amount: -1500_00 },
      { date: monthsAgo(24), categoryGroup: "Bills", category: "Rent", amount: -1500_00 }, // an older row for the SAME category
    ]
    expect(categoryGroupsFromTransactions(rows, 12).map((g) => g.name)).toEqual(["Bills"])
  })
})

describe("transactionCutoff", () => {
  it("is historyMonths before the start of the current calendar month", () => {
    const cutoff = transactionCutoff(3)
    const expected = new Date()
    expected.setUTCDate(1)
    expected.setUTCHours(0, 0, 0, 0)
    expected.setUTCMonth(expected.getUTCMonth() - 3)
    expect(cutoff.getTime()).toBe(expected.getTime())
  })
})
