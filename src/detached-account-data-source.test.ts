import { describe, expect, it } from "vitest"

import { detachedAccountDataSource } from "./detached-account-data-source.ts"

describe("detachedAccountDataSource", () => {
  const accounts = [
    { id: "a1", name: "Brokerage", balance: 5000000 },
    { id: "a2", name: "401k", balance: 10000000 },
  ]

  it("returns every account, marked offbudget/not closed the same way file mode's own accounts are", async () => {
    const source = detachedAccountDataSource(accounts)
    await expect(source.fetchAccounts()).resolves.toEqual([
      { id: "a1", name: "Brokerage", offbudget: true, closed: false },
      { id: "a2", name: "401k", offbudget: true, closed: false },
    ])
  })

  it("resolves a known account's own balance", async () => {
    const source = detachedAccountDataSource(accounts)
    await expect(source.fetchAccountBalance("a2")).resolves.toBe(10000000)
  })

  it("rejects an unknown account id", async () => {
    const source = detachedAccountDataSource(accounts)
    await expect(source.fetchAccountBalance("nope")).rejects.toThrow('No account with id "nope"')
  })

  it("has no trailing spend history for a made-up account -- always empty, never an error", async () => {
    const source = detachedAccountDataSource(accounts)
    await expect(source.fetchAccountHistory(["a1"], 50)).resolves.toEqual({ historicalAges: [], balancesByAgeAndAccount: new Map() })
  })

  it("works with an empty account list", async () => {
    const source = detachedAccountDataSource([])
    await expect(source.fetchAccounts()).resolves.toEqual([])
  })
})
