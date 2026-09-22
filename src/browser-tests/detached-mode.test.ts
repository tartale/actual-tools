import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium } from "playwright"
import type { Browser, Page } from "playwright"

import { startAppServer } from "../app-server.ts"
import type { RunningServer } from "../app-server.ts"

// Browser-driven tests for detached mode (issue #38) -- a whole server run with AB_MODE=detached,
// not a runtime login choice (see app-server.ts's own MODE gate, which is what makes this
// server-driven design real rather than cosmetic). Unified onto the real Retirement page's own
// Plan/Expense Projection/Accounts/Simulation Settings cards and STATE/render pipeline
// (2026-09-22) -- there's no bespoke #page-detached or minimal account editor left at all, so
// these tests drive the exact same elements the linked/file-mode browser tests do
// (src/browser-tests/app-ui.test.ts). POST /api/retirement/detached/{check,state} and the MODE
// gate itself are covered at the route level (app-server.test.ts); what neither reaches is the
// client's own half: that a detached server skips the login modal entirely and lands straight on
// #page-retirement, that the real rich account editor actually persists a detached-mode edit
// (there's no server-side override store to fall back on if the client-side merge is wrong), and
// (the whole point of "data lives only in the browser") that the plan and account list actually
// survive a reload via localStorage with no server ever told about it.
//
// No mocked Actual fetch needed at all -- detached mode never talks to Actual (that's the point),
// and its own routes are reachable with no login step of any kind.

const UI_DIR = fileURLToPath(new URL("../app-ui", import.meta.url))

const browser: Browser | null = await chromium.launch().catch(() => null)
if (!browser) {
  console.warn("Playwright browsers unavailable; skipping the browser-driven detached-mode tests.")
}

afterAll(async () => {
  await browser?.close()
})

let dir: string
let server: RunningServer | null = null
let page: Page | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "detached-mode-test-"))
})

afterEach(async () => {
  await page?.close()
  page = null
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function openDetachedPage(): Promise<{ page: Page; errors: string[] }> {
  server = await startAppServer({
    sessionPath: join(dir, "session.json"),
    dataSourceSessionPath: join(dir, "data-source.json"),
    configPath: join(dir, "config.json"),
    irsLimitsPath: join(dir, "irs-limits.json"),
    federalTaxBracketsPath: join(dir, "federal-tax-brackets.json"),
    irsLifeExpectancyPath: join(dir, "irs-life-expectancy.json"),
    federalPovertyGuidelinesPath: join(dir, "federal-poverty-guidelines.json"),
    uiDir: UI_DIR,
    mode: "detached",
  })
  const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
  page = opened
  const errors: string[] = []
  opened.on("pageerror", (error) => errors.push(error.message))
  await opened.goto(server.url)
  await opened.waitForSelector("#page-retirement.active", { timeout: 10000 })
  return { page: opened, errors }
}

// Fills the Plan card's own fields and commits each -- .press("Tab") forces the blur every one of
// these fields' own "change" (or, for the money field, "moneycommit" on blur -- see
// attachMoneyFormatting) listener needs, the same as a real person tabbing to the next field.
async function fillPlanFields(ui: Page): Promise<void> {
  await ui.locator("#birthDate").fill("1975-01-01")
  await ui.locator("#birthDate").press("Tab")
  await ui.locator("#retireAges").fill("55")
  await ui.locator("#retireAges").press("Tab")
  await ui.locator("#planToAge").fill("90")
  await ui.locator("#planToAge").press("Tab")
  await ui.locator("#fileModeAnnualExpense").fill("40000")
  await ui.locator("#fileModeAnnualExpense").press("Tab")
}

describe.skipIf(!browser)("Detached mode in a browser", () => {
  it("lands directly on #page-retirement with no login modal, nav visible but Budget disabled", async () => {
    const { page: ui, errors } = await openDetachedPage()
    expect(await ui.locator("#loginBackdrop").isVisible()).toBe(false)
    expect(await ui.locator(".sections").isHidden()).toBe(false)
    expect(await ui.locator('.section-item[data-section="budget"]').evaluate((el) => el.classList.contains("disabled"))).toBe(true)
    expect(await ui.locator("#logoutBtn").getAttribute("title")).toBe("Clear my data")
    expect(errors).toEqual([])
  }, 60000)

  it("adds an account through the real Accounts card, edits its type/allocation, and renders a real Bridge/Monte Carlo result", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await fillPlanFields(ui)

    await ui.locator("#newAccountName").fill("Brokerage")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Brokerage") ?? false)

    // A fresh account defaults to type "other" (same as a fresh file/linked-mode account -- see
    // applyAccountPatch's own not-found branch), so the portfolio-only fields (allocation, expected
    // return) start hidden -- picking a real portfolio type here is what a person configuring a
    // brand new detached-mode account would actually do next.
    const row = ui.locator("#accountsList .account-row", { hasText: "Brokerage" })
    await row.locator("select[data-field='type']").selectOption("brokerage")
    await ui.waitForFunction(() => (document.querySelector("#accountsList") as HTMLElement)?.innerText?.includes("Allocation"))
    const rowAfterType = ui.locator("#accountsList .account-row", { hasText: "Brokerage" })
    await rowAfterType.locator("select[data-field='allocationPreset']").selectOption({ index: 1 })

    // A findings-group already exists from the boot-time check (type "other" -- not part of the
    // investable portfolio, so nothing is reachable yet); poll for the SPECIFIC content the
    // type+allocation edits above should produce, not just "a findings-group exists," since that
    // would pass on the stale pre-edit result too (scheduleRecheck's own 500ms debounce means the
    // real recheck settles slightly after the last edit, not synchronously with it).
    await expect.poll(async () => (await ui.locator("#checkResult").textContent()) ?? "", { timeout: 20000 }).toContain("Monte Carlo")
    const resultText = await ui.locator("#checkResult").textContent()
    expect(resultText).toContain("Bridge")
    expect(resultText).toContain("reachable at retirement (100%)")
    expect(errors).toEqual([])
  }, 60000)

  it("shows an inline error (not a blank/broken result) when required plan fields are missing", async () => {
    const { page: ui, errors } = await openDetachedPage()
    // The initial boot-time check fires automatically (activateSection's own "land on Retirement"
    // behavior, unchanged from linked/file mode) against a completely empty draft.
    await ui.waitForSelector("#checkResult .empty-note", { timeout: 20000 })
    expect(await ui.locator("#checkResult").textContent()).toContain("birth date")
    expect(errors).toEqual([])
  }, 60000)

  it("the plan fields and account list survive a reload -- mirrored to localStorage, never the server", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await fillPlanFields(ui)

    await ui.locator("#newAccountName").fill("Savings")
    await ui.locator("#newAccountBalance").fill("20000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Savings") ?? false)
    await ui.waitForSelector("#checkResult .findings-group", { timeout: 20000 })

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Savings") ?? false)
    expect(await ui.locator("#birthDate").inputValue()).toBe("1975-01-01")
    expect(await ui.locator("#retireAges").inputValue()).toBe("55")
    expect(await ui.locator("#planToAge").inputValue()).toBe("90")
    expect(await ui.locator("#fileModeAnnualExpense").inputValue()).toContain("40,000.00")
    expect(errors).toEqual([])
  }, 60000)

  it("removing an account drops it from the list and from what a reload restores", async () => {
    const { page: ui, errors } = await openDetachedPage()

    await ui.locator("#newAccountName").fill("Brokerage")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("#accountsList [data-remove-account]").click()
    await ui.waitForFunction(() => !(document.querySelector("#accountsList")?.textContent?.includes("Brokerage") ?? false))

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    expect(await ui.locator("#accountsList").textContent()).not.toContain("Brokerage")
    expect(errors).toEqual([])
  }, 60000)

  it("\"Clear my data\" (the logout icon) resets in place, with no reload and nothing left for a later visit to restore", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await fillPlanFields(ui)
    await ui.locator("#newAccountName").fill("Brokerage")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("#logoutBtn").click()
    await ui.waitForFunction(() => !(document.querySelector("#accountsList")?.textContent?.includes("Brokerage") ?? false))
    // Still on the same page -- no navigation, no whole-page reload (there's nowhere else to go).
    expect(await ui.locator("#page-retirement").isVisible()).toBe(true)
    expect(await ui.locator("#birthDate").inputValue()).toBe("")

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    expect(await ui.locator("#accountsList").textContent()).not.toContain("Brokerage")
    expect(await ui.locator("#birthDate").inputValue()).toBe("")
    expect(errors).toEqual([])
  }, 60000)
})
