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

// Browser-driven tests for the "Early-access suggestions" modal (issue #28 -- Rule of 55/SEPP
// options that would help the plan's outcome). GET /api/retirement/suggestions itself is well
// covered at the route level (app-server.test.ts), but nothing exercised the modal's own DOM: the
// suggestion cards actually rendering, a checkbox/radio actually enabling Apply, or Apply actually
// PATCHing the account it should.
//
// No stub Actual server: startAppServer runs inside this process and its outbound calls are
// stubbed with vi.stubGlobal("fetch", ...), same as every other server-backed test in this repo.

const actualConfig: ActualConfig = { baseUrl: "https://actual.test/v1", budgetId: "budget-1", apiKey: "secret-key" }
const realFetch = globalThis.fetch
const UI_DIR = fileURLToPath(new URL("../app-ui", import.meta.url))

const browser: Browser | null = await chromium.launch().catch(() => null)
if (!browser) {
  console.warn("Playwright browsers unavailable; skipping the browser-driven suggestions tests.")
}

afterAll(async () => {
  await browser?.close()
})

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

// A single traditional-401k, locked until its default access age (59) -- retiring at 55 makes the
// whole portfolio unreachable at retirement unless Rule of 55 or SEPP unlocks it early, so both
// options independently qualify and get suggested (mirrors app-server.test.ts's own "suggests Rule
// of 55 for an eligible account" fixture, the same shape a real qualifying account looks like).
const ACCOUNTS = [{ id: "401k", name: "Fidelity 401k", offbudget: true, closed: false }]
const CATEGORY = { id: "cat-a", name: "Rent", is_income: false, hidden: false, group_id: "g1", budgeted: 0, spent: -4000_00, balance: 0, carryover: false } // $48,000/yr

function mockActualFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url)
    if (u.hostname !== "actual.test") {
      return realFetch(url, init)
    }
    if (/\/accounts$/.test(u.pathname)) return jsonResponse({ data: ACCOUNTS })
    if (/\/categorygroups$/.test(u.pathname)) return jsonResponse({ data: [{ id: "g1", name: "Group", is_income: false, hidden: false, categories: [CATEGORY] }] })
    const txMatch = /\/accounts\/([^/]+)\/transactions/.exec(u.pathname)
    if (txMatch) return jsonResponse({ data: txMatch[1] === "401k" ? [{ amount: 100_000_00, transfer_id: null }] : [] })
    if (/\/months\/[^/]+\/categories$/.test(u.pathname)) return jsonResponse({ data: [CATEGORY] })
    if (/\/run-query$/.test(u.pathname)) return jsonResponse({ data: [] })
    if (init?.method === "PATCH") return jsonResponse({})
    return jsonResponse({ data: [] })
  })
}

let dir: string
let server: RunningServer | null = null
let page: Page | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suggestions-test-"))
})

afterEach(async () => {
  await page?.close()
  page = null
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function openRetirementPage(): Promise<{ page: Page; errors: string[] }> {
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
    body: JSON.stringify({ birthDate: "1975-01-01", retirementAges: [55], planToAge: 90 }),
  })
  await fetch(`${server.url}api/retirement/accounts/401k`, { method: "PATCH", body: JSON.stringify({ type: "traditional-401k" }) })

  const opened = await (browser as Browser).newPage({ viewport: { width: 1400, height: 1000 } })
  page = opened
  const errors: string[] = []
  opened.on("pageerror", (error) => errors.push(error.message))
  await opened.goto(server.url)
  await opened.locator('.section-item[data-section="retirement"]').click()
  await opened.waitForSelector("#checkResult .finding, #checkResult .empty-note", { state: "attached", timeout: 20000 })
  return { page: opened, errors }
}

describe.skipIf(!browser)("Early-access suggestions modal in a browser", () => {
  it("opens and renders both a Rule of 55 and a SEPP option for the same qualifying account", async () => {
    const { page: ui, errors } = await openRetirementPage()

    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector("#suggestionsBackdrop.open")
    await ui.waitForSelector(".suggestion-card", { timeout: 20000 })
    // Enabled as soon as there's at least one suggestion to apply -- NOT gated on a checkbox/radio
    // actually being checked (applySuggestions itself is a no-op with nothing checked, so clicking
    // Apply here would just close the modal without changing anything).
    expect(await ui.locator("#suggestionsApplyBtn").isDisabled()).toBe(false)

    const bodyText = await ui.locator("#suggestionsBody").textContent()
    expect(bodyText).toContain("Elect Rule of 55")
    expect(bodyText).toContain("Fidelity 401k")
    expect(bodyText).toContain("Elect a 72(t) SEPP schedule")
    expect(bodyText).toContain("Targeting the lowest configured retirement age (55)")
    expect(errors).toEqual([])
  }, 60000)

  it("Apply is disabled when there are no suggestions at all", async () => {
    const { page: ui, errors } = await openRetirementPage()
    // A separation age already set removes Rule of 55; a SEPP election already set removes SEPP --
    // together, nothing left to suggest for the only account in this fixture.
    await ui.evaluate(() => fetch("/api/retirement/accounts/401k", { method: "PATCH", body: JSON.stringify({ ruleOf55SeparationAge: 55, seppMethod: "rmd", seppStartAge: 55 }) }))

    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector("#suggestionsBackdrop.open")
    await ui.waitForSelector("#suggestionsBody .empty-note", { timeout: 20000 })
    expect(await ui.locator("#suggestionsBody").textContent()).toContain("No early-access option would improve this plan's outcome right now.")
    expect(await ui.locator("#suggestionsApplyBtn").isDisabled()).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("Apply persists the checked Rule of 55 option to the account, and closes the modal", async () => {
    const { page: ui, errors } = await openRetirementPage()
    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector(".suggestion-card", { timeout: 20000 })

    await ui.locator('.suggestion-input[data-kind="rule-of-55"]').check()
    await ui.locator("#suggestionsApplyBtn").click()
    await ui.waitForSelector("#suggestionsBackdrop", { state: "hidden", timeout: 20000 })

    // The target retirement age (55) becomes the account's own ruleOf55SeparationAge -- a real
    // PATCH, not just a modal that closes without doing anything.
    await expect
      .poll(async () => (await ui.evaluate(() => fetch("/api/retirement/state").then((r) => r.json()) as Promise<{ accounts: { id: string; ruleOf55SeparationAge: number | null }[] }>)).accounts.find((a) => a.id === "401k")?.ruleOf55SeparationAge)
      .toBe(55)
    expect(errors).toEqual([])
  }, 60000)

  it("Apply persists the selected SEPP method and start age instead, when that's what's checked", async () => {
    const { page: ui, errors } = await openRetirementPage()
    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector(".suggestion-card", { timeout: 20000 })

    await ui.locator('.suggestion-input[data-kind="sepp"][data-method="amortization"]').check()
    await ui.locator("#suggestionsApplyBtn").click()
    await ui.waitForSelector("#suggestionsBackdrop", { state: "hidden", timeout: 20000 })

    const account = await ui.evaluate(() => fetch("/api/retirement/state").then((r) => r.json()) as Promise<{ accounts: { id: string; seppMethod: string | null; seppStartAge: number | null }[] }>).then((s) => s.accounts.find((a) => a.id === "401k"))
    expect(account?.seppMethod).toBe("amortization")
    expect(account?.seppStartAge).toBe(55)
    expect(errors).toEqual([])
  }, 60000)

  it("Escape and the backdrop click both close the modal without applying anything", async () => {
    const { page: ui, errors } = await openRetirementPage()
    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector(".suggestion-card", { timeout: 20000 })

    await ui.keyboard.press("Escape")
    await ui.waitForSelector("#suggestionsBackdrop", { state: "hidden", timeout: 20000 })

    await ui.locator("#suggestionsOpenBtn").click()
    await ui.waitForSelector(".suggestion-card", { timeout: 20000 })
    // Click the backdrop itself, not the modal content -- closeSuggestions only fires when the
    // click target IS the backdrop (e.target === e.currentTarget), not a click that bubbles from
    // inside the modal.
    await ui.locator("#suggestionsBackdrop").click({ position: { x: 5, y: 5 } })
    await ui.waitForSelector("#suggestionsBackdrop", { state: "hidden", timeout: 20000 })

    const account = await ui.evaluate(() => fetch("/api/retirement/state").then((r) => r.json()) as Promise<{ accounts: { id: string; ruleOf55SeparationAge: number | null }[] }>).then((s) => s.accounts.find((a) => a.id === "401k"))
    expect(account?.ruleOf55SeparationAge).toBeNull()
    expect(errors).toEqual([])
  }, 60000)
})
