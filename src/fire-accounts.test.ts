import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }))

import { readFileSync, writeFileSync } from "node:fs"

import {
  CATEGORY_TRAITS,
  FIRE_ACCOUNT_CATEGORIES,
  MONTE_CARLO_ALLOCATION_PRESETS,
  classifyAccounts,
  classifyByHeuristic,
  findOverride,
  isPortfolioCategory,
  loadClassifiedAccounts,
  loadFireAccountsConfig,
  portfolioAccounts,
  traitsForCategory,
  writeFireAccountsConfig,
} from "./fire-accounts.ts"
import type { ClassifiedAccount, FireAccountsConfig } from "./fire-accounts.ts"
import type { ActualConfig } from "./actual-helpers.ts"

const config: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("classifyByHeuristic", () => {
  it("recognizes hsa accounts", () => {
    expect(classifyByHeuristic("Fidelity HSA")).toEqual({
      category: "hsa",
      taxTreatment: "tax-free",
      accessAge: null,
      allocationPreset: "equity-60",
    })
    expect(classifyByHeuristic("Health Savings Account")).toEqual({
      category: "hsa",
      taxTreatment: "tax-free",
      accessAge: null,
      allocationPreset: "equity-60",
    })
  })

  it("recognizes roth accounts", () => {
    expect(classifyByHeuristic("E*Trade Roth IRA")).toEqual({
      category: "retirement-roth",
      taxTreatment: "tax-free",
      accessAge: 59,
      allocationPreset: "equity-80",
    })
  })

  it("prefers roth over the broader 401k/ira rule when both could match", () => {
    expect(classifyByHeuristic("Roth 401k")?.category).toBe("retirement-roth")
  })

  it("recognizes tax-deferred retirement accounts", () => {
    for (const name of ["Fidelity 401k", "Company 403b", "Deferred 457", "Traditional IRA", "State Pension", "Federal TSP"]) {
      expect(classifyByHeuristic(name)).toEqual({
        category: "retirement-tax-deferred",
        taxTreatment: "tax-deferred",
        accessAge: 59,
        allocationPreset: "equity-80",
      })
    }
  })

  it("recognizes debt accounts", () => {
    for (const name of ["Prince Circle Mortgage", "Car Loan", "Chase Credit Card", "HELOC", "Line of Credit"]) {
      expect(classifyByHeuristic(name)).toEqual({ category: "debt", taxTreatment: "none", accessAge: null, allocationPreset: null })
    }
  })

  it("recognizes taxable investment accounts", () => {
    for (const name of ["E*Trade Investment Account", "Vanguard Brokerage", "Taxable Account"]) {
      expect(classifyByHeuristic(name)).toEqual({
        category: "investment-taxable",
        taxTreatment: "taxable",
        accessAge: null,
        allocationPreset: "equity-80",
      })
    }
  })

  it("is case-insensitive", () => {
    expect(classifyByHeuristic("fidelity hsa")?.category).toBe("hsa")
  })

  it("returns null for an ordinary checking/savings account", () => {
    expect(classifyByHeuristic("Ally Checking")).toBeNull()
    expect(classifyByHeuristic("")).toBeNull()
  })
})

describe("findOverride", () => {
  const account = { id: "acct-1", name: "My Weird Nickname" }
  const config: FireAccountsConfig = {
    version: 1,
    accounts: [{ match: "acct-1", category: "investment-taxable" }, { match: "Other Account", category: "debt" }],
  }

  it("matches by account id", () => {
    expect(findOverride(account, config)?.category).toBe("investment-taxable")
  })

  it("matches by exact account name", () => {
    expect(findOverride({ id: "acct-2", name: "Other Account" }, config)?.category).toBe("debt")
  })

  it("returns null when nothing matches", () => {
    expect(findOverride({ id: "acct-3", name: "Unrelated" }, config)).toBeNull()
  })
})

describe("classifyAccounts", () => {
  it("prefers an override over the heuristic", () => {
    const accounts = [{ id: "acct-1", name: "Fidelity 401k", offbudget: true }]
    const config: FireAccountsConfig = { version: 1, accounts: [{ match: "acct-1", category: "investment-taxable", taxTreatment: "taxable" }] }
    const [result] = classifyAccounts(accounts, config)
    expect(result).toMatchObject({ category: "investment-taxable", taxTreatment: "taxable", source: "override" })
  })

  it("falls back to the heuristic when there's no override", () => {
    const accounts = [{ id: "acct-1", name: "E*Trade Roth IRA", offbudget: true }]
    const [result] = classifyAccounts(accounts, { version: 1, accounts: [] })
    expect(result).toMatchObject({ category: "retirement-roth", source: "heuristic" })
  })

  it("falls back to 'other' when nothing matches, flagged as a default", () => {
    const accounts = [{ id: "acct-1", name: "Ally Checking", offbudget: false }]
    const [result] = classifyAccounts(accounts, { version: 1, accounts: [] })
    expect(result).toMatchObject({ category: "other", taxTreatment: "none", accessAge: null, source: "default" })
  })

  it("passes through id/name/offbudget unchanged", () => {
    const accounts = [{ id: "acct-1", name: "Ally Checking", offbudget: false }]
    const [result] = classifyAccounts(accounts, { version: 1, accounts: [] })
    expect(result).toMatchObject({ id: "acct-1", name: "Ally Checking", offbudget: false })
  })

  it("defaults an override's missing taxTreatment/accessAge to none/null", () => {
    const accounts = [{ id: "acct-1", name: "Whatever", offbudget: true }]
    const config: FireAccountsConfig = { version: 1, accounts: [{ match: "acct-1", category: "debt" }] }
    const [result] = classifyAccounts(accounts, config)
    expect(result).toMatchObject({ taxTreatment: "none", accessAge: null })
  })
})

describe("loadFireAccountsConfig", () => {
  it("returns an empty config, found: false, when the file doesn't exist", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })
    const result = loadFireAccountsConfig("/nonexistent/path/accounts.json")
    expect(result).toEqual({ config: { version: 1, accounts: [] }, found: false })
  })

  it("throws on malformed JSON", () => {
    vi.mocked(readFileSync).mockReturnValue("not json")
    expect(() => loadFireAccountsConfig("/fake/path")).toThrow("Invalid JSON")
  })

  it("throws when the shape doesn't match", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ foo: "bar" }))
    expect(() => loadFireAccountsConfig("/fake/path")).toThrow("Invalid accounts config")
  })

  it("returns the parsed config, found: true, when valid", () => {
    const validConfig = { version: 1, accounts: [{ match: "x", category: "debt" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireAccountsConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })

  it("throws on a category value that isn't (or is no longer) a recognized category", () => {
    // Guards against a config left over from before a category was renamed (e.g. the old
    // "taxable-investment"/"cash-other" before they became "investment-taxable"/"cash"/"other") --
    // an unrecognized category must fail loudly here, not silently break a consumer that assumes
    // every category is a real FIRE_ACCOUNT_CATEGORIES member.
    const staleConfig = { version: 1, accounts: [{ match: "x", category: "cash-other" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(staleConfig))
    expect(() => loadFireAccountsConfig("/fake/path")).toThrow('unknown category "cash-other"')
  })

  it("throws on an unrecognized taxTreatment value", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", category: "debt", taxTreatment: "bogus" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireAccountsConfig("/fake/path")).toThrow('unknown taxTreatment "bogus"')
  })

  it("throws on an unrecognized allocationPreset value", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", category: "investment-taxable", allocationPreset: "bogus" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireAccountsConfig("/fake/path")).toThrow('unknown allocationPreset "bogus"')
  })

  it("accepts a null allocationPreset", () => {
    const validConfig = { version: 1, accounts: [{ match: "x", category: "debt", allocationPreset: null }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireAccountsConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })
})

describe("loadClassifiedAccounts", () => {
  it("loads the config, fetches accounts, and classifies them", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "a1", name: "Fidelity 401k", offbudget: true, closed: false }] }),
    }))

    const result = await loadClassifiedAccounts(config, "/fake/accounts.json")
    expect(result.configFound).toBe(false)
    expect(result.accounts).toEqual([
      {
        id: "a1",
        name: "Fidelity 401k",
        offbudget: true,
        category: "retirement-tax-deferred",
        taxTreatment: "tax-deferred",
        accessAge: 59,
        allocationPreset: "equity-80",
        source: "heuristic",
      },
    ])
  })
})

describe("traitsForCategory", () => {
  it("returns the category alongside its default tax treatment, access age, and allocation preset", () => {
    expect(traitsForCategory("retirement-tax-deferred")).toEqual({
      category: "retirement-tax-deferred",
      taxTreatment: "tax-deferred",
      accessAge: 59,
      allocationPreset: "equity-80",
    })
    expect(traitsForCategory("cash")).toEqual({ category: "cash", taxTreatment: "none", accessAge: null, allocationPreset: null })
    expect(traitsForCategory("other")).toEqual({ category: "other", taxTreatment: "none", accessAge: null, allocationPreset: null })
  })

  it("has an entry in CATEGORY_TRAITS and FIRE_ACCOUNT_CATEGORIES for every category", () => {
    for (const category of FIRE_ACCOUNT_CATEGORIES) {
      expect(traitsForCategory(category).category).toBe(category)
      expect(CATEGORY_TRAITS[category]).toBeDefined()
    }
  })
})

describe("writeFireAccountsConfig", () => {
  it("writes the config as pretty-printed JSON", () => {
    const written: FireAccountsConfig = { version: 1, accounts: [{ match: "a1", category: "hsa" }] }
    writeFireAccountsConfig("/fake/accounts.json", written)

    expect(writeFileSync).toHaveBeenCalledWith("/fake/accounts.json", `${JSON.stringify(written, null, 2)}\n`)
  })
})

describe("isPortfolioCategory", () => {
  it("is true for retirement/HSA/taxable-investment categories", () => {
    for (const category of ["retirement-tax-deferred", "retirement-roth", "hsa", "investment-taxable"] as const) {
      expect(isPortfolioCategory(category)).toBe(true)
    }
  })

  it("is false for debt, cash, and other", () => {
    for (const category of ["debt", "cash", "other"] as const) {
      expect(isPortfolioCategory(category)).toBe(false)
    }
  })
})

describe("portfolioAccounts", () => {
  // Function to build a classified account with sensible defaults for the fields a test ignores
  function account(overrides: Partial<ClassifiedAccount> & Pick<ClassifiedAccount, "id" | "category">): ClassifiedAccount {
    return {
      name: "Some Account",
      offbudget: true,
      taxTreatment: "none",
      accessAge: null,
      allocationPreset: null,
      source: "heuristic",
      ...overrides,
    }
  }

  it("keeps only portfolio-category accounts", () => {
    const accounts = [
      account({ id: "a1", category: "retirement-tax-deferred" }),
      account({ id: "a2", category: "debt" }),
      account({ id: "a3", category: "investment-taxable" }),
      account({ id: "a4", category: "cash" }),
    ]
    expect(portfolioAccounts(accounts).map((a) => a.id)).toEqual(["a1", "a3"])
  })
})

describe("MONTE_CARLO_ALLOCATION_PRESETS", () => {
  it("has an implied return/volatility entry for every category that uses it", () => {
    for (const category of FIRE_ACCOUNT_CATEGORIES) {
      const preset = CATEGORY_TRAITS[category].allocationPreset
      if (preset !== null) {
        expect(MONTE_CARLO_ALLOCATION_PRESETS).toContain(preset)
      }
    }
  })
})
