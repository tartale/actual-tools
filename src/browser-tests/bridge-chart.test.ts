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
import { writeActualSession } from "../actual-session.ts"

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
  const sessionPath = join(dir, "session.json")
  writeActualSession(sessionPath, actualConfig)
  server = await startAppServer({
    sessionPath,
    dataSourceSessionPath: join(dir, "data-source.json"),
    configPath: join(dir, "config.json"),
    irsLimitsPath: join(dir, "irs-limits.json"),
    federalTaxBracketsPath: join(dir, "federal-tax-brackets.json"),
    irsLifeExpectancyPath: join(dir, "irs-life-expectancy.json"),
    federalPovertyGuidelinesPath: join(dir, "federal-poverty-guidelines.json"),
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
  await opened.waitForSelector("#checkResult .finding, #checkResult .empty-note", { state: "attached", timeout: 20000 })
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
    expect(tiles.some((t) => t.includes("Projected Expenditures"))).toBe(true)

    expect(await ui.evaluate(() => document.body.textContent ?? "")).not.toContain("withdrawals taxed")
    expect(errors).toEqual([])
  }, 60000)


  it("draws a critical marker and an unlock reference line for a scenario that depletes", async () => {
    const { page: ui, errors } = await openRetirementPage([50])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const chart = await ui.evaluate(() => {
      const el = document.querySelector(".bridge-chart") as HTMLElement
      return {
        legendItems: [...el.querySelectorAll(".bridge-legend-item")].map((e) => e.textContent?.trim()),
        hasStyleKey: Boolean(el.querySelector(".bridge-style-key")), // has locked money -- key shown
        criticalMarkers: el.querySelectorAll(".bridge-end-critical").length,
        unlockLines: el.querySelectorAll(".bridge-unlock-line").length,
        endLabel: el.querySelector(".bridge-end-label")?.textContent,
        dashedLines: el.querySelectorAll('path[stroke-dasharray]').length,
      }
    })
    // Shown even for a single scenario now -- the zoom modal's own findings column no longer
    // states the retirement age in view the way the inline finding text used to, so the legend is
    // the one place left that says which age this line is.
    expect(chart.legendItems).toEqual(["Retire at 50"])
    expect(chart.hasStyleKey).toBe(true)
    expect(chart.criticalMarkers).toBe(1)
    // The unlock reference line is a plain line with no label of its own now (the age is already
    // in the prose finding below), so there's nothing left to assert about it beyond the line count.
    expect(chart.unlockLines).toBe(1)
    expect(chart.endLabel).toMatch(/^depletes at age \d+$/)
    expect(chart.dashedLines).toBe(1)

    // Matches the prose finding right below it -- same age, same run, told two ways. The Stale
    // group (if there is one) renders its own .finding elements above this one, so the Bridge group
    // has to be found by its own label rather than taking the first .finding on the page.
    const findingText = await ui.evaluate(() => {
      const group = [...document.querySelectorAll(".findings-group")].find((g) => g.querySelector(".group-label")?.textContent?.startsWith("Bridge"))
      return group?.querySelector(".finding .title")?.textContent
    })
    const depletionAge = chart.endLabel?.match(/\d+/)?.[0]
    expect(findingText).toContain(`runs out at age ${depletionAge}`)
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

  it("shows the drag-to-reorder handle once there are 2+ portfolio accounts, regardless of the Monte Carlo widget's own withdrawal strategy", async () => {
    // Regression: the reorder handle used to only appear once the Monte Carlo widget's own
    // "Drain pots in order" strategy was selected -- now that this app's own bridge/MAGI simulation
    // reads the same withdrawalOrder field (see allocateWithdrawal in fire-analysis.ts), the handle
    // has to be available whenever there's more than one portfolio account to order, independent of
    // that widget setting (left at its default here -- never set to "sequential").
    const { page: ui, errors } = await openRetirementPage([50])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const handles = await ui.evaluate(() => document.querySelectorAll("#accountsList .drag-handle").length)
    expect(handles).toBe(2)
    expect(errors).toEqual([])
  }, 60000)

  it("never lets the zoomed chart's legend/style-key column overlap the findings column next to it", async () => {
    // Regression: the SVG's height-driven width (flex: 0 0 auto, no shrink) could exceed its real
    // share of the row once the side column's own width was subtracted, with nothing left to give
    // -- the legend then overflowed past the chart column's own right edge, on top of the findings
    // column beside it. Two open sections (both zoomed at once) splits the modal's own height in
    // half, which is what made this reproduce reliably.
    const { page: ui, errors } = await openRetirementPage([50, 65])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })
    await ui.click("#chartZoomOpenBtn")
    await ui.waitForSelector("#chartZoomBody .bridge-chart-svg path", { timeout: 20000 })

    const overlaps = await ui.evaluate(() =>
      [...document.querySelectorAll(".chart-zoom-section")].map((section) => {
        const side = section.querySelector(".bridge-chart-side")?.getBoundingClientRect()
        const findingsCol = section.querySelector(".chart-zoom-findings-col")?.getBoundingClientRect()
        return side && findingsCol ? side.right - findingsCol.left : null
      }),
    )
    // A positive value means the side column's own right edge sits PAST the findings column's
    // left edge -- an overlap. Anything <= 0 (a real gap, or flush) is fine.
    expect(overlaps.every((overlap) => overlap === null || overlap <= 0)).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("keeps the in-page chart SVG at its real 640:240 aspect ratio, however tall the card gets", async () => {
    // Regression: the SVG's height:100% (pinned unconditionally) let this sidebar's own narrower
    // available WIDTH clamp the width down via max-width without shrinking that pinned height to
    // match -- the SVG rendered squashed into a shorter, wider-than-intended box the moment the
    // window was tall enough to give the card more vertical room than a correctly-proportioned
    // chart actually needs. Reproduces starting around 800px tall at this width; 1000px (this
    // suite's own default viewport) is comfortably past that threshold.
    const { page: ui, errors } = await openRetirementPage([50])
    await ui.waitForSelector(".bridge-chart-svg path", { timeout: 20000 })

    const ratio = await ui.evaluate(() => {
      const rect = (document.querySelector(".retirement-live-sticky .bridge-chart-svg") as HTMLElement).getBoundingClientRect()
      return rect.width / rect.height
    })
    expect(ratio).toBeCloseTo(640 / 240, 1)
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

  it("keeps the chart, legend, and style-key inline, with findings hidden until zoomed", async () => {
    const { page: ui, errors } = await openRetirementPage([50, 65])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    // Regression: the inline chart used to grow a full-width legend ROW below the SVG, sized off
    // its own natural (uncompressed) height rather than the real, possibly-compressed space this
    // card actually has -- style-key items (built from a bare swatch span + bare text, not a
    // single grouped element the way legend items are) ended up positioned below the chart's real
    // bottom edge, and separately, the chart's own SVG stopped tracking the container's height at
    // all once this moved to CSS grid (flex:1, its old sizing hook, does nothing on a grid item).
    const layout = await ui.evaluate(() => {
      const chart = document.querySelector(".bridge-chart:not(.mc-chart)") as HTMLElement
      const chartRect = chart.getBoundingClientRect()
      const svgRect = chart.querySelector(".bridge-chart-svg")!.getBoundingClientRect()
      const styleKeyItems = [...chart.querySelectorAll(".bridge-style-key-item")]
      return {
        svgTracksChartHeight: Math.abs(svgRect.height - chartRect.height) < 1,
        // Every style-key item groups its own swatch with its own label -- if the underlying
        // markup ever regresses to a bare swatch span + bare text (not wrapped together), this
        // count only sees "found something", not that they're actually paired.
        styleKeyItemsHaveASwatchEach: styleKeyItems.length > 0 && styleKeyItems.every((item) => item.querySelector(".bridge-key-line, .mc-key-swatch") !== null),
        styleKeyWithinChartBounds: styleKeyItems.every((item) => item.getBoundingClientRect().bottom <= chartRect.bottom + 1),
      }
    })
    expect(layout.svgTracksChartHeight).toBe(true)
    expect(layout.styleKeyItemsHaveASwatchEach).toBe(true)
    expect(layout.styleKeyWithinChartBounds).toBe(true)

    // Findings (the "Ok"/"Warn"/"Fail" chip + prose) are zoom-only now -- the inline card shows
    // just the chart and its legend/style-key.
    expect(await ui.locator("#checkResult .finding:visible").count()).toBe(0)
    await ui.click("#chartZoomOpenBtn")
    await ui.waitForSelector("#chartZoomBackdrop.open", { timeout: 5000 })
    await ui.waitForTimeout(300)
    expect(await ui.locator("#chartZoomBody .finding:visible").count()).toBeGreaterThan(0)

    expect(errors).toEqual([])
  }, 60000)

  it("zoom modal puts findings beside the chart, then restores them on close with nothing lost or duplicated", async () => {
    const { page: ui, errors } = await openRetirementPage([50, 65])
    await ui.waitForSelector(".bridge-chart", { timeout: 20000 })

    const findingsBefore = await ui.locator("#checkResult .finding").count()
    expect(findingsBefore).toBeGreaterThan(0)

    await ui.click("#chartZoomOpenBtn")
    await ui.waitForSelector("#chartZoomBackdrop.open", { timeout: 5000 })
    await ui.waitForTimeout(300) // matches the modal's own open transition

    const whileOpen = await ui.evaluate(() => ({
      findingsInModal: document.querySelectorAll("#chartZoomBody .finding").length,
      findingsStillInPage: document.querySelectorAll("#checkResult .finding").length,
      // The chart (with its own legend) lives in the left column, findings in the right --
      // see openChartZoom's own doc comment for why this is a side-by-side split, not a stack.
      chartInLeftColumn: Boolean(document.querySelector("#chartZoomBody .chart-zoom-chart-col .bridge-chart")),
      findingsInRightColumn: document.querySelectorAll("#chartZoomBody .chart-zoom-findings-col .finding").length,
    }))
    expect(whileOpen.findingsInModal).toBe(findingsBefore)
    expect(whileOpen.findingsStillInPage).toBe(0)
    expect(whileOpen.chartInLeftColumn).toBe(true)
    expect(whileOpen.findingsInRightColumn).toBe(findingsBefore)

    await ui.click("#chartZoomClose")
    await ui.waitForTimeout(300) // matches the modal's own close transition, after which restore() runs

    const afterClose = await ui.evaluate(() => ({
      findingsBackInPage: document.querySelectorAll("#checkResult .finding").length,
      findingsLeftInModal: document.querySelectorAll("#chartZoomBody .finding").length,
    }))
    expect(afterClose.findingsBackInPage).toBe(findingsBefore)
    expect(afterClose.findingsLeftInModal).toBe(0)

    // Reopening a second time is the real test of the restore order (see closeChartZoom's own
    // reverse-iteration comment) -- a wrong order would throw or silently misplace nodes the first
    // time it had to insertBefore a reference node that was itself still sitting in the modal.
    await ui.click("#chartZoomOpenBtn")
    await ui.waitForTimeout(300)
    expect(await ui.locator("#chartZoomBody .finding").count()).toBe(findingsBefore)

    expect(errors).toEqual([])
  }, 60000)

  it("shows no chart, and no page error, when a portfolio has nothing to bridge", async () => {
    vi.stubGlobal("fetch", mockActualFetch())
    const sessionPath = join(dir, "session.json")
    writeActualSession(sessionPath, actualConfig)
    server = await startAppServer({ sessionPath, dataSourceSessionPath: join(dir, "data-source.json"), configPath: join(dir, "config.json"), irsLimitsPath: join(dir, "irs-limits.json"), federalTaxBracketsPath: join(dir, "federal-tax-brackets.json"), irsLifeExpectancyPath: join(dir, "irs-life-expectancy.json"), federalPovertyGuidelinesPath: join(dir, "federal-poverty-guidelines.json"), uiDir: UI_DIR })
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
    await opened.waitForSelector("#checkResult .finding, #checkResult .empty-note", { state: "attached", timeout: 20000 })
    await opened.waitForTimeout(200)

    // :not(.mc-chart): an empty portfolio has no Bridge chart either way, but this also confirms
    // Monte Carlo doesn't fill the gap with its own chart -- see the portfolioIds.length guard in
    // checkDashboard for why it shouldn't (the vendored engine's own fallback default pot).
    expect(await opened.evaluate(() => document.querySelector(".bridge-chart:not(.mc-chart)"))).toBeNull()
    expect(await opened.evaluate(() => document.querySelector(".mc-chart"))).toBeNull()
    expect(errors).toEqual([])
  }, 60000)
})
