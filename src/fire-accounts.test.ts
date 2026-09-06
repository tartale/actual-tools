import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }))

import { readFileSync, writeFileSync } from "node:fs"

import {
  ACCOUNT_TYPE_TRAITS,
  ACCOUNT_TYPES,
  annualContributionLimit,
  classifyAccounts,
  classifyByHeuristic,
  combinedAnnualAdditionsLimit,
  computeEmployerContribution,
  contributionLimitLines,
  DEFAULT_PLAN_TO_AGE,
  employerContributionSummary,
  findOverride,
  FIRE_ACCOUNT_CATEGORIES,
  isPortfolioCategory,
  loadClassifiedAccounts,
  loadFireConfig,
  MONTE_CARLO_ALLOCATION_PRESETS,
  overrideIndexFor,
  portfolioAccounts,
  pruneStaleOverrides,
  resolveMonthlyContributions,
  writeFireConfig,
} from "./fire-accounts.ts"
import type { ClassifiedAccount, FireConfig } from "./fire-accounts.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import type { IrsLimits } from "./irs-limits.ts"

const config: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }

const IRS_LIMITS: IrsLimits = {
  taxYear: 2026,
  source: "test fixture",
  employerPlan: { standard: 2450000, catchUp50: 800000, catchUp60to63: 1125000, annualAdditions: 7200000 },
  ira: { standard: 750000, catchUp50: 110000 },
  hsa: { selfOnly: 440000, family: 875000, catchUp55: 100000 },
}

// Function to build a full, valid FireConfig from just its accounts -- most tests only care about
// account-matching/classification behavior, not the plan-wide section.
function fireConfig(accounts: FireConfig["accounts"]): FireConfig {
  return {
    version: 1,
    accounts,
    dashboard: { birthDate: null, retirementAges: [], planToAge: DEFAULT_PLAN_TO_AGE },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("classifyByHeuristic", () => {
  it("recognizes hsa accounts", () => {
    expect(classifyByHeuristic("Fidelity HSA")).toBe("hsa")
    expect(classifyByHeuristic("Health Savings Account")).toBe("hsa")
  })

  it("recognizes an inherited/beneficiary IRA before the generic IRA pattern", () => {
    for (const name of ["Fidelity IRA BDA", "Beneficiary IRA", "Inherited IRA from Mom"]) {
      expect(classifyByHeuristic(name)).toBe("inherited-ira")
    }
  })

  it("recognizes roth accounts, split by employer-plan vs. IRA", () => {
    expect(classifyByHeuristic("E*Trade Roth IRA")).toBe("roth-ira")
    expect(classifyByHeuristic("Roth 401k")).toBe("roth-401k")
  })

  it("recognizes traditional employer plans", () => {
    for (const name of ["Fidelity 401k", "Company 403b", "Deferred 457", "Federal TSP", "State Pension"]) {
      expect(classifyByHeuristic(name)).toBe("traditional-401k")
    }
  })

  it("recognizes a traditional IRA", () => {
    expect(classifyByHeuristic("Traditional IRA")).toBe("traditional-ira")
  })

  it("recognizes debt accounts", () => {
    for (const name of ["Prince Circle Mortgage", "Car Loan", "Chase Credit Card", "HELOC", "Line of Credit"]) {
      expect(classifyByHeuristic(name)).toBe("debt")
    }
  })

  it("recognizes taxable brokerage accounts", () => {
    for (const name of ["E*Trade Investment Account", "Vanguard Brokerage", "Taxable Account"]) {
      expect(classifyByHeuristic(name)).toBe("brokerage")
    }
  })

  it("recognizes a high-yield savings account or money market as its own type, before the broader brokerage pattern", () => {
    for (const name of ["Ally Money Market", "Marcus HYSA", "High-Yield Savings"]) {
      expect(classifyByHeuristic(name)).toBe("savings")
    }
  })

  it("does not classify a bare 'savings' account as the investment-like savings type", () => {
    expect(classifyByHeuristic("Ally Savings")).toBeNull()
  })

  it("is case-insensitive", () => {
    expect(classifyByHeuristic("fidelity hsa")).toBe("hsa")
  })

  it("returns null for an ordinary checking/savings account", () => {
    expect(classifyByHeuristic("Ally Checking")).toBeNull()
    expect(classifyByHeuristic("")).toBeNull()
  })
})

describe("findOverride", () => {
  const account = { id: "acct-1", name: "My Weird Nickname" }
  const cfg = { accounts: [{ match: "acct-1", type: "brokerage" }, { match: "Other Account", type: "debt" }] } as Pick<FireConfig, "accounts">

  it("matches by account id", () => {
    expect(findOverride(account, cfg)?.type).toBe("brokerage")
  })

  it("matches by exact account name", () => {
    expect(findOverride({ id: "acct-2", name: "Other Account" }, cfg)?.type).toBe("debt")
  })

  it("returns null when nothing matches", () => {
    expect(findOverride({ id: "acct-3", name: "Unrelated" }, cfg)).toBeNull()
  })
})

describe("classifyAccounts", () => {
  it("prefers an override over the heuristic", () => {
    const accounts = [{ id: "acct-1", name: "Fidelity 401k", offbudget: true }]
    const cfg = { accounts: [{ match: "acct-1", type: "brokerage", taxTreatment: "taxable" }] } as Pick<FireConfig, "accounts">
    const [result] = classifyAccounts(accounts, cfg)
    expect(result).toMatchObject({ type: "brokerage", category: "investment-taxable", taxTreatment: "taxable", source: "override" })
  })

  it("falls back to the heuristic when there's no override", () => {
    const accounts = [{ id: "acct-1", name: "E*Trade Roth IRA", offbudget: true }]
    const [result] = classifyAccounts(accounts, { accounts: [] })
    expect(result).toMatchObject({ type: "roth-ira", category: "retirement-roth", source: "heuristic" })
  })

  it("falls back to 'other' when nothing matches, flagged as a default", () => {
    const accounts = [{ id: "acct-1", name: "Ally Checking", offbudget: false }]
    const [result] = classifyAccounts(accounts, { accounts: [] })
    expect(result).toMatchObject({ type: "other", category: "other", taxTreatment: "none", accessAge: null, source: "default" })
  })

  it("passes through id/name/offbudget unchanged", () => {
    const accounts = [{ id: "acct-1", name: "Ally Checking", offbudget: false }]
    const [result] = classifyAccounts(accounts, { accounts: [] })
    expect(result).toMatchObject({ id: "acct-1", name: "Ally Checking", offbudget: false })
  })

  it("defaults an override's missing taxTreatment/accessAge/monthlyContribution to the type's own default", () => {
    const accounts = [{ id: "acct-1", name: "Whatever", offbudget: true }]
    const cfg = { accounts: [{ match: "acct-1", type: "debt" }] } as Pick<FireConfig, "accounts">
    const [result] = classifyAccounts(accounts, cfg)
    expect(result).toMatchObject({ taxTreatment: "none", accessAge: null, monthlyContribution: null })
  })

  it("carries an override's explicit monthlyContribution through", () => {
    const accounts = [{ id: "acct-1", name: "Whatever", offbudget: true }]
    const cfg = { accounts: [{ match: "acct-1", type: "brokerage", monthlyContribution: 50000 }] } as Pick<FireConfig, "accounts">
    const [result] = classifyAccounts(accounts, cfg)
    expect(result).toMatchObject({ monthlyContribution: 50000 })
  })

  it("has no monthlyContribution for a heuristic or default classification", () => {
    const accounts = [{ id: "acct-1", name: "E*Trade Roth IRA", offbudget: true }]
    const [result] = classifyAccounts(accounts, { accounts: [] })
    expect(result?.monthlyContribution).toBeNull()
  })

  it("gives an inherited IRA a null accessAge, not the category default", () => {
    const accounts = [{ id: "acct-1", name: "Whatever", offbudget: true }]
    const cfg = { accounts: [{ match: "acct-1", type: "inherited-ira" }] } as Pick<FireConfig, "accounts">
    const [result] = classifyAccounts(accounts, cfg)
    expect(result?.accessAge).toBeNull()
  })

  describe("legacy category-only overrides (no type field yet)", () => {
    it("guesses traditional-401k for a retirement-tax-deferred override with an employer-plan-shaped name", () => {
      const accounts = [{ id: "acct-1", name: "Fidelity 401k", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", category: "retirement-tax-deferred" }] } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.type).toBe("traditional-401k")
    })

    it("guesses traditional-ira for a retirement-tax-deferred override with a bare IRA name", () => {
      const accounts = [{ id: "acct-1", name: "Traditional IRA", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", category: "retirement-tax-deferred" }] } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.type).toBe("traditional-ira")
    })

    it("guesses inherited-ira for a retirement-tax-deferred override named like a beneficiary IRA", () => {
      const accounts = [{ id: "acct-1", name: "Fidelity IRA BDA", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", category: "retirement-tax-deferred" }] } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.type).toBe("inherited-ira")
      expect(result?.accessAge).toBeNull()
    })

    // Regression guard: every real legacy override (from the old category-based configure) has
    // taxTreatment/accessAge written out explicitly -- every account got these two fields
    // regardless of customization, since the old configure computed and persisted them for every
    // account. Naively treating that as a deliberate override would leave a migrated inherited IRA
    // stuck at the stale accessAge: 59 forever, exactly defeating the point of the new type.
    it("ignores a legacy override's stale explicit accessAge/taxTreatment when guessing inherited-ira", () => {
      const accounts = [{ id: "acct-1", name: "Fidelity IRA BDA", offbudget: true }]
      const cfg = {
        accounts: [{ match: "acct-1", category: "retirement-tax-deferred", taxTreatment: "tax-deferred", accessAge: 59, allocationPreset: "equity-80" }],
      } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.type).toBe("inherited-ira")
      expect(result?.accessAge).toBeNull()
    })

    it("still honors a real per-account override's accessAge once it carries a type (not legacy)", () => {
      const accounts = [{ id: "acct-1", name: "Whatever", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", type: "traditional-ira", accessAge: 55 }] } as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.accessAge).toBe(55)
    })

    it("guesses roth-ira vs. roth-401k for a retirement-roth override by name", () => {
      const iraAccounts = [{ id: "acct-1", name: "Schwab Roth IRA", offbudget: true }]
      const iraCfg = { accounts: [{ match: "acct-1", category: "retirement-roth" }] } as unknown as Pick<FireConfig, "accounts">
      expect(classifyAccounts(iraAccounts, iraCfg)[0]?.type).toBe("roth-ira")

      const planAccounts = [{ id: "acct-1", name: "Roth 401k", offbudget: true }]
      const planCfg = { accounts: [{ match: "acct-1", category: "retirement-roth" }] } as unknown as Pick<FireConfig, "accounts">
      expect(classifyAccounts(planAccounts, planCfg)[0]?.type).toBe("roth-401k")
    })

    it("maps hsa/investment-taxable/debt/cash/other straight across", () => {
      const cases: [string, string][] = [
        ["hsa", "hsa"],
        ["investment-taxable", "brokerage"],
        ["debt", "debt"],
        ["cash", "cash"],
        ["other", "other"],
      ]
      for (const [category, expectedType] of cases) {
        const accounts = [{ id: "acct-1", name: "Some Account", offbudget: true }]
        const cfg = { accounts: [{ match: "acct-1", category }] } as unknown as Pick<FireConfig, "accounts">
        expect(classifyAccounts(accounts, cfg)[0]?.type).toBe(expectedType)
      }
    })

    it("guesses savings instead of brokerage for an investment-taxable override with a money-market-shaped name", () => {
      const accounts = [{ id: "acct-1", name: "Ally Money Market", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", category: "investment-taxable" }] } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.type).toBe("savings")
      expect(result?.allocationPreset).toBe("cash")
    })

    it("still respects an explicit taxTreatment/accessAge override alongside a guessed type", () => {
      const accounts = [{ id: "acct-1", name: "E*Trade Investment Account", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", category: "investment-taxable", allocationPreset: "equity-100" }] } as unknown as Pick<
        FireConfig,
        "accounts"
      >
      const [result] = classifyAccounts(accounts, cfg)
      expect(result?.allocationPreset).toBe("equity-100")
    })
  })

  describe("resolving a \"max\" monthlyContribution", () => {
    it("resolves to null (not a number) when there's no birth date", () => {
      const accounts = [{ id: "acct-1", name: "401k", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", type: "traditional-401k", monthlyContribution: "max" }] } as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg, null, IRS_LIMITS)
      expect(result?.monthlyContribution).toBeNull()
    })

    it("resolves to the full annual limit divided by 12 when it's the only account in its group", () => {
      const accounts = [{ id: "acct-1", name: "401k", offbudget: true }]
      const cfg = { accounts: [{ match: "acct-1", type: "traditional-401k", monthlyContribution: "max" }] } as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg, "1980-01-01", IRS_LIMITS)
      expect(result?.monthlyContribution).toBe(Math.round(2450000 / 12))
    })

    it("subtracts an explicit sibling contribution in the same limit group before resolving max", () => {
      const accounts = [
        { id: "acct-1", name: "401k A", offbudget: true },
        { id: "acct-2", name: "401k B", offbudget: true },
      ]
      const cfg = {
        accounts: [
          { match: "acct-1", type: "traditional-401k", monthlyContribution: 100000 },
          { match: "acct-2", type: "traditional-401k", monthlyContribution: "max" },
        ],
      } as Pick<FireConfig, "accounts">
      const [, second] = classifyAccounts(accounts, cfg, "1980-01-01", IRS_LIMITS)
      expect(second?.monthlyContribution).toBe(Math.round((2450000 - 1200000) / 12))
    })

    it("does not let an IRA's max be affected by an employer-plan sibling's contribution", () => {
      const accounts = [
        { id: "acct-1", name: "401k", offbudget: true },
        { id: "acct-2", name: "IRA", offbudget: true },
      ]
      const cfg = {
        accounts: [
          { match: "acct-1", type: "traditional-401k", monthlyContribution: 500000 },
          { match: "acct-2", type: "traditional-ira", monthlyContribution: "max" },
        ],
      } as Pick<FireConfig, "accounts">
      const [, ira] = classifyAccounts(accounts, cfg, "1980-01-01", IRS_LIMITS)
      expect(ira?.monthlyContribution).toBe(Math.round(750000 / 12))
    })

    // Regression guard: a real bug found via live testing. A legacy (category-only) override's
    // `match` is usually an account id, not a name -- guessing its type straight from `match`
    // (rather than the real account name) silently mis-groups it, e.g. a legacy Roth IRA landing
    // in "employer-plan" instead of "ira" because an id string matches neither the IRA nor the
    // employer-plan name pattern and falls through to roth-401k's default.
    it("resolves \"max\" correctly for a legacy override whose match is an account id, not a name", () => {
      const accounts = [{ id: "47baec55-3cb7-4cbe-b95c-5d0cea767d1b", name: "E*Trade Roth IRA", offbudget: true }]
      const cfg = {
        accounts: [{ match: "47baec55-3cb7-4cbe-b95c-5d0cea767d1b", category: "retirement-roth", taxTreatment: "tax-free", accessAge: 59, monthlyContribution: "max" }],
      } as unknown as Pick<FireConfig, "accounts">
      const [result] = classifyAccounts(accounts, cfg, "1980-01-01", IRS_LIMITS)
      expect(result?.type).toBe("roth-ira")
      // The IRA limit ($7,500 base in this fixture), not the much larger employer-plan limit --
      // wrong grouping would silently return Math.round(2450000 / 12) instead.
      expect(result?.monthlyContribution).toBe(Math.round(750000 / 12))
    })
  })
})

describe("loadFireConfig", () => {
  it("returns an empty, fully-defaulted config, found: false, when the file doesn't exist", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })
    const result = loadFireConfig("/nonexistent/path/config.json")
    expect(result).toEqual({ config: fireConfig([]), found: false })
  })

  it("throws on malformed JSON", () => {
    vi.mocked(readFileSync).mockReturnValue("not json")
    expect(() => loadFireConfig("/fake/path")).toThrow("Invalid JSON")
  })

  it("throws when the shape doesn't match", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ foo: "bar" }))
    expect(() => loadFireConfig("/fake/path")).toThrow("Invalid config")
  })

  it("backfills defaults for an old-shape file missing the newer top-level sections", () => {
    const oldShapeConfig = { version: 1 as const, accounts: [{ match: "x", type: "debt" as const }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldShapeConfig))
    expect(loadFireConfig("/fake/path")).toEqual({ config: fireConfig(oldShapeConfig.accounts), found: true })
  })

  it("migrates birthDate/retirementAges/planToAge from their old flat top-level placement into dashboard", () => {
    const oldFlatShape = { version: 1 as const, accounts: [], birthDate: "1976-07-31", retirementAges: [55, 60], planToAge: 95 }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldFlatShape))
    const { config } = loadFireConfig("/fake/path")
    expect(config.dashboard).toEqual({ birthDate: "1976-07-31", retirementAges: [55, 60], planToAge: 95 })
  })

  it("prefers the new dashboard section over stale flat top-level fields when both are present", () => {
    const mixedShape = { version: 1 as const, accounts: [], birthDate: "1900-01-01", dashboard: { birthDate: "1976-07-31", retirementAges: [], planToAge: DEFAULT_PLAN_TO_AGE } }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mixedShape))
    const { config } = loadFireConfig("/fake/path")
    expect(config.dashboard.birthDate).toBe("1976-07-31")
  })

  it("returns the parsed config, found: true, when every section is already present", () => {
    const validConfig = fireConfig([{ match: "x", type: "debt" }])
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })

  it("accepts a legacy category-only override without throwing", () => {
    const legacyConfig = { version: 1, accounts: [{ match: "x", category: "debt" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(legacyConfig))
    expect(() => loadFireConfig("/fake/path")).not.toThrow()
  })

  it("throws when an override has neither type nor category", () => {
    const badConfig = { version: 1, accounts: [{ match: "x" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow("has neither type nor category")
  })

  it("throws on a type value that isn't a recognized AccountType", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", type: "bogus" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('unknown type "bogus"')
  })

  it("throws on a legacy category value that isn't (or is no longer) recognized", () => {
    const staleConfig = { version: 1, accounts: [{ match: "x", category: "cash-other" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(staleConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('unknown category "cash-other"')
  })

  it("throws on an unrecognized taxTreatment value", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", type: "debt", taxTreatment: "bogus" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('unknown taxTreatment "bogus"')
  })

  it("throws on an unrecognized allocationPreset value", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", type: "brokerage", allocationPreset: "bogus" }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('unknown allocationPreset "bogus"')
  })

  it("accepts a null allocationPreset", () => {
    const validConfig = fireConfig([{ match: "x", type: "debt", allocationPreset: null }])
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })

  it("accepts the \"max\" sentinel for monthlyContribution", () => {
    const validConfig = fireConfig([{ match: "x", type: "traditional-401k", monthlyContribution: "max" }])
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })

  it("throws on a monthlyContribution that's neither a positive number nor \"max\"", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", type: "brokerage", monthlyContribution: 0 }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('monthlyContribution for "x" must be a positive number or "max"')
  })

  it("throws on a non-positive ruleOf55SeparationAge", () => {
    const badConfig = { version: 1, accounts: [{ match: "x", type: "traditional-401k", ruleOf55SeparationAge: 0 }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow('ruleOf55SeparationAge for "x" must be a positive number')
  })

  it("accepts a null ruleOf55SeparationAge", () => {
    const validConfig = fireConfig([{ match: "x", type: "traditional-401k", ruleOf55SeparationAge: null }])
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig))
    expect(loadFireConfig("/fake/path")).toEqual({ config: validConfig, found: true })
  })

  it("throws on a non-positive retirementAges entry", () => {
    const badConfig = { version: 1, accounts: [], retirementAges: [0] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow("retirementAges must be an array of positive numbers")
  })

  it("throws on a non-positive planToAge", () => {
    const badConfig = { version: 1, accounts: [], planToAge: -5 }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(badConfig))
    expect(() => loadFireConfig("/fake/path")).toThrow("planToAge must be a positive number")
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

    const result = await loadClassifiedAccounts(config, "/fake/config.json")
    expect(result.configFound).toBe(false)
    expect(result.accounts).toEqual([
      {
        id: "a1",
        name: "Fidelity 401k",
        offbudget: true,
        type: "traditional-401k",
        category: "retirement-tax-deferred",
        taxTreatment: "tax-deferred",
        accessAge: 59,
        allocationPreset: "equity-80",
        monthlyContribution: null,
        ruleOf55SeparationAge: null,
        annualSalary: null,
        employerMatchRate: null,
        employerMatchCapRate: null,
        hsaCoverage: null,
        mortgageInterestRate: null,
        mortgageMonthlyPayment: null,
        mortgageBalanceAsOfDate: null,
        mortgageBalanceAsOf: null,
        source: "heuristic",
      },
    ])
  })
})

describe("ACCOUNT_TYPE_TRAITS", () => {
  it("has an entry in ACCOUNT_TYPE_TRAITS for every AccountType", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(ACCOUNT_TYPE_TRAITS[type]).toBeDefined()
    }
  })

  it("gives an inherited IRA a null accessAge and no contribution limit", () => {
    expect(ACCOUNT_TYPE_TRAITS["inherited-ira"].accessAge).toBeNull()
    expect(ACCOUNT_TYPE_TRAITS["inherited-ira"].limitGroup).toBeNull()
  })

  it("gives savings (HYSA/money market) a taxable, portfolio-eligible, unrestricted, cash-default entry", () => {
    expect(ACCOUNT_TYPE_TRAITS.savings).toMatchObject({
      category: "investment-taxable",
      taxTreatment: "taxable",
      accessAge: null,
      allocationPreset: "cash",
      ruleOf55Eligible: false,
      limitGroup: null,
    })
  })

  it("marks Rule of 55 eligible only for the two employer-plan types", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(ACCOUNT_TYPE_TRAITS[type].ruleOf55Eligible).toBe(type === "traditional-401k" || type === "roth-401k")
    }
  })

  it("shares one limit group between the two employer-plan types, and between the two IRA types", () => {
    expect(ACCOUNT_TYPE_TRAITS["traditional-401k"].limitGroup).toBe("employer-plan")
    expect(ACCOUNT_TYPE_TRAITS["roth-401k"].limitGroup).toBe("employer-plan")
    expect(ACCOUNT_TYPE_TRAITS["traditional-ira"].limitGroup).toBe("ira")
    expect(ACCOUNT_TYPE_TRAITS["roth-ira"].limitGroup).toBe("ira")
  })
})

describe("annualContributionLimit", () => {
  it("uses the standard employer-plan limit under 50", () => {
    expect(annualContributionLimit("employer-plan", 40, IRS_LIMITS)).toBe(2450000)
  })

  it("adds the 50-59-or-64+ catch-up for the employer plan", () => {
    expect(annualContributionLimit("employer-plan", 55, IRS_LIMITS)).toBe(2450000 + 800000)
    expect(annualContributionLimit("employer-plan", 64, IRS_LIMITS)).toBe(2450000 + 800000)
  })

  it("uses the larger 60-63 catch-up for the employer plan, not the 50+ one", () => {
    expect(annualContributionLimit("employer-plan", 61, IRS_LIMITS)).toBe(2450000 + 1125000)
  })

  it("uses the standard IRA limit under 50, and adds the catch-up at 50+", () => {
    expect(annualContributionLimit("ira", 40, IRS_LIMITS)).toBe(750000)
    expect(annualContributionLimit("ira", 50, IRS_LIMITS)).toBe(750000 + 110000)
  })

  it("uses the self-only HSA limit by default, adding the 55+ catch-up", () => {
    expect(annualContributionLimit("hsa", 40, IRS_LIMITS)).toBe(440000)
    expect(annualContributionLimit("hsa", 55, IRS_LIMITS)).toBe(440000 + 100000)
  })

  it("uses the family HSA limit when coverage is family", () => {
    expect(annualContributionLimit("hsa", 40, IRS_LIMITS, "family")).toBe(875000)
    expect(annualContributionLimit("hsa", 55, IRS_LIMITS, "family")).toBe(875000 + 100000)
  })
})

describe("combinedAnnualAdditionsLimit", () => {
  it("uses the standard 415(c) limit under 50", () => {
    expect(combinedAnnualAdditionsLimit(40, IRS_LIMITS)).toBe(7200000)
  })

  it("adds the same 50-59-or-64+ catch-up dollar amount as the elective-deferral limit", () => {
    expect(combinedAnnualAdditionsLimit(55, IRS_LIMITS)).toBe(7200000 + 800000)
    expect(combinedAnnualAdditionsLimit(64, IRS_LIMITS)).toBe(7200000 + 800000)
  })

  it("uses the larger 60-63 catch-up, not the 50+ one", () => {
    expect(combinedAnnualAdditionsLimit(61, IRS_LIMITS)).toBe(7200000 + 1125000)
  })
})

describe("computeEmployerContribution", () => {
  it("matches dollar-for-dollar up to the cap when the employee contributes at least that much", () => {
    // $150,000 salary, 100% match up to 4% of pay -> employer contributes up to $6,000/yr.
    expect(computeEmployerContribution(15000000, 1.0, 0.04, 1000000)).toBe(600000)
  })

  it("matches only the employee's actual contribution when it's below the cap", () => {
    // Same plan, but the employee only put in $3,000 -- employer matches that $3,000, not the $6,000 cap.
    expect(computeEmployerContribution(15000000, 1.0, 0.04, 300000)).toBe(300000)
  })

  it("applies a partial match rate", () => {
    // 50% match up to 6% of a $100,000 salary -- cap is $6,000, employee contributes $8,000 (above cap).
    expect(computeEmployerContribution(10000000, 0.5, 0.06, 800000)).toBe(300000)
  })

  it("returns 0, not null, when any input is missing", () => {
    expect(computeEmployerContribution(null, 1.0, 0.04, 500000)).toBe(0)
    expect(computeEmployerContribution(15000000, null, 0.04, 500000)).toBe(0)
    expect(computeEmployerContribution(15000000, 1.0, null, 500000)).toBe(0)
  })
})

describe("employerContributionSummary", () => {
  it("returns null when salary/match info isn't entered", () => {
    const account = { annualSalary: null, employerMatchRate: null, employerMatchCapRate: null, monthlyContribution: 200000 }
    expect(employerContributionSummary(account, 40, IRS_LIMITS)).toBeNull()
  })

  it("combines employee and employer contributions against the 415(c) limit", () => {
    const account = { annualSalary: 15000000, employerMatchRate: 1.0, employerMatchCapRate: 0.04, monthlyContribution: 204167 }
    const summary = employerContributionSummary(account, 40, IRS_LIMITS)
    expect(summary?.employerAnnualContribution).toBe(600000)
    expect(summary?.combinedAnnual).toBe(204167 * 12 + 600000)
    expect(summary?.combinedLimit).toBe(7200000)
    expect(summary?.exceedsLimit).toBe(false)
  })

  it("flags when the combined total exceeds the 415(c) limit", () => {
    // An extreme, deliberately unrealistic case just to exercise the flag: a 100% match up to
    // 100% of a $500,000 salary, with the employee contributing $60,000/yr -- $60,000 employee +
    // $60,000 employer = $120,000, well past the $72,000 combined limit at this age.
    const account = { annualSalary: 50000000, employerMatchRate: 1.0, employerMatchCapRate: 1.0, monthlyContribution: 500000 }
    const summary = employerContributionSummary(account, 40, IRS_LIMITS)
    expect(summary?.exceedsLimit).toBe(true)
  })
})

describe("resolveMonthlyContributions", () => {
  it("resolves an explicit contribution unchanged", () => {
    const overrides = [{ match: "a1", type: "brokerage" as const, monthlyContribution: 50000 }]
    expect(resolveMonthlyContributions(overrides, "1980-01-01", IRS_LIMITS)).toEqual(new Map([["a1", 50000]]))
  })

  it("omits an account with no contribution at all", () => {
    const overrides = [{ match: "a1", type: "brokerage" as const }]
    expect(resolveMonthlyContributions(overrides, "1980-01-01", IRS_LIMITS).has("a1")).toBe(false)
  })

  it("resolves \"max\" to nothing when birthDate or irsLimits is missing", () => {
    const overrides = [{ match: "a1", type: "traditional-401k" as const, monthlyContribution: "max" as const }]
    expect(resolveMonthlyContributions(overrides, null, IRS_LIMITS).has("a1")).toBe(false)
    expect(resolveMonthlyContributions(overrides, "1980-01-01", null).has("a1")).toBe(false)
  })

  it("gives a type with no limit group nothing for \"max\"", () => {
    const overrides = [{ match: "a1", type: "brokerage" as const, monthlyContribution: "max" as const }]
    expect(resolveMonthlyContributions(overrides, "1980-01-01", IRS_LIMITS).has("a1")).toBe(false)
  })
})

describe("contributionLimitLines", () => {
  it("returns nothing for a type with no limit group", () => {
    expect(contributionLimitLines("brokerage", IRS_LIMITS)).toEqual([])
    expect(contributionLimitLines("inherited-ira", IRS_LIMITS)).toEqual([])
  })

  it("returns nothing when irsLimits is unavailable", () => {
    expect(contributionLimitLines("roth-ira", null)).toEqual([])
  })

  it("formats a Roth IRA's two age tiers with matching annual and monthly figures", () => {
    const lines = contributionLimitLines("roth-ira", IRS_LIMITS)
    expect(lines).toEqual(["Roth IRA: $7,500.00/yr [$625.00/mo]", "Roth IRA age 50+: $8,600.00/yr [$716.67/mo]"])
  })

  it("formats an employer plan's three age tiers", () => {
    const lines = contributionLimitLines("traditional-401k", IRS_LIMITS)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("$24,500.00/yr")
    expect(lines[1]).toContain("age 50-59, 64+")
    expect(lines[2]).toContain("age 60-63")
  })

  it("defaults to the self-only HSA tier, and switches to family when asked", () => {
    const selfLines = contributionLimitLines("hsa", IRS_LIMITS)
    expect(selfLines[0]).toContain("(self-only)")
    expect(selfLines[0]).toContain("$4,400.00/yr")

    const familyLines = contributionLimitLines("hsa", IRS_LIMITS, "family")
    expect(familyLines[0]).toContain("(family)")
    expect(familyLines[0]).toContain("$8,750.00/yr")
  })
})

describe("writeFireConfig", () => {
  it("writes the config as pretty-printed JSON", () => {
    const written = fireConfig([{ match: "a1", type: "hsa" }])
    writeFireConfig("/fake/config.json", written)

    expect(writeFileSync).toHaveBeenCalledWith("/fake/config.json", `${JSON.stringify(written, null, 2)}\n`)
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
      type: "other",
      taxTreatment: "none",
      accessAge: null,
      allocationPreset: null,
      monthlyContribution: null,
      ruleOf55SeparationAge: null,
      annualSalary: null,
      employerMatchRate: null,
      employerMatchCapRate: null,
      hsaCoverage: null,
      mortgageInterestRate: null,
      mortgageMonthlyPayment: null,
      mortgageBalanceAsOfDate: null,
      mortgageBalanceAsOf: null,
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
  it("has an implied return/volatility entry for every type that uses it", () => {
    for (const type of ACCOUNT_TYPES) {
      const preset = ACCOUNT_TYPE_TRAITS[type].allocationPreset
      if (preset !== null) {
        expect(MONTE_CARLO_ALLOCATION_PRESETS).toContain(preset)
      }
    }
  })
})

describe("FIRE_ACCOUNT_CATEGORIES", () => {
  it("is the target of every AccountType's category mapping", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(FIRE_ACCOUNT_CATEGORIES).toContain(ACCOUNT_TYPE_TRAITS[type].category)
    }
  })
})

describe("overrideIndexFor", () => {
  const overrides = [
    { match: "id-1", type: "cash" as const },
    { match: "Fidelity 401k", type: "traditional-401k" as const },
  ]

  it("finds an override keyed by account id", () => {
    expect(overrideIndexFor(overrides, { id: "id-1", name: "Ally Checking" })).toBe(0)
  })

  it("finds an override keyed by exact account name", () => {
    expect(overrideIndexFor(overrides, { id: "id-2", name: "Fidelity 401k" })).toBe(1)
  })

  it("returns -1 for an account with no override", () => {
    expect(overrideIndexFor(overrides, { id: "id-3", name: "Nothing" })).toBe(-1)
  })

  // Regression guard: rewriting a name-keyed entry by id alone would append a duplicate that
  // findOverride never reaches, since it takes the first match.
  it("agrees with findOverride about which entry wins", () => {
    const account = { id: "id-2", name: "Fidelity 401k" }
    const index = overrideIndexFor(overrides, account)
    expect(overrides[index]).toBe(findOverride(account, { accounts: overrides }))
  })
})

describe("pruneStaleOverrides", () => {
  const overrides = [
    { match: "open-1", type: "cash" as const },
    { match: "closed-1", type: "debt" as const },
  ]

  it("drops overrides whose account is no longer open", () => {
    expect(pruneStaleOverrides(overrides, ["open-1"])).toEqual([{ match: "open-1", type: "cash" }])
  })

  it("keeps everything when every account is still open", () => {
    expect(pruneStaleOverrides(overrides, ["open-1", "closed-1"])).toEqual(overrides)
  })

  it("removes everything when no account is open, rather than silently keeping stale entries", () => {
    expect(pruneStaleOverrides(overrides, [])).toEqual([])
  })
})
