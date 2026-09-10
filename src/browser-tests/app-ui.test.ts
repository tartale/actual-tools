import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium } from "playwright"
import type { Browser, Page } from "playwright"

import { startAppServer } from "../app-server.ts"
import type { RunningServer } from "../app-server.ts"
import type { ActualConfig } from "../actual-helpers.ts"

// Browser-driven tests for the Budget section's picker -- the behaviour route tests can't reach:
// whether the header menu actually opens, whether hidden categories really appear when toggled,
// whether moving the month window rolls through the months in between, and whether the Category
// column holds still while they pass. Every case here stands for a bug that shipped into the
// working tree at some point and was only ever caught by pointing a browser at the page.
//
// No stub Actual server is needed: startAppServer runs inside this process, so its own outbound
// calls to Actual are stubbed the same way app-server.test.ts stubs them. Only the browser is
// out-of-process, and it talks to the real server over a real port.

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch
const UI_DIR = fileURLToPath(new URL("../app-ui", import.meta.url))

// Launched once for the whole file. A machine without the browsers installed skips these rather
// than failing the suite -- the same courtesy `./actual lint` extends to a missing shellcheck.
// `./actual test` points Playwright at the sandbox image's own browsers; see ensurePlaywrightBrowsers.
const browser: Browser | null = await chromium.launch().catch(() => null)
if (!browser) {
  console.warn("Playwright browsers unavailable; skipping the browser-driven UI tests.")
}

afterAll(async () => {
  await browser?.close()
})

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const CATEGORY_GROUPS = [
  {
    id: "g1",
    name: "Everyday",
    is_income: false,
    hidden: false,
    categories: [
      { id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" },
      { id: "c2", name: "Retired Subscription", is_income: false, hidden: true, group_id: "g1" },
    ],
  },
  {
    id: "g2",
    name: "Last Year's Trip",
    is_income: false,
    hidden: true,
    categories: [{ id: "c3", name: "Flights", is_income: false, hidden: false, group_id: "g2" }],
  },
  { id: "g3", name: "Income", is_income: true, hidden: false, categories: [{ id: "c4", name: "Paycheck", is_income: true, hidden: false, group_id: "g3" }] },
]

const MONTH_CATEGORIES = [
  { id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1", budgeted: 50000, spent: -45000, balance: 5000, carryover: false },
  { id: "c2", name: "Retired Subscription", is_income: false, hidden: true, group_id: "g1", budgeted: 0, spent: 0, balance: 0, carryover: false },
  { id: "c3", name: "Flights", is_income: false, hidden: false, group_id: "g2", budgeted: 10000, spent: -2500, balance: 7500, carryover: false },
]

// Every month answers with the same figures -- these tests are about which months are on screen and
// how they get there, never about the numbers inside them.
function mockActualFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") {
      return realFetch(url, init)
    }
    if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: [] })
    if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: CATEGORY_GROUPS })
    if (/\/accounts\/[^/]+\/transactions/.test(u.pathname)) return jsonResponse({ data: [] })
    if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return jsonResponse({ data: MONTH_CATEGORIES })
    if (/\/run-query$/.test(u.pathname)) return jsonResponse({ data: [] })
    return jsonResponse({})
  })
}

let dir: string
let server: RunningServer | null = null
let page: Page | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-ui-test-"))
})

afterEach(async () => {
  await page?.close()
  page = null
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// Opens the real page against a real server, on the Budget section with its table already rendered.
// Any uncaught page error fails the test that caused it: both of the bugs these tests exist for
// announced themselves that way long before anything looked wrong on screen.
async function openBudgetPage(): Promise<{ page: Page; errors: string[] }> {
  vi.stubGlobal("fetch", mockActualFetch())
  writeFileSync(join(dir, "irs-limits.json"), "{}")
  server = await startAppServer({
    actualConfig,
    configPath: join(dir, "config.json"),
    irsLimitsPath: join(dir, "irs-limits.json"),
    outputPath: join(dir, "fire-dashboard.json"),
    uiDir: UI_DIR,
  })
  const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
  page = opened
  const errors: string[] = []
  opened.on("pageerror", (error) => errors.push(error.message))
  await opened.goto(server.url)
  await opened.waitForSelector("#budgetTable .budget-table-el")
  return { page: opened, errors }
}

const visibleMonthHeadings = (target: Page) =>
  target.evaluate(() => [...document.querySelectorAll("#budgetTable thead tr:first-child th.bt-month-head")].map((th) => th.textContent?.trim() ?? ""))

// The page opens on the current month, so what the columns say depends on when the suite runs.
function monthHeading(offsetFromThisMonth: number): string {
  const now = new Date()
  const month = new Date(now.getFullYear(), now.getMonth() + offsetFromThisMonth, 1)
  return month.toLocaleDateString(undefined, { month: "short", year: "numeric" })
}

describe.skipIf(!browser)("Budget picker in a browser", () => {
  it("opens the Category header menu", async () => {
    // Regression: the menu's position was measured before it was unhidden, and a display:none
    // element has no offsetParent -- reading one threw and the menu could never be opened at all.
    const { page: ui, errors } = await openBudgetPage()
    expect(await ui.locator("#budgetMenu").isVisible()).toBe(false)
    await ui.locator("#budgetTable .bt-head-menu").click()
    expect(await ui.locator("#budgetMenu").isVisible()).toBe(true)
    // A second click closes it again.
    await ui.locator("#budgetTable .bt-head-menu").click()
    expect(await ui.locator("#budgetMenu").isVisible()).toBe(false)
    expect(errors).toEqual([])
  }, 60000)

  it("keeps hidden categories out of the grid until the menu asks for them, then marks them", async () => {
    const { page: ui, errors } = await openBudgetPage()
    const names = () => ui.evaluate(() => [...document.querySelectorAll("#budgetTable .bt-row .bt-name label")].map((l) => l.textContent?.trim() ?? ""))
    // A hidden category, and every category inside a hidden group, start out of the grid entirely.
    expect(await names()).toEqual(["Groceries"])

    await ui.locator("#budgetTable .bt-head-menu").click()
    await ui.locator('#budgetMenu [data-menu-item="toggle-hidden"]').click()
    expect((await names()).sort()).toEqual(["Flights", "Groceries", "Retired Subscription"])

    // Shown, they have to be distinguishable from an ordinary row -- dimming alone would collide
    // with the styling for zero figures, so the eye-off glyph carries the meaning.
    const marks = await ui.evaluate(() => {
      const hiddenRows = [...document.querySelectorAll("#budgetTable tr.bt-hidden")]
      const ordinary = document.querySelector("#budgetTable tr.bt-row:not(.bt-hidden) .bt-name label")
      return {
        hiddenRowCount: hiddenRows.length,
        glyphs: document.querySelectorAll("#budgetTable .bt-hidden-mark").length,
        hiddenItalic: getComputedStyle((hiddenRows.find((r) => r.classList.contains("bt-row")) as Element).querySelector(".bt-name label") as Element).fontStyle,
        ordinaryItalic: ordinary ? getComputedStyle(ordinary).fontStyle : "",
      }
    })
    // Two rows carry the flag themselves (the hidden category, the hidden group header); the third
    // is a category inheriting only the dimming from its hidden group, with no repeated glyph.
    expect(marks.glyphs).toBe(2)
    expect(marks.hiddenRowCount).toBeGreaterThan(2)
    expect(marks.hiddenItalic).toBe("italic")
    expect(marks.ordinaryItalic).toBe("normal")

    await ui.locator("#budgetTable .bt-head-menu").click()
    await ui.locator('#budgetMenu [data-menu-item="toggle-hidden"]').click()
    expect(await names()).toEqual(["Groceries"])
    expect(await ui.evaluate(() => document.querySelectorAll("#budgetTable tr.bt-hidden, #budgetTable .bt-hidden-mark").length)).toBe(0)
    expect(errors).toEqual([])
  }, 60000)

  it("rolls through every month in between when the window moves, instead of jumping", async () => {
    const { page: ui, errors } = await openBudgetPage()
    expect(await visibleMonthHeadings(ui)).toEqual([monthHeading(0), monthHeading(1), monthHeading(2)])

    // Sample which months are on screen for the length of the journey, rather than only at the end:
    // the point of the roll is what happens in between, and an implementation that simply swapped
    // the destination in would pass an end-state-only assertion.
    await ui.evaluate(() => {
      ;(window as unknown as { seen: string[] }).seen = []
      const wrap = document.getElementById("budgetTable") as HTMLElement
      const tick = () => {
        for (const th of wrap.querySelectorAll("thead tr:first-child th.bt-month-head")) {
          const label = th.textContent?.trim() ?? ""
          const seen = (window as unknown as { seen: string[] }).seen
          if (!seen.includes(label)) seen.push(label)
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    // The strip's leftmost month is eight months behind the one the page opens on.
    await ui.locator("#budgetMonthStrip .month-strip-month").first().click()
    // Wait for the journey to start before waiting for it to finish: "no filmstrip on screen" is
    // also true in the moment before the roll begins, so checking only for its absence passes
    // instantly and asserts against the months we haven't left yet.
    await ui.waitForFunction(() => Boolean(document.querySelector("#budgetTable .bt-filmstrip")), undefined, { timeout: 20000 })
    await ui.waitForFunction(() => !document.querySelector("#budgetTable .bt-filmstrip"), undefined, { timeout: 20000 })

    expect(await visibleMonthHeadings(ui)).toEqual([monthHeading(-8), monthHeading(-7), monthHeading(-6)])
    const seen = await ui.evaluate(() => (window as unknown as { seen: string[] }).seen)
    // Every month between where it started and where it landed actually appeared on screen.
    for (let offset = -8; offset <= 2; offset++) {
      expect(seen).toContain(monthHeading(offset))
    }
    expect(errors).toEqual([])
  }, 60000)

  it("holds the Category column still, and doesn't widen the page, while the months roll past", async () => {
    const { page: ui, errors } = await openBudgetPage()
    const pageWidthBefore = await ui.evaluate(() => document.documentElement.scrollWidth)

    await ui.locator("#budgetMonthStrip .month-strip-month").first().click()
    await ui.waitForFunction(() => Boolean(document.querySelector("#budgetTable .bt-filmstrip")), undefined, { timeout: 20000 })
    const midRoll = await ui.evaluate(() => {
      const wrap = document.getElementById("budgetTable") as HTMLElement
      const box = wrap.getBoundingClientRect()
      const groupName = wrap.querySelector(".bt-group-header .bt-name") as HTMLElement
      const categoryName = wrap.querySelector(".bt-row .bt-name") as HTMLElement
      return {
        scrolled: wrap.scrollLeft,
        overflowing: wrap.scrollWidth > wrap.clientWidth,
        groupNameOffset: groupName.getBoundingClientRect().left - box.left,
        categoryNameOffset: categoryName.getBoundingClientRect().left - box.left,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }
    })

    // The grid really is scrolled sideways, not swapped...
    expect(midRoll.overflowing).toBe(true)
    expect(midRoll.scrolled).toBeGreaterThan(0)
    // ...while both name cells stay pinned at the left edge. Regression: display:flex on the group
    // header's <td> stopped it being a table cell, so sticky anchored it to an anonymous box and
    // the group names scrolled away while the category names stayed.
    expect(midRoll.groupNameOffset).toBeLessThan(2)
    expect(midRoll.categoryNameOffset).toBeLessThan(2)
    // Regression: overflow:hidden doesn't stop an over-wide child feeding intrinsic sizing, so the
    // filmstrip stretched <main> and pushed the card's own buttons off the right edge.
    expect(midRoll.pageWidth).toBeLessThanOrEqual(midRoll.viewportWidth)
    expect(midRoll.pageWidth).toBe(pageWidthBefore)
    expect(errors).toEqual([])
  }, 60000)

  it("switches between sections without disturbing Retirement's own tabs", async () => {
    // Regression: the Retirement tab handler used to select on the bare .tab class and deactivate
    // every .panel on the page. Budget no longer has tabs of its own for that to collide with, but
    // the handler stays scoped to [data-tab] and its own section's panels, and moving between
    // sections must still leave the tab state it finds alone.
    const { page: ui, errors } = await openBudgetPage()
    const activePanels = () => ui.evaluate(() => [...document.querySelectorAll(".panel.active")].map((p) => p.id).sort())

    expect(await activePanels()).toEqual(["panel-configure"])
    await ui.locator('.section-item[data-section="retirement"]').click()
    expect(await ui.evaluate(() => document.getElementById("page-retirement")?.classList.contains("active"))).toBe(true)

    await ui.locator('[data-tab="analyze"]').click()
    expect(await activePanels()).toEqual(["panel-analyze"])
    await ui.locator('.section-item[data-section="budget"]').click()
    expect(await ui.evaluate(() => document.getElementById("page-budget")?.classList.contains("active"))).toBe(true)
    // Retirement's own tab choice survives the trip through another section.
    expect(await activePanels()).toEqual(["panel-analyze"])
    expect(errors).toEqual([])
  }, 60000)

  it("offers finding anomalies as an action over the same picker, not a separate tab", async () => {
    const { page: ui, errors } = await openBudgetPage()
    // There is one grid and one month strip on the page, not one per action.
    expect(await ui.evaluate(() => document.querySelectorAll(".budget-table").length)).toBe(1)
    expect(await ui.evaluate(() => document.querySelectorAll(".month-strip").length)).toBe(1)
    expect(await ui.evaluate(() => document.querySelectorAll("#page-budget [data-budget-tab]").length)).toBe(0)

    const buttons = () =>
      ui.evaluate(() => ({
        preview: !(document.getElementById("previewSetValuesBtn") as HTMLElement).hidden,
        apply: !(document.getElementById("applySetValuesBtn") as HTMLElement).hidden,
        find: !(document.getElementById("findAnomaliesBtn") as HTMLElement).hidden,
        title: document.getElementById("budgetActionTitle")?.textContent,
      }))

    // A set-values action offers Preview/Apply and no Find.
    expect(await buttons()).toMatchObject({ preview: true, apply: true, find: false })

    await ui.selectOption("#budgetAction", "anomalies")
    // Read-only, so there is nothing to preview and nothing to apply.
    expect(await buttons()).toMatchObject({ preview: false, apply: false, find: true, title: "Find spending anomalies" })

    // The custom-amount box belongs to exactly one action, and isn't dragged along by the others.
    await ui.selectOption("#budgetAction", "custom")
    expect(await ui.locator("#budgetCustomAmountField").isVisible()).toBe(true)
    await ui.selectOption("#budgetAction", "anomalies")
    expect(await ui.locator("#budgetCustomAmountField").isVisible()).toBe(false)
    expect(errors).toEqual([])
  }, 60000)
})
