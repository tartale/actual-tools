import { afterEach, describe, expect, it, vi } from "vitest"

import type { ActualConfig, CategoryMonth, Transaction } from "./actual-helpers.ts"
import { BUDGET_TABLE_MAX_MONTHS, fetchBudgetTable, findAnomalies, setBudgetValues, tagAnomalyFindings } from "./budget-tools.ts"
import type { AnomalyFinding } from "./budget-tools.ts"

const config: ActualConfig = {
  baseUrl: "https://actual.test/v1",
  budgetId: "budget-1",
  apiKey: "secret-key",
}

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

function transaction(overrides: Partial<Transaction> & Pick<Transaction, "id">): Transaction {
  return {
    account: "a1",
    category: "c1",
    amount: 0,
    imported_payee: "Some Payee",
    notes: null,
    date: "2026-01-15",
    transfer_id: null,
    cleared: true,
    tombstone: false,
    ...overrides,
  }
}

// Same sequential-queue stub as actual-helpers.test.ts -- these functions call actualRequest under
// the hood, which every test here goes through for real (nothing here mocks budget-tools itself).
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

describe("setBudgetValues", () => {
  it("applies the balance action, zeroing out the month's balance", async () => {
    const { calls } = stubFetch([
      { body: { data: [categoryMonth({ id: "c1", budgeted: 10000, spent: -8000, balance: 2000 })] } },
      { body: {} },
    ])
    const results = await setBudgetValues(config, { action: "balance", startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: false })
    expect(results).toEqual([
      { month: "2026-01", lines: [{ month: "2026-01", categoryId: "c1", categoryName: "Groceries", status: "updated", oldBudgeted: 10000, newBudgeted: 8000, balance: 2000 }] },
    ])
    // categorygroups is skipped when no category filter is given -- just the month fetch + the write.
    expect(calls).toHaveLength(2)
  })

  it("reports would-update without writing anything in dry-run mode", async () => {
    const { calls } = stubFetch([{ body: { data: [categoryMonth({ id: "c1", budgeted: 5000 })] } }])
    const results = await setBudgetValues(config, { action: 12345, startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: true })
    expect(results[0]?.lines[0]).toMatchObject({ status: "would-update", newBudgeted: 12345 })
    expect(calls).toHaveLength(1)
  })

  it("leaves a category alone when the computed amount matches what's already budgeted", async () => {
    stubFetch([{ body: { data: [categoryMonth({ id: "c1", budgeted: 12345 })] } }])
    const results = await setBudgetValues(config, { action: 12345, startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: false })
    expect(results[0]?.lines[0]?.status).toBe("unchanged")
  })

  it("skips a balance-action category with no activity at all", async () => {
    stubFetch([{ body: { data: [categoryMonth({ id: "c1", budgeted: 0, spent: 0, balance: 0 })] } }])
    const results = await setBudgetValues(config, { action: "balance", startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: false })
    expect(results[0]?.lines).toEqual([])
  })

  it("only touches categories matching the given filter", async () => {
    const { calls } = stubFetch([
      { body: { data: [{ id: "group-1", name: "Everyday", is_income: false, hidden: false, categories: [] }] } },
      { body: { data: [categoryMonth({ id: "c1", name: "Groceries", budgeted: 0 }), categoryMonth({ id: "c2", name: "Rent", budgeted: 0 })] } },
      { body: {} },
    ])
    const results = await setBudgetValues(config, { action: 500, startMonth: "2026-01", endMonth: "2026-01", categories: ["c1"], dryRun: false })
    expect(results[0]?.lines.map((l) => l.categoryId)).toEqual(["c1"])
    expect(calls).toHaveLength(3)
  })

  it("throws when a category filter matches an income category or group", async () => {
    stubFetch([{ body: { data: [{ id: "group-1", name: "Income", is_income: true, hidden: false, categories: [] }] } }])
    await expect(setBudgetValues(config, { action: 500, startMonth: "2026-01", endMonth: "2026-01", categories: ["Income"], dryRun: false })).rejects.toThrow(
      "never a valid update target",
    )
  })

  it("skips (and never writes) a line the confirm callback rejects", async () => {
    const { calls } = stubFetch([{ body: { data: [categoryMonth({ id: "c1", budgeted: 0 })] } }])
    const confirm = vi.fn(async () => false)
    const results = await setBudgetValues(config, { action: 500, startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: false, confirm })
    expect(results[0]?.lines[0]?.status).toBe("skipped")
    expect(confirm).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1) // no patch call
  })

  it("applies a line the confirm callback approves", async () => {
    stubFetch([{ body: { data: [categoryMonth({ id: "c1", budgeted: 0 })] } }, { body: {} }])
    const results = await setBudgetValues(config, { action: 500, startMonth: "2026-01", endMonth: "2026-01", categories: [], dryRun: false, confirm: async () => true })
    expect(results[0]?.lines[0]?.status).toBe("updated")
  })

  it("groups results by month, including a month with zero matching lines", async () => {
    stubFetch([
      { body: { data: [categoryMonth({ id: "c1", budgeted: 0, spent: 0, balance: 0 })] } },
      { body: { data: [categoryMonth({ id: "c1", budgeted: 0, spent: 0, balance: 0 })] } },
    ])
    const results = await setBudgetValues(config, { action: "balance", startMonth: "2026-01", endMonth: "2026-02", categories: [], dryRun: false })
    expect(results.map((r) => r.month)).toEqual(["2026-01", "2026-02"])
    expect(results[0]?.lines).toEqual([])
    expect(results[1]?.lines).toEqual([])
  })
})

const LOW_SPEND_MONTH = { body: { data: [categoryMonth({ id: "c1", spent: -10000 })] } }

describe("fetchBudgetTable", () => {
  it("groups categories under their group, excluding income entirely, with per-month figures", async () => {
    stubFetch([
      { body: { data: [categoryMonth({ id: "c1", name: "Groceries", budgeted: 50000, spent: -45000, balance: 5000 })] } },
      {
        body: {
          data: [
            { id: "g1", name: "Everyday", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] },
            { id: "g2", name: "Income", is_income: true, hidden: false, categories: [{ id: "c2", name: "Paycheck", is_income: true, hidden: false, group_id: "g2" }] },
          ],
        },
      },
    ])
    const table = await fetchBudgetTable(config, "2026-01", "2026-01")
    expect(table.months).toEqual(["2026-01"])
    expect(table.groups).toEqual([
      { id: "g1", name: "Everyday", categories: [{ id: "c1", name: "Groceries", months: { "2026-01": { budgeted: 50000, spent: -45000, balance: 5000 } } }] },
    ])
  })

  it("fills in a zeroed entry for a category missing from a given month's response", async () => {
    stubFetch([{ body: { data: [] } }, { body: { data: [{ id: "g1", name: "Everyday", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] }] } }])
    const table = await fetchBudgetTable(config, "2026-01", "2026-01")
    expect(table.groups[0]?.categories[0]?.months["2026-01"]).toEqual({ budgeted: 0, spent: 0, balance: 0 })
  })

  it("caps the number of month columns at BUDGET_TABLE_MAX_MONTHS, taken from the start of the range", async () => {
    const { calls } = stubFetch([{ body: { data: [] } }, { body: { data: [] } }])
    const table = await fetchBudgetTable(config, "2026-01", "2027-01") // 13 months requested
    expect(table.months).toHaveLength(BUDGET_TABLE_MAX_MONTHS)
    expect(table.months[0]).toBe("2026-01")
    // one getCachedMonthCategories call per rendered month, plus one for fetchCategoryGroups
    expect(calls).toHaveLength(BUDGET_TABLE_MAX_MONTHS + 1)
  })
})

describe("findAnomalies", () => {
  it("requires at least one category", async () => {
    await expect(findAnomalies(config, { categories: [], startMonth: "2026-01", endMonth: "2026-01" })).rejects.toThrow("At least one category")
  })

  it("throws when a category filter matches an income category or group", async () => {
    stubFetch([{ body: { data: [{ id: "group-1", name: "Income", is_income: true, hidden: false, categories: [] }] } }])
    await expect(findAnomalies(config, { categories: ["Income"], startMonth: "2026-01", endMonth: "2026-01" })).rejects.toThrow("never a valid target")
  })

  it("flags a month whose spend is a sharp, sustained jump over its own trailing history", async () => {
    stubFetch([
      { body: { data: [{ id: "group-1", name: "Everyday", is_income: false, hidden: false, categories: [] }] } },
      { body: { data: [categoryMonth({ id: "c1", name: "Groceries", spent: -100000 })] } }, // the scanned month itself
      LOW_SPEND_MONTH, // repeats for every trailing month lookup
    ])
    const findings = await findAnomalies(config, { categories: ["c1"], startMonth: "2026-01", endMonth: "2026-01" })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ month: "2026-01", direction: "high", spentCents: -100000, typicalCents: -10000 })
    expect(findings[0]?.category.id).toBe("c1")
  })

  it("stays quiet when spend is in line with history", async () => {
    stubFetch([
      { body: { data: [{ id: "group-1", name: "Everyday", is_income: false, hidden: false, categories: [] }] } },
      LOW_SPEND_MONTH,
      LOW_SPEND_MONTH,
    ])
    const findings = await findAnomalies(config, { categories: ["c1"], startMonth: "2026-01", endMonth: "2026-01" })
    expect(findings).toEqual([])
  })
})

describe("tagAnomalyFindings", () => {
  const finding: AnomalyFinding = {
    month: "2026-01",
    category: categoryMonth({ id: "c1", name: "Groceries" }),
    direction: "high",
    spentCents: -100000,
    typicalCents: -10000,
  }

  it("returns immediately with no fetch when there are no findings", async () => {
    const { calls } = stubFetch([])
    const results = await tagAnomalyFindings(config, [], "2026-01", false)
    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("reports no-transactions when nothing in that category/month exists", async () => {
    stubFetch([{ body: { data: [] } }, { body: { data: [] } }])
    const results = await tagAnomalyFindings(config, [finding], "2026-01", false)
    expect(results).toEqual([{ month: "2026-01", categoryName: "Groceries", status: "no-transactions" }])
  })

  it("tags the outlier transaction responsible for a flagged month", async () => {
    const bigOne = transaction({ id: "t1", category: "c1", amount: -90000, date: "2026-01-10" })
    const { calls } = stubFetch([
      { body: { data: [{ id: "a1", name: "Checking", offbudget: false, closed: false }] } },
      { body: { data: [bigOne] } },
      { body: {} }, // patchTransactionNotes
    ])
    const results = await tagAnomalyFindings(config, [finding], "2026-01", false)
    expect(results).toEqual([{ month: "2026-01", categoryName: "Groceries", status: "tagged", transactionId: "t1", date: "2026-01-10", amount: -90000, payee: "Some Payee" }])
    expect(calls).toHaveLength(3)
    expect(calls[2]?.init?.method).toBe("PATCH")
  })

  it("reports would-tag and writes nothing in dry-run mode", async () => {
    const bigOne = transaction({ id: "t1", category: "c1", amount: -90000, date: "2026-01-10" })
    const { calls } = stubFetch([
      { body: { data: [{ id: "a1", name: "Checking", offbudget: false, closed: false }] } },
      { body: { data: [bigOne] } },
    ])
    const results = await tagAnomalyFindings(config, [finding], "2026-01", true)
    expect(results[0]?.status).toBe("would-tag")
    expect(calls).toHaveLength(2) // no PATCH call
  })

  it("reports already-tagged and writes nothing when the tag is already present", async () => {
    const alreadyTagged = transaction({ id: "t1", category: "c1", amount: -90000, date: "2026-01-10", notes: "#anomaly-high" })
    const { calls } = stubFetch([
      { body: { data: [{ id: "a1", name: "Checking", offbudget: false, closed: false }] } },
      { body: { data: [alreadyTagged] } },
    ])
    const results = await tagAnomalyFindings(config, [finding], "2026-01", false)
    expect(results[0]?.status).toBe("already-tagged")
    expect(calls).toHaveLength(2)
  })
})
