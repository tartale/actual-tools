import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium } from "playwright"
import type { Browser, Page } from "playwright"

import { startAppServer } from "../app-server.ts"
import type { RunningServer } from "../app-server.ts"
import type { ActualConfig } from "../actual-helpers.ts"
import { writeActualSession } from "../actual-session.ts"

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

// Every month answers with the same figures except one: Groceries spends an order of magnitude more
// in the current month than in any other. Months are otherwise interchangeable here -- these tests
// are about which months are on screen and how they get there -- but a history with no variation in
// it has no anomalies in it either, so the outlier is what gives a Find run something to find.
function thisMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

function monthCategoriesFor(month: string) {
  return MONTH_CATEGORIES.map((category) => (category.id === "c1" && month === thisMonth() ? { ...category, spent: -900000 } : category))
}

function mockActualFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") {
      return realFetch(url, init)
    }
    if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: [] })
    if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: CATEGORY_GROUPS })
    if (/\/accounts\/[^/]+\/transactions/.test(u.pathname)) return jsonResponse({ data: [] })
    const monthMatch = /\/months\/([^/]+)\/categories$/.exec(u.pathname)
    if (monthMatch) return jsonResponse({ data: monthCategoriesFor(monthMatch[1] as string) })
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

  it("flags an anomaly in the grid, on the Spent figure, not only in the list", async () => {
    const { page: ui, errors } = await openBudgetPage()
    await ui.locator("#budgetTable th.bt-month-head").first().click()
    await ui.locator("#budgetTable .bt-group-check").first().check()
    await ui.selectOption("#budgetAction", "anomalies")
    await ui.locator("#findAnomaliesBtn").click()
    await ui.waitForSelector("#budgetTable .bt-flagged", { timeout: 20000 })

    const flagged = await ui.evaluate(() => {
      const cells = [...document.querySelectorAll("#budgetTable tr.bt-row .bt-num.bt-flagged")]
      const row = cells[0]?.closest("tr")
      const cellsInRow = row ? [...row.querySelectorAll(".bt-num")] : []
      return {
        count: cells.length,
        // Budgeted, Spent, Balance -- the flag belongs on the middle one.
        indexInRow: cellsInRow.indexOf(cells[0] as Element),
        category: row?.querySelector(".bt-name label")?.textContent?.trim(),
        direction: [...(cells[0]?.classList ?? [])].find((c) => c.startsWith("bt-flagged-")),
        dimmed: cells[0]?.classList.contains("bt-zero"),
        // The group's own total carries it too, so a folded group still shows it.
        groupFlagged: document.querySelectorAll("#budgetTable tr.bt-group-header .bt-num.bt-flagged").length,
        // The detail the findings list used to spell out now lives on the cell itself.
        tooltip: cells[0]?.getAttribute("title"),
        summary: document.getElementById("actionResult")?.textContent?.trim(),
        tagEnabled: !(document.getElementById("tagAnomaliesBtn") as HTMLButtonElement).disabled,
      }
    })
    expect(flagged.count).toBe(1)
    expect(flagged.indexInRow).toBe(1)
    expect(flagged.category).toBe("Groceries")
    expect(flagged.direction).toBe("bt-flagged-high")
    expect(flagged.dimmed).toBe(false)
    expect(flagged.groupFlagged).toBe(1)
    expect(flagged.tooltip).toMatch(/^Typical: /)
    // One line saying what happened, not a second copy of the report -- a run that found nothing
    // has to look different from a run that never happened, and that is all this line is for.
    expect(flagged.summary).toMatch(/^Flagged 1 category across 1 month/)
    expect(ui.locator("#actionResult .finding")).toBeDefined()
    expect(await ui.evaluate(() => document.querySelectorAll("#actionResult .finding").length)).toBe(0)
    // Tagging becomes available once there is something to tag.
    expect(flagged.tagEnabled).toBe(true)

    // The flag describes one run over one selection, so changing either drops it.
    await ui.selectOption("#budgetAction", "balance")
    expect(await ui.evaluate(() => document.querySelectorAll("#budgetTable .bt-flagged").length)).toBe(0)
    expect(await ui.evaluate(() => (document.getElementById("tagAnomaliesBtn") as HTMLButtonElement).disabled)).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("selects and clears every category from the header checkbox, showing a partial selection", async () => {
    const { page: ui } = await openBudgetPage()
    await ui.locator("#budgetTable .bt-head-menu").click()
    await ui.locator('#budgetMenu [data-menu-item="toggle-hidden"]').click()

    const state = () =>
      ui.evaluate(() => {
        const all = document.querySelector("#budgetTable .bt-all-check") as HTMLInputElement
        const boxes = [...document.querySelectorAll("#budgetTable .bt-category-check")] as HTMLInputElement[]
        return { checked: all.checked, indeterminate: all.indeterminate, categories: boxes.length, selected: boxes.filter((b) => b.checked).length }
      })

    expect(await state()).toMatchObject({ checked: false, indeterminate: false, selected: 0 })

    // It governs the category checkbox column, so it has to sit in it -- the header's own text is
    // centred, which is where this box ended up before it was pinned to the column instead.
    const columns = await ui.evaluate(() => {
      const left = (sel: string) => Math.round(document.querySelector(sel)!.getBoundingClientRect().left)
      return { all: left("#budgetTable .bt-all-check"), group: left("#budgetTable .bt-group-check"), category: left("#budgetTable .bt-category-check") }
    })
    expect(columns.all).toBe(columns.category)
    // The group's own box shares the column too -- it used to sit a fold-toggle's gap to the right.
    expect(columns.group).toBe(columns.category)

    // Ticking it takes every category in the grid, hidden ones included now they are shown.
    await ui.locator("#budgetTable .bt-all-check").check()
    const all = await state()
    expect(all).toMatchObject({ checked: true, indeterminate: false })
    expect(all.selected).toBe(all.categories)

    // Clearing one leaves the header box in the middle state rather than lying either way.
    await ui.locator("#budgetTable .bt-category-check").first().uncheck()
    expect(await state()).toMatchObject({ checked: false, indeterminate: true, selected: all.categories - 1 })

    // Clicking out of the middle state takes everything, which is what a native checkbox does --
    // indeterminate is a look, not a third value a click cycles through.
    await ui.locator("#budgetTable .bt-all-check").click()
    expect(await state()).toMatchObject({ checked: true, indeterminate: false, selected: all.categories })

    // And clicking it again clears the lot.
    await ui.locator("#budgetTable .bt-all-check").click()
    expect(await state()).toMatchObject({ checked: false, indeterminate: false, selected: 0 })
  }, 60000)

  it("switches between sections without disturbing Retirement's own fold state", async () => {
    // Regression, updated for the Configure/Analyze tab merge: Retirement's own state used to be
    // which tab was active; it's now which cards are folded. The same risk applies either way --
    // navigating to Budget and back must leave it exactly as it was, not reset to the defaults.
    const { page: ui, errors } = await openBudgetPage()
    await ui.locator('.section-item[data-section="retirement"]').click()
    expect(await ui.evaluate(() => document.getElementById("page-retirement")?.classList.contains("active"))).toBe(true)

    // Plan starts expanded by default -- fold it.
    await ui.locator('[data-section="plan"] .card-fold-toggle').click()
    expect(await ui.evaluate(() => (document.querySelector('[data-section="plan"] .card-fold') as HTMLElement).hidden)).toBe(true)

    await ui.locator('.section-item[data-section="budget"]').click()
    expect(await ui.evaluate(() => document.getElementById("page-budget")?.classList.contains("active"))).toBe(true)
    await ui.locator('.section-item[data-section="retirement"]').click()
    // Plan's fold survives the round trip through another section.
    expect(await ui.evaluate(() => (document.querySelector('[data-section="plan"] .card-fold') as HTMLElement).hidden)).toBe(true)
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
        tag: !(document.getElementById("tagAnomaliesBtn") as HTMLElement).hidden,
      }))

    // A set-values action offers Preview/Apply, and neither of the anomalies buttons.
    expect(await buttons()).toMatchObject({ preview: true, apply: true, find: false, tag: false })

    await ui.selectOption("#budgetAction", "anomalies")
    // Read-only, so there is nothing to preview and nothing to apply. Tagging stands beside Find
    // for the whole action rather than appearing once a run has flagged something -- disabled
    // until then, so the action's buttons are the same set from the moment it is selected.
    expect(await buttons()).toMatchObject({ preview: false, apply: false, find: true, tag: true })
    expect(await ui.locator("#tagAnomaliesBtn").isDisabled()).toBe(true)

    // The custom-amount box belongs to exactly one action, but stays in the layout for all of them:
    // taking it out of the flow moved every button beside it, laying the row out differently for
    // one action than for the rest.
    await ui.selectOption("#budgetAction", "custom")
    expect(await ui.locator("#budgetCustomAmount").isDisabled()).toBe(false)
    const withAmount = await ui.evaluate(() => Math.round(document.querySelector(".action-buttons")!.getBoundingClientRect().left))
    await ui.selectOption("#budgetAction", "anomalies")
    expect(await ui.locator("#budgetCustomAmount").isDisabled()).toBe(true)
    expect(await ui.locator("#budgetCustomAmountField").isVisible()).toBe(true)
    const withoutAmount = await ui.evaluate(() => Math.round(document.querySelector(".action-buttons")!.getBoundingClientRect().left))
    // Same geometry whichever action is selected -- the buttons never move under the cursor.
    expect(withoutAmount).toBe(withAmount)
    expect(errors).toEqual([])
  }, 60000)
})

// Opens the real page against a real server with NEITHER an Actual session nor a file-import
// session on disk, so it lands on the real #loginBackdrop modal -- unlike openBudgetPage above,
// which pre-seeds Actual credentials to skip straight past it. Exercises issue #35's actual
// end-user path: picking a mode, submitting the form, and everything that follows.
async function openLoginModalPage(): Promise<{ page: Page; errors: string[] }> {
  vi.stubGlobal("fetch", mockActualFetch())
  writeFileSync(join(dir, "irs-limits.json"), "{}")
  server = await startAppServer({
    sessionPath: join(dir, "session.json"),
    dataSourceSessionPath: join(dir, "data-source.json"),
    configPath: join(dir, "config.json"),
    irsLimitsPath: join(dir, "irs-limits.json"),
    federalTaxBracketsPath: join(dir, "federal-tax-brackets.json"),
    irsLifeExpectancyPath: join(dir, "irs-life-expectancy.json"),
    federalPovertyGuidelinesPath: join(dir, "federal-poverty-guidelines.json"),
    uiDir: UI_DIR,
  })
  const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
  page = opened
  const errors: string[] = []
  opened.on("pageerror", (error) => errors.push(error.message))
  await opened.goto(server.url)
  await opened.waitForSelector("#loginBackdrop.open")
  return { page: opened, errors }
}

describe.skipIf(!browser)("File-import data source in a browser", () => {
  it("imports a file from the login modal, lands on Retirement with its accounts, and disables Budget", async () => {
    const { page: ui, errors } = await openLoginModalPage()

    // Starts on the Actual fields -- picking the file radio swaps the visible field group and the
    // submit button's own label, per issue #35's mutually-exclusive-mode design.
    expect(await ui.locator("#actualFields").isVisible()).toBe(true)
    expect(await ui.locator("#fileFields").isVisible()).toBe(false)
    await ui.locator("#dataSourceModeFile").check()
    expect(await ui.locator("#actualFields").isVisible()).toBe(false)
    expect(await ui.locator("#fileFields").isVisible()).toBe(true)
    expect(await ui.locator("#loginSubmitBtn").textContent()).toBe("Import")

    // A real upload -- the file's bytes travel through the browser, not a server-side path (see
    // data-source-session.ts's own 2026-09-21 doc comment on why this replaced the path-based
    // design). setInputFiles hands Playwright an in-memory file, no disk fixture needed. The real
    // "Browse…" trigger button (#importFilePickerBtn) is what a person clicks -- setInputFiles
    // targets the underlying (visually hidden) input directly, which works regardless of how it's
    // triggered.
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nManual Brokerage,50000.00\n") })
    expect(await ui.locator("#importFilePickerName").textContent()).toBe("accounts.csv")
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#loginBackdrop", { state: "hidden" })

    // Lands on Retirement (the default-section fallback redirects there once Budget is disabled),
    // showing the account this file's own row named -- not anything from the mocked Actual fetch.
    await ui.waitForSelector("#accountsList")
    expect(await ui.locator("#accountsList").textContent()).toContain("Manual Brokerage")
    expect(await ui.locator('.section-item[data-section="retirement"]').evaluate((el) => el.classList.contains("active"))).toBe(true)
    expect(await ui.locator('.section-item[data-section="budget"]').evaluate((el) => el.classList.contains("disabled"))).toBe(true)

    // Clicking the disabled Budget tab is a no-op -- Retirement stays the active section.
    await ui.locator('.section-item[data-section="budget"]').click()
    expect(await ui.locator('.section-item[data-section="budget"]').evaluate((el) => el.classList.contains("active"))).toBe(false)

    // The topbar chip reports the file connection, not just silence.
    await ui.waitForSelector("#dataSourceChip:not([hidden])")
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("Accounts")
    expect(errors).toEqual([])
  }, 60000)

  // "Refresh reopens the file picker and re-imports" is now covered by "Refresh reopens the login
  // modal..." below (issue #34/#35's follow-up, 2026-09-22 -- Refresh reopens the full login modal,
  // not a single hidden file input, so both accounts and transactions can be updated together).
})

// Regression coverage for the 2026-09-21 debounce fix (see debounce in app.js) -- tabbing through
// several fields in the same dynamic row (expense adjustments, tax bands) used to trigger an
// immediate PATCH + full row rebuild (innerHTML) after EVERY field's own blur, which could steal
// focus mid-tab. Only unit-testable end to end in a real browser: a route test can't observe
// whether the DOM node itself got torn down and rebuilt, or count real network requests over time.
describe.skipIf(!browser)("Row-commit debounce in a browser", () => {
  it("doesn't rebuild the row (or commit) until a beat after the last edit, and commits exactly once", async () => {
    const { page: ui, errors } = await openBudgetPage()
    await ui.locator('.section-item[data-section="retirement"]').click()
    await ui.waitForSelector("#addExpenseAdjustmentBtn")
    await ui.locator("#addExpenseAdjustmentBtn").click()
    await ui.waitForSelector(".expense-adjustment-row")

    // Attached only after the row exists -- adding it fires its own immediate (non-debounced)
    // PATCH, which isn't part of what this test is checking.
    const patchRequests: string[] = []
    ui.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/api/retirement/plan")) patchRequests.push(req.url())
    })

    const rowHandle = await ui.locator(".expense-adjustment-row").elementHandle()
    const nameInput = ui.locator(".ea-name")
    await nameInput.fill("Kid's college")
    await nameInput.press("Tab") // blurs -- fires the row's own "change" listener
    await ui.waitForTimeout(150) // well under the 500ms debounce
    expect(await ui.evaluate((el) => document.body.contains(el), rowHandle)).toBe(true) // not rebuilt yet
    expect(patchRequests.length).toBe(0) // not committed yet either

    await ui.waitForTimeout(600) // past the debounce
    expect(patchRequests.length).toBe(1) // exactly one commit, not one per field
    expect(await ui.locator(".ea-name").inputValue()).toBe("Kid's college") // the edit itself still landed
    expect(errors).toEqual([])
  }, 60000)
})

// Issue #34/#35's follow-up (2026-09-22): a transactions file is now only ever imported bundled
// with the accounts file, through the Import modal -- there's no separate upload UI on the
// Retirement page any more (the "Transactions file" radio option just picks which source is USED,
// see fileModeSpendSourceField's own doc comment in index.html). Route/unit tests already cover
// parseTransactionRows and categoryGroupsFromTransactions directly; this is what a route test can't
// reach: the actual <input type="file"> flow and what ends up rendered in the DOM.
describe.skipIf(!browser)("Transactions file import in a browser", () => {
  async function importAccountsAndTransactions(ui: Page, transactionsContent: string): Promise<void> {
    await ui.locator("#dataSourceModeFile").check()
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    await ui.locator("#importTransactionsFilePicker").setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(transactionsContent) })
  }

  it("imports a transactions file bundled with the accounts file, deriving real categories into the picker", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    const recentDate = new Date().toISOString().slice(0, 10)
    await importAccountsAndTransactions(ui, `Date,Category_Group,Category,Amount\n${recentDate},Bills,Rent,-1500.00\n`)
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#accountsList")

    await ui.waitForFunction(() => document.querySelector("#expenseCategoryPicker")?.textContent?.includes("Rent") ?? false)
    expect(await ui.locator("#expenseCategoryPicker").textContent()).toContain("Bills")
    // The header chip names the transactions file too, not just the accounts one.
    await ui.waitForSelector("#transactionsChip:not([hidden])")
    expect(await ui.locator("#transactionsChip").textContent()).toContain("transactions.csv")
    expect(errors).toEqual([])
  }, 60000)

  it("Download Template gives back only the columns parseTransactionRows actually reads, and it re-imports cleanly", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await ui.locator("#dataSourceModeFile").check()
    await ui.waitForSelector("#downloadLoginTransactionsTemplateBtn:not([hidden])")

    const [download] = await Promise.all([ui.waitForEvent("download"), ui.locator("#downloadLoginTransactionsTemplateBtn").click()])
    expect(download.suggestedFilename()).toBe("transactions-template.csv")
    const path = await download.path()
    const content = readFileSync(path, "utf8")
    expect(content.split("\n")[0]).toBe("Date,Category_Group,Category,Amount")
    // No stray Account/Payee/etc. columns left over from Actual's real export shape.
    expect(content).not.toMatch(/Account|Payee|Split_Amount|Cleared/)

    // Proves it actually parses, not just that the header line looks right -- the same file this
    // button hands out is what someone will edit and re-upload.
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    await ui.locator("#importTransactionsFilePicker").setInputFiles({ name: "transactions-template.csv", mimeType: "text/csv", buffer: Buffer.from(content) })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#accountsList")
    expect(await ui.locator("#loginError").isHidden()).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("shows the error in the modal (not a partial import) when the bundled transactions file fails to parse", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await importAccountsAndTransactions(ui, "Date,Category\n2026-01-01,Rent\n")
    await ui.locator("#loginSubmitBtn").click()

    await ui.waitForSelector("#loginError:not([hidden])")
    expect(await ui.locator("#loginError").textContent()).toContain("Missing required column")
    // Still on the modal -- the whole import (accounts included) was rejected, not half-applied.
    expect(await ui.locator("#loginBackdrop").isVisible()).toBe(true)
    expect(errors).toEqual([])
  }, 60000)
})

// Issue #34/#35's follow-up (2026-09-22): the Manual/Transactions radio, the header chips
// reopening the login modal to update files, and adding an account directly in the UI. Route tests
// already cover the underlying server logic (fileModeSpendSource precedence, POST
// /api/data-source/accounts) -- this is what a route test can't reach: real DOM visibility (caught
// a real bug here -- .data-source-mode's own display:flex silently overwon its [hidden] attribute
// the first time this was written, exactly the class of bug a route test has no way to see).
describe.skipIf(!browser)("File-mode radio, chip-triggered updates, and Add account in a browser", () => {
  async function importAccountsAndTransactions(ui: Page): Promise<void> {
    await ui.locator("#dataSourceModeFile").check()
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    const recentDate = new Date().toISOString().slice(0, 10)
    await ui.locator("#importTransactionsFilePicker").setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(`Date,Category_Group,Category,Amount\n${recentDate},Bills,Rent,-1500.00\n`) })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#accountsList")
    await ui.waitForSelector("#fileModeSpendSourceField")
    // /api/retirement/check needs a complete plan (requirePlan) to return a real result at all.
    await ui.evaluate(() => fetch("/api/retirement/plan", { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [65], planToAge: 90 }) }))
  }

  it("shows only the selected source's own fields, and switching actually changes what's used", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await importAccountsAndTransactions(ui)

    // A transactions file was just imported -- defaults to that source, not manual, so the manual
    // figure's own field stays hidden.
    await expect.poll(() => ui.locator("#fileModeAnnualExpenseField").isHidden()).toBe(true)
    // Everything spend-history-based (scale/history/categories) shows for "Transactions file".
    expect(await ui.locator("#expenseHistoryFields").isHidden()).toBe(false)
    expect(await ui.locator("#expenseCategoriesField").isHidden()).toBe(false)
    // Captured once, up front, so the later "switched back" assertion is an exact equality (not a
    // weaker .not.toBe -- a poll's own first attempt can pass a negative assertion on transient
    // state, and this repo has already been burned by that once this same session).
    const transactionsAnnualSpend = (await ui.evaluate(() => fetch("/api/retirement/check").then((r) => r.json()) as Promise<{ annualSpend: number }>)).annualSpend

    await ui.locator("#fileModeSpendSourceManual").check()
    await expect.poll(() => ui.locator("#fileModeAnnualExpenseField").isHidden()).toBe(false)
    // "Manual" hides everything history-based -- only Planned expense changes stays regardless.
    expect(await ui.locator("#expenseHistoryFields").isHidden()).toBe(true)
    expect(await ui.locator("#expenseCategoriesField").isHidden()).toBe(true)
    expect(await ui.locator("#addExpenseAdjustmentBtn").isHidden()).toBe(false)
    // The radio is a real switch, not just a display toggle -- confirms the underlying figure
    // actually changed too, not just which section is visible.
    await expect.poll(async () => (await ui.evaluate(() => fetch("/api/retirement/check").then((r) => r.json()) as Promise<{ annualSpend: number }>)).annualSpend).toBe(50000_00)

    // Switching back to Transactions with a file already on hand persists directly -- no detour
    // through the Import modal (that's only for the "nothing to compute from yet" case).
    await ui.locator("#fileModeSpendSourceTransactions").check()
    expect(await ui.locator("#loginBackdrop").isHidden()).toBe(true)
    await expect.poll(() => ui.locator("#fileModeAnnualExpenseField").isHidden()).toBe(true)
    await expect.poll(async () => (await ui.evaluate(() => fetch("/api/retirement/check").then((r) => r.json()) as Promise<{ annualSpend: number }>)).annualSpend, { timeout: 15000 }).toBe(transactionsAnnualSpend)
    expect(errors).toEqual([])
  }, 60000)

  async function importAccountsOnly(ui: Page): Promise<void> {
    await ui.locator("#dataSourceModeFile").check()
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#accountsList")
    await ui.waitForSelector("#fileModeSpendSourceField")
    await ui.evaluate(() => fetch("/api/retirement/plan", { method: "PATCH", body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [65], planToAge: 90 }) }))
  }

  it("selecting Transactions file with none imported yet opens the Import modal, and canceling reverts to Manual", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await importAccountsOnly(ui)
    // No transactions file yet -- defaults to Manual.
    expect(await ui.locator("#fileModeSpendSourceManual").isChecked()).toBe(true)

    await ui.locator("#fileModeSpendSourceTransactions").check()
    await ui.waitForSelector("#loginBackdrop.open")
    expect(await ui.locator("#loginTitle").textContent()).toBe("Update your data")

    await ui.locator("#loginCancelBtn").click()
    expect(await ui.locator("#loginBackdrop").isHidden()).toBe(true)
    // Reverted -- selecting a source with nothing behind it doesn't stick just because the radio
    // was clicked; the figure it actually computes from confirms this isn't just cosmetic either.
    expect(await ui.locator("#fileModeSpendSourceManual").isChecked()).toBe(true)
    await expect.poll(async () => (await ui.evaluate(() => fetch("/api/retirement/check").then((r) => r.json()) as Promise<{ annualSpend: number }>)).annualSpend).toBe(50000_00)
    expect(errors).toEqual([])
  }, 60000)

  it("completing that import selects Transactions file automatically, overriding a prior explicit Manual choice", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await importAccountsOnly(ui)
    // Persist Manual explicitly (not just null, which happens to resolve to Manual too as long as
    // no transactions file exists -- the auto-select on import below needs a real, confirmed prior
    // choice to override, not just today's default reached the same way). Direct PATCH, not a UI
    // click on the radio -- it's already visually checked (that same null-resolves-to-Manual
    // default), and Playwright's own .check() is a no-op on an already-checked radio, so it'd never
    // actually fire the change handler that does the persisting.
    await ui.evaluate(() => fetch("/api/retirement/plan", { method: "PATCH", body: JSON.stringify({ fileModeSpendSource: "manual" }) }))
    await expect.poll(async () => (await ui.evaluate(() => fetch("/api/retirement/state").then((r) => r.json()) as Promise<{ dashboard: { fileModeSpendSource: string | null } }>)).dashboard.fileModeSpendSource).toBe("manual")

    await ui.locator("#fileModeSpendSourceTransactions").check()
    await ui.waitForSelector("#loginBackdrop.open")
    const recentDate = new Date().toISOString().slice(0, 10)
    // Same "an accounts file is always required to submit" rule as every other modal submit above.
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    await ui.locator("#importTransactionsFilePicker").setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(`Date,Category_Group,Category,Amount\n${recentDate},Bills,Rent,-1500.00\n`) })
    await ui.locator("#loginSubmitBtn").click()
    await expect.poll(() => ui.locator("#loginBackdrop").isHidden()).toBe(true)

    await expect.poll(async () => (await ui.evaluate(() => fetch("/api/retirement/state").then((r) => r.json()) as Promise<{ dashboard: { fileModeSpendSource: string | null } }>)).dashboard.fileModeSpendSource).toBe("transactions")
    await expect.poll(() => ui.locator("#fileModeSpendSourceTransactions").isChecked()).toBe(true)
    expect(await ui.locator("#fileModeSpendSourceManual").isChecked()).toBe(false)
    expect(errors).toEqual([])
  }, 60000)

  it("clicking the accounts chip reopens the login modal (with filenames shown), with a working cancel", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await importAccountsAndTransactions(ui)
    await ui.waitForSelector("#dataSourceChip:not([hidden])")
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("accounts.csv")
    expect(await ui.locator("#transactionsChip").textContent()).toContain("transactions.csv")

    await ui.locator("#dataSourceChip").click()
    await ui.waitForSelector("#loginBackdrop.open")
    expect(await ui.locator("#loginTitle").textContent()).toBe("Update your data")
    expect(await ui.locator("#dataSourceModeField").isHidden()).toBe(true) // no need to re-choose a mode
    expect(await ui.locator("#loginModalClose").isVisible()).toBe(true) // unlike first-connect, this one can be cancelled
    expect(await ui.locator("#loginCancelBtn").isVisible()).toBe(true)

    await ui.locator("#loginCancelBtn").click()
    expect(await ui.locator("#loginBackdrop").isHidden()).toBe(true)

    // A real update: picking a new accounts file through the chip actually replaces the account
    // list. The transactions chip reopens the exact same modal.
    await ui.locator("#transactionsChip").click()
    await ui.waitForSelector("#loginBackdrop.open")
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts2.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nUpdated Brokerage,75000.00\n") })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Updated Brokerage") ?? false)
    expect(errors).toEqual([])
  }, 60000)

  it("adds an account through the UI, persisted the same as an imported one", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await ui.locator("#dataSourceModeFile").check()
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from("name,balance\nBrokerage,500000.00\n") })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#accountsList")
    await ui.waitForSelector("#addAccountField")

    await ui.locator("#newAccountName").fill("Savings")
    await ui.locator("#newAccountBalance").fill("10000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Savings") ?? false)

    // Persisted -- a page reload still shows it, not just the in-memory STATE from the add itself.
    await ui.reload()
    await ui.waitForSelector("#accountsList")
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Savings") ?? false)
    expect(errors).toEqual([])
  }, 60000)

  it("exports the current accounts back to the same name,balance shape the login screen imports", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await ui.locator("#dataSourceModeFile").check()
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from('name,balance\n"Smith, John\'s IRA",50000.00\n') })
    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#exportAccountsBtn:not([hidden])")

    const [download] = await Promise.all([ui.waitForEvent("download"), ui.locator("#exportAccountsBtn").click()])
    expect(download.suggestedFilename()).toBe("accounts-export.csv")
    const path = await download.path()
    const content = readFileSync(path, "utf8")
    expect(content).toBe('name,balance\n"Smith, John\'s IRA",50000.00\n')
    expect(errors).toEqual([])
  }, 60000)
})
