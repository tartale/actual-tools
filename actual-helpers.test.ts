import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addMonths,
  averageSpent,
  computeBalanceBudget,
  computeHistoricalBudget,
  fetchCategoryGroups,
  fetchMonthCategories,
  formatCategoryLine,
  formatUsd,
  getCachedMonthCategories,
  groupNameById,
  isAction,
  loadConfigFromEnv,
  monthRange,
  patchCategoryBudget,
  shouldUpdateCategory,
  validateMonthFormat,
} from "./actual-helpers.ts"
import type { ActualConfig, CategoryGroup, CategoryMonth } from "./actual-helpers.ts"

const config: ActualConfig = {
  baseUrl: "https://actual.test/v1",
  budgetId: "budget-1",
  apiKey: "secret-key",
}

// Function to build a category-month record with sensible defaults for the fields a test ignores
function categoryMonth(overrides: Partial<CategoryMonth> & Pick<CategoryMonth, "id">): CategoryMonth {
  return {
    name: "Groceries",
    is_income: false,
    hidden: false,
    group_id: "group-1",
    budgeted: 0,
    spent: 0,
    balance: 0,
    carryover: false,
    ...overrides,
  }
}

// Function to stub global fetch with a queue of JSON responses, returning the recorded calls
function stubFetch(responses: readonly { ok?: boolean; status?: number; body: unknown }[]): {
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let index = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const response = responses[Math.min(index++, responses.length - 1)]
    if (!response) {
      throw new Error(`No stubbed response for ${url}`)
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    }
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("loadConfigFromEnv", () => {
  it("returns the config when every variable is set", () => {
    expect(loadConfigFromEnv({ BASE_URL: "https://a/v1", BUDGET_ID: "b", API_KEY: "k" })).toEqual({
      baseUrl: "https://a/v1",
      budgetId: "b",
      apiKey: "k",
    })
  })

  it("throws when a variable is missing", () => {
    expect(() => loadConfigFromEnv({ BASE_URL: "https://a/v1", BUDGET_ID: "b" })).toThrow(
      "Environment variables BASE_URL, BUDGET_ID, and API_KEY must be set.",
    )
  })
})

describe("formatUsd", () => {
  it("formats positive, negative and zero amounts", () => {
    expect(formatUsd(415295)).toBe("$4152.95")
    expect(formatUsd(-415295)).toBe("-$4152.95")
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(5)).toBe("$0.05")
    expect(formatUsd(-5)).toBe("-$0.05")
  })
})

describe("validateMonthFormat", () => {
  it("accepts yyyy-mm", () => {
    expect(() => validateMonthFormat("2026-08")).not.toThrow()
  })

  it("rejects anything else", () => {
    for (const bad of ["2026-8", "26-08", "2026/08", "2026-08-01", ""]) {
      expect(() => validateMonthFormat(bad)).toThrow(`Invalid month format: ${bad}`)
    }
  })
})

describe("addMonths", () => {
  it("shifts forward and backward", () => {
    expect(addMonths("2026-08", 1)).toBe("2026-09")
    expect(addMonths("2026-08", -1)).toBe("2026-07")
    expect(addMonths("2026-08", 0)).toBe("2026-08")
  })

  it("wraps around year boundaries", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01")
    expect(addMonths("2026-01", -1)).toBe("2025-12")
    expect(addMonths("2026-01", -12)).toBe("2025-01")
    expect(addMonths("2026-03", 12)).toBe("2027-03")
  })
})

describe("monthRange", () => {
  it("enumerates forward", () => {
    expect(monthRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"])
  })

  it("enumerates backward", () => {
    expect(monthRange("2026-02", "2025-12")).toEqual(["2026-02", "2026-01", "2025-12"])
  })

  it("handles a single month", () => {
    expect(monthRange("2026-08", "2026-08")).toEqual(["2026-08"])
  })
})

describe("isAction", () => {
  it("recognises the four supported actions", () => {
    for (const action of ["balance", "previous", "previous-3", "previous-12"]) {
      expect(isAction(action)).toBe(true)
    }
  })

  it("rejects everything else", () => {
    for (const bad of ["", "Balance", "previous-6", "zero"]) {
      expect(isAction(bad)).toBe(false)
    }
  })
})

describe("groupNameById", () => {
  it("indexes group names by id", () => {
    const groups = [
      { id: "g1", name: "Fixed", is_income: false, hidden: false, categories: [] },
      { id: "g2", name: "Variable", is_income: false, hidden: false, categories: [] },
    ] satisfies CategoryGroup[]
    expect(groupNameById(groups)).toEqual(
      new Map([
        ["g1", "Fixed"],
        ["g2", "Variable"],
      ]),
    )
  })
})

describe("shouldUpdateCategory", () => {
  const category = { id: "cat-1", name: "Groceries", group_id: "group-1" }
  const groupNames = new Map([["group-1", "Monthly Expenses"]])

  it("matches everything when no filters are given", () => {
    expect(shouldUpdateCategory(category, [], groupNames)).toBe(true)
  })

  it("matches by category id, category name, group id and group name", () => {
    for (const filter of ["cat-1", "Groceries", "group-1", "Monthly Expenses"]) {
      expect(shouldUpdateCategory(category, [filter], groupNames)).toBe(true)
    }
  })

  it("matches when any one of several filters matches", () => {
    expect(shouldUpdateCategory(category, ["Rent", "Groceries"], groupNames)).toBe(true)
  })

  it("does not match unrelated filters", () => {
    expect(shouldUpdateCategory(category, ["Rent"], groupNames)).toBe(false)
  })

  it("does not match a group name that is not indexed", () => {
    expect(shouldUpdateCategory(category, ["Monthly Expenses"], new Map())).toBe(false)
  })
})

describe("computeBalanceBudget", () => {
  it("zeroes a straightforward overspent category", () => {
    expect(computeBalanceBudget({ budgeted: 10000, spent: -12500, balance: -2500 } as CategoryMonth)).toBe(12500)
  })

  it("zeroes a carryover category whose balance is not budgeted + spent", () => {
    // carryover: balance carries $50.00 of rollover, so -spent alone would not zero it
    expect(computeBalanceBudget({ budgeted: 10000, spent: -12500, balance: 2500 } as CategoryMonth)).toBe(7500)
  })

  it("returns the current budget when the balance is already zero", () => {
    expect(computeBalanceBudget({ budgeted: 2799, spent: -2799, balance: 0 } as CategoryMonth)).toBe(2799)
  })
})

describe("averageSpent", () => {
  it("returns zero for no months", () => {
    expect(averageSpent([])).toBe(0)
  })

  it("sign-flips a single month's spending", () => {
    expect(averageSpent([-12500])).toBe(12500)
  })

  it("averages several months", () => {
    expect(averageSpent([-10000, -20000, -30000])).toBe(20000)
  })

  it("counts months with no spending as zero rather than shrinking the divisor", () => {
    expect(averageSpent([-30000, 0, 0])).toBe(10000)
  })

  it("rounds to whole cents", () => {
    expect(averageSpent([-10000, -10001])).toBe(10001)
    expect(averageSpent([-1, -1, 0])).toBe(1)
  })
})

describe("formatCategoryLine", () => {
  it("pads the status and amount columns", () => {
    expect(formatCategoryLine("2026-08", "Update applied", 12500, -2500, "Groceries")).toBe(
      "Update applied    ; month: 2026-08; budgeted = $125.00    ; balance = -$25.00    ; name: Groceries",
    )
  })

  it("keeps the columns aligned for the widest amounts", () => {
    expect(formatCategoryLine("2026-08", "Update not needed", -99999999, 99999999, "Rent")).toBe(
      "Update not needed ; month: 2026-08; budgeted = -$999999.99; balance = $999999.99 ; name: Rent",
    )
  })
})

describe("fetchCategoryGroups", () => {
  it("sends the api key and returns the group data", async () => {
    const groups = [{ id: "g1", name: "Fixed", is_income: false, hidden: false, categories: [] }]
    const { calls } = stubFetch([{ body: { data: groups } }])

    await expect(fetchCategoryGroups(config)).resolves.toEqual(groups)
    expect(calls[0]?.url).toBe("https://actual.test/v1/budgets/budget-1/categorygroups")
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("secret-key")
  })

  it("surfaces the api's error field", async () => {
    stubFetch([{ ok: false, status: 401, body: { error: "invalid api key" } }])
    await expect(fetchCategoryGroups(config)).rejects.toThrow("invalid api key")
  })

  it("falls back to the status code when there is no error field", async () => {
    stubFetch([{ ok: false, status: 500, body: null }])
    await expect(fetchCategoryGroups(config)).rejects.toThrow("HTTP 500")
  })

  it("rejects a response without a data array", async () => {
    stubFetch([{ body: { data: "nope" } }])
    await expect(fetchCategoryGroups(config)).rejects.toThrow("Unexpected response fetching category groups")
  })
})

describe("fetchMonthCategories", () => {
  it("requests the month's categories", async () => {
    const categories = [categoryMonth({ id: "cat-1", budgeted: 100 })]
    const { calls } = stubFetch([{ body: { data: categories } }])

    await expect(fetchMonthCategories(config, "2026-08")).resolves.toEqual(categories)
    expect(calls[0]?.url).toBe("https://actual.test/v1/budgets/budget-1/months/2026-08/categories")
  })

  it("names the month in its error", async () => {
    stubFetch([{ body: { nope: true } }])
    await expect(fetchMonthCategories(config, "2026-08")).rejects.toThrow("categories for month 2026-08")
  })
})

describe("patchCategoryBudget", () => {
  it("patches the category with a json body", async () => {
    const { calls } = stubFetch([{ body: { data: {} } }])
    await patchCategoryBudget(config, "2026-08", "cat-1", 12500)

    expect(calls[0]?.url).toBe("https://actual.test/v1/budgets/budget-1/months/2026-08/categories/cat-1")
    expect(calls[0]?.init?.method).toBe("PATCH")
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ category: { budgeted: 12500 } })
  })

  it("surfaces the api's error field", async () => {
    stubFetch([{ ok: false, status: 400, body: { error: "bad month" } }])
    await expect(patchCategoryBudget(config, "2026-08", "cat-1", 1)).rejects.toThrow("bad month")
  })
})

describe("getCachedMonthCategories", () => {
  it("fetches once per month and serves later calls from the cache", async () => {
    const { calls } = stubFetch([{ body: { data: [categoryMonth({ id: "cat-1" })] } }])
    const cache = new Map<string, CategoryMonth[]>()

    const first = await getCachedMonthCategories(config, "2026-08", cache)
    const second = await getCachedMonthCategories(config, "2026-08", cache)

    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
  })
})

describe("computeHistoricalBudget", () => {
  it("averages the previous months' spending, skipping the target month itself", async () => {
    const byMonth: Record<string, CategoryMonth[]> = {
      "2026-07": [categoryMonth({ id: "cat-1", spent: -10000 })],
      "2026-06": [categoryMonth({ id: "cat-1", spent: -20000 })],
      "2026-05": [categoryMonth({ id: "cat-1", spent: -30000 })],
      "2026-08": [categoryMonth({ id: "cat-1", spent: -99999 })],
    }
    vi.stubGlobal("fetch", async (url: string) => {
      const month = url.split("/months/")[1]?.split("/")[0] as string
      return { ok: true, status: 200, json: async () => ({ data: byMonth[month] ?? [] }) }
    })

    const cache = new Map<string, CategoryMonth[]>()
    await expect(computeHistoricalBudget(config, "cat-1", "2026-08", 1, cache)).resolves.toBe(10000)
    await expect(computeHistoricalBudget(config, "cat-1", "2026-08", 3, cache)).resolves.toBe(20000)
  })

  it("treats a month without the category as zero spending", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
    const cache = new Map<string, CategoryMonth[]>()
    await expect(computeHistoricalBudget(config, "cat-1", "2026-08", 12, cache)).resolves.toBe(0)
    expect(cache.size).toBe(12)
  })
})
