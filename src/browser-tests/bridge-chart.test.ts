import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium } from "playwright"
import type { Browser, Page } from "playwright"

import { startAppServer } from "../app-server.ts"
import type { RunningServer } from "../app-server.ts"
import type { ActualConfig } from "../actual-helpers.ts"

// Browser-driven tests for the bridge burndown chart on the Retirement page's Analysis card. Route tests
// already cover simulateBridge's own math (fire-analysis.test.ts) and that /api/retirement/check
// carries bridgeResults over the wire (app-server.test.ts); what neither reaches is whether the
// chart built from that response actually draws the right lines, markers, and legend -- the same
// gap the Budget picker's own browser tests exist to close.
//
// No stub Actual server: startAppServer runs inside this process and its outbound calls are
// stubbed with vi.stubGlobal("fetch", ...), same as every other server-backed test in this repo.

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch
const UI_DIR = fileURLToPath(new URL("../app-ui", import.meta.url))

const browser: Browser | null = await chromium.launch().catch(() => null)
if (!browser) {
  console.warn("Playwright browsers unavailable; skipping the browser-driven bridge chart tests.")
}

afterAll(async () => {
  await browser?.close()
})

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

// Today's date minus `age` years, same month/day -- guarantees ageFromBirthDate reads back exactly
// `age` regardless of which day this suite happens to run on.
function birthDateForAge(age: number): string {
  const now = new Date()
  const year = now.getUTCFullYear() - age
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// Two accounts engineered for two very different outcomes at two different retirement ages, purely
// by heuristic name classification (no accounts.json override needed):
// - "Brokerage" ($40,000) has no access-age restriction at all.
// - "Fidelity 401k" ($2,000,000) locks until the standard access age (59).
// Retiring at 50 leaves only the brokerage account reachable against $30,000/yr of spend -- it runs
// dry almost immediately, well before the 401k unlocks at 59: a real bridge gap. Retiring at 65 is
// past 59, so both accounts start already-combined and $2.04M comfortably outlasts the plan.
const ACCOUNTS = [
  { id: "brokerage", name: "Brokerage", offbudget: true, closed: false },
  { id: "401k", name: "Fidelity 401k", offbudget: true, closed: false },
]
const TRANSACTIONS: Record<string, { amount: number; transfer_id: string | null }[]> = {
  brokerage: [{ amount: 4000000, transfer_id: null }],
  "401k": [{ amount: 200000000, transfer_id: null }],
}
const SPEND_CATEGORY = { id: "spend-cat", name: "Spend", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -250000, balance: 0, carryover: false }

function mockActualFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") {
      return realFetch(url, init)
    }
    if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: ACCOUNTS })
    if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: [{ id: "g1", name: "Spending", is_income: false, hidden: false, categories: [SPEND_CATEGORY] }] })
    const txMatch = /\/accounts\/([^/]+)\/transactions/.exec(u.pathname)
    if (txMatch) return jsonResponse({ data: TRANSACTIONS[txMatch[1] as string] ?? [] })
    // Every month answers with the same spend figure -- spendFromLocalSelection's own trailing
    // average is over twelve of these, so which specific months get asked for doesn't matter.
    if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return jsonResponse({ data: [SPEND_CATEGORY] })
    if (/\/run-query$/.test(u.pathname)) return jsonResponse({ data: [] })
    if (init?.method === "PATCH") return jsonResponse({})
    return jsonResponse({})
  })
}

let dir: string
let server: RunningServer | null = null
let page: Page | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-chart-test-"))
})

afterEach(async () => {
  await page?.close()
  page = null
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// Opens the Retirement page against a real server with the plan above already set (via the same
// PATCH route the app's own Plan card uses), waits for the chart to render, and fails the test on
// any uncaught page error. No tab to open any more -- Analysis is just a card on the one flat page,
// not folded by default, so runCheck's own result (fired once on landing) is already visible.
async function openRetirementPage(retirementAges: number[]): Promise<{ page: Page; errors: string[] }> {
  vi.stubGlobal("fetch", mockActualFetch())
  server = await startAppServer({
    actualConfig,
    configPath: join(dir, "config.json"),
    irsLimitsPath: join(dir, "irs-limits.json"),
    outputPath: join(dir, "fire-dashboard.json"),
    uiDir: UI_DIR,
  })
  await fetch(`${server.url}api/retirement/plan`, {
    method: "PATCH",
    body: JSON.stringify({ birthDate: birthDateForAge(50), retirementAges, planToAge: 100 }),
  })

  const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
  page = opened
  const errors: string[] = []
  opened.on("pageerror", (error) => errors.push(error.message))
  await opened.goto(server.url)
  await opened.locator('.section-item[data-section="retirement"]').click()
  await opened.waitForSelector("#checkResult .finding, #checkResult .empty-note", { timeout: 20000 })
  return { page: opened, errors }
}

describe.skipIf(!browser)("Bridge burndown chart in a browser", () => {
  it("shows the summary tiles on load, without ever claiming withdrawals are taxed", async () => {
    // Regression: "withdrawals taxed" used to sit in the Bridge group's own label, but the tax rate
    // is per-account (0% for a Roth or HSA, 22%/15% otherwise) -- a blanket claim overstated it for
    // any portfolio with tax-free money in it.
    const { page: ui, errors } = await openRetirementPage([50])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const tiles = await ui.evaluate(() =>
      [...document.querySelectorAll("#summaryTiles .tile")].map((t) => t.textContent ?? ""),
    )
    expect(tiles.some((t) => t.includes("(2 accounts)"))).toBe(true)
    expect(tiles.some((t) => /\$2,040,000\.00/.test(t))).toBe(true)
    expect(tiles.some((t) => t.includes("Spend"))).toBe(true)

    expect(await ui.evaluate(() => document.body.textContent ?? "")).not.toContain("withdrawals taxed")
    expect(errors).toEqual([])
  }, 60000)


  it("draws a critical marker and an unlock reference line for a scenario that depletes", async () => {
    const { page: ui, errors } = await openRetirementPage([50])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const chart = await ui.evaluate(() => {
      const el = document.querySelector(".bridge-chart") as HTMLElement
      return {
        hasLegend: Boolean(el.querySelector(".bridge-legend")), // one scenario -- no legend box
        hasStyleKey: Boolean(el.querySelector(".bridge-style-key")), // has locked money -- key shown
        criticalMarkers: el.querySelectorAll(".bridge-end-critical").length,
        unlockLines: el.querySelectorAll(".bridge-unlock-line").length,
        endLabel: el.querySelector(".bridge-end-label")?.textContent,
        dashedLines: el.querySelectorAll('path[stroke-dasharray]').length,
      }
    })
    expect(chart.hasLegend).toBe(false)
    expect(chart.hasStyleKey).toBe(true)
    expect(chart.criticalMarkers).toBe(1)
    // The unlock reference line is a plain line with no label of its own now (the age is already
    // in the prose finding below), so there's nothing left to assert about it beyond the line count.
    expect(chart.unlockLines).toBe(1)
    expect(chart.endLabel).toMatch(/^depletes at \d+$/)
    expect(chart.dashedLines).toBe(1)

    // Matches the prose finding right below it -- same age, same run, told two ways. The Stale
    // group (if there is one) renders its own .finding elements above this one, so the Bridge group
    // has to be found by its own label rather than taking the first .finding on the page.
    const findingText = await ui.evaluate(() => {
      const group = [...document.querySelectorAll(".findings-group")].find((g) => g.querySelector(".group-label")?.textContent?.startsWith("Bridge"))
      return group?.querySelector(".finding .title")?.textContent
    })
    const depletionAge = chart.endLabel?.match(/\d+/)?.[0]
    expect(findingText).toContain(`runs out at ${depletionAge}`)
    expect(errors).toEqual([])
  }, 60000)

  it("draws a plain, unmarked line for a scenario that funds through the plan", async () => {
    const { page: ui, errors } = await openRetirementPage([65])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const chart = await ui.evaluate(() => {
      const el = document.querySelector(".bridge-chart") as HTMLElement
      return {
        criticalMarkers: el.querySelectorAll(".bridge-end-critical").length,
        unlockLines: el.querySelectorAll(".bridge-unlock-line").length,
        endLabels: el.querySelectorAll(".bridge-end-label").length,
        // Scoped to the chart's own <svg>, not the whole .bridge-chart wrapper -- that wrapper
        // also holds the click-to-zoom button (see addChartZoom in app.js), whose own icon is a
        // <circle> too but isn't a data marker.
        plainEndDots: el.querySelectorAll(".bridge-chart-svg circle:not(.bridge-end-critical)").length,
        hasStyleKey: Boolean(el.querySelector(".bridge-style-key")),
      }
    })
    expect(chart.criticalMarkers).toBe(0)
    expect(chart.unlockLines).toBe(0)
    expect(chart.endLabels).toBe(0)
    // A funded, non-windowed line still gets its ordinary filled end-dot -- only a WINDOWED one
    // (see BRIDGE_WINDOW_YEARS) omits it, and 65+20=85 is past this plan's own 100... wait, planToAge
    // is 100 so this scenario's natural end (100) exceeds the window (85) and IS windowed, hence no dot.
    expect(chart.plainEndDots).toBe(0)
    // Both accounts are already unlocked by 65 (retirement), but the 401k's own accessAge (59) is
    // still 9 years out from currentAge (50) -- the accumulation phase drawn between them (see
    // BridgeResult's own accumulation field) genuinely has locked money in it, even though nothing
    // is locked by the time withdrawals actually start, so the style key is real here too.
    expect(chart.hasStyleKey).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("compares two retirement ages on one chart, with a legend and independent lines", async () => {
    const { page: ui, errors } = await openRetirementPage([50, 65])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const chart = await ui.evaluate(() => {
      const el = document.querySelector(".bridge-chart") as HTMLElement
      return {
        legendItems: [...el.querySelectorAll(".bridge-legend-item")].map((e) => e.textContent?.trim()),
        seriesCount: el.querySelectorAll("g[data-series]").length,
        criticalMarkers: el.querySelectorAll(".bridge-end-critical").length,
      }
    })
    expect(chart.legendItems).toEqual(["Retire at 50", "Retire at 65"])
    expect(chart.seriesCount).toBe(2)
    expect(chart.criticalMarkers).toBe(1) // only the retire-50 scenario depletes

    // Hovered via a directly dispatched PointerEvent rather than page.mouse.move: OS-level cursor
    // synthesis over an SVG element doesn't reliably deliver pointermove in headless Firefox, which
    // is exactly the failure this test hit before switching -- the listener never even ran. This
    // still exercises the real listener on the real DOM, just triggered without depending on OS
    // input simulation.
    //
    // The left edge is the target: minAge is defined as the earliest age ANY drawn scenario starts
    // at, so it is guaranteed to be a real point on at least one line -- unlike a position picked as
    // a fraction of the full domain, which here spans retire-50's own two-point sliver (it depletes
    // almost immediately) all the way out to retire-65's 20-year window, and would easily land in
    // the empty gap between the two.
    // Scoped to :not(.mc-chart) -- the Monte Carlo fan chart renders alongside Bridge on the same
    // page now and shares every one of these class names for its identical grid/axis/tooltip
    // styling (see mc-chart's own doc comment in app.js).
    const hit = ui.locator(".bridge-chart:not(.mc-chart) .bridge-hit")
    const box = await hit.boundingBox()
    await ui.evaluate(([x, y]) => {
      document.querySelector(".bridge-chart:not(.mc-chart) .bridge-hit")?.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }))
    }, [(box?.x ?? 0) + 3, (box?.y ?? 0) + (box?.height ?? 0) * 0.6])
    await ui.waitForTimeout(150)
    const tooltip = await ui.evaluate(() => ({
      visible: !(document.querySelector(".bridge-tooltip") as HTMLElement).hidden,
      hasAge: /^Age \d+$/.test(document.querySelector(".bridge-tooltip-age")?.textContent ?? ""),
      rowCount: document.querySelectorAll(".bridge-tooltip-row").length,
    }))
    expect(tooltip.visible).toBe(true)
    expect(tooltip.hasAge).toBe(true)
    expect(tooltip.rowCount).toBeGreaterThan(0)
    expect(errors).toEqual([])
  }, 60000)

  it("shows no chart, and no page error, when a portfolio has nothing to bridge", async () => {
    vi.stubGlobal("fetch", mockActualFetch())
    server = await startAppServer({ actualConfig, configPath: join(dir, "config.json"), irsLimitsPath: join(dir, "irs-limits.json"), outputPath: join(dir, "fire-dashboard.json"), uiDir: UI_DIR })
    await fetch(`${server.url}api/retirement/plan`, {
      method: "PATCH",
      body: JSON.stringify({ birthDate: birthDateForAge(50), retirementAges: [50], planToAge: 100 }),
    })
    // Overrides the account fixture for just this one test: an empty portfolio, so
    // accessibleAtRetirement + lockedAtRetirement is zero and renderBridgeChart returns null.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(url)
        if (u.hostname !== "actual.test") return realFetch(url, init)
        if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: [] })
        if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: [] })
        if (/\/run-query$/.test(u.pathname)) return jsonResponse({ data: [] })
        return jsonResponse({ data: [] })
      }),
    )

    const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
    page = opened
    const errors: string[] = []
    opened.on("pageerror", (error) => errors.push(error.message))
    await opened.goto(server.url)
    await opened.locator('.section-item[data-section="retirement"]').click()
    await opened.waitForSelector("#checkResult .finding, #checkResult .empty-note", { timeout: 20000 })
    await opened.waitForTimeout(200)

    // :not(.mc-chart): an empty portfolio has no Bridge chart either way, but this also confirms
    // Monte Carlo doesn't fill the gap with its own chart -- see the portfolioIds.length guard in
    // checkDashboard for why it shouldn't (the vendored engine's own fallback default pot).
    expect(await opened.evaluate(() => document.querySelector(".bridge-chart:not(.mc-chart)"))).toBeNull()
    expect(await opened.evaluate(() => document.querySelector(".mc-chart"))).toBeNull()
    expect(errors).toEqual([])
  }, 60000)
})
