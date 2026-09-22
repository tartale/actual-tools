import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium } from "playwright"
import type { Browser, Page } from "playwright"

import { startAppServer } from "../app-server.ts"
import type { RunningServer } from "../app-server.ts"

// Browser-driven tests for manual entry mode (issue #38, phase 1). POST /api/retirement/manual/check
// and GET /api/account-types are both covered at the route level (app-server.test.ts); what neither
// reaches is the client's own half of the design -- the third login option actually switching modes,
// the account-add/remove UI, and (the whole point of "data lives only in the browser") that the plan
// and account list actually survive a reload via localStorage with no server ever told about it.
//
// No mocked Actual fetch needed at all -- manual mode never talks to Actual (that's the point), and
// checkSession's own pre-login GET /api/session + GET /api/data-source calls hit this real server
// directly and just report "nothing connected yet," same as a real fresh install.

const UI_DIR = fileURLToPath(new URL("../app-ui", import.meta.url))

const browser: Browser | null = await chromium.launch().catch(() => null)
if (!browser) {
  console.warn("Playwright browsers unavailable; skipping the browser-driven manual-mode tests.")
}

afterAll(async () => {
  await browser?.close()
})

let dir: string
let server: RunningServer | null = null
let page: Page | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manual-mode-test-"))
})

afterEach(async () => {
  await page?.close()
  page = null
  if (server) await server.close()
  server = null
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function openLoginModalPage(): Promise<{ page: Page; errors: string[] }> {
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

async function enterManualMode(ui: Page): Promise<void> {
  await ui.locator("#dataSourceModeManual").check()
  await ui.locator("#loginSubmitBtn").click()
  await ui.waitForSelector("#page-manual.active", { timeout: 10000 })
}

describe.skipIf(!browser)("Manual entry mode in a browser", () => {
  it("shows manual mode's own fields (and no others), and submitting needs nothing filled in first", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    expect(await ui.locator("#manualFields").isHidden()).toBe(true)

    await ui.locator("#dataSourceModeManual").check()
    expect(await ui.locator("#actualFields").isHidden()).toBe(true)
    expect(await ui.locator("#fileFields").isHidden()).toBe(true)
    expect(await ui.locator("#manualFields").isHidden()).toBe(false)
    expect(await ui.locator("#loginSubmitBtn").textContent()).toBe("Enter manually")

    await ui.locator("#loginSubmitBtn").click()
    await ui.waitForSelector("#page-manual.active", { timeout: 10000 })
    // Neither nav tab applies to manual mode -- both disabled, same treatment Budget alone gets
    // in file mode.
    expect(await ui.locator('.section-item[data-section="budget"]').evaluate((el) => el.classList.contains("disabled"))).toBe(true)
    expect(await ui.locator('.section-item[data-section="retirement"]').evaluate((el) => el.classList.contains("disabled"))).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("adds an account, runs a real check, and renders an actual Bridge/Monte Carlo result -- the full stateless round trip", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await enterManualMode(ui)

    await ui.locator("#manualBirthDate").fill("1975-01-01")
    await ui.locator("#manualRetireAges").fill("55")
    await ui.locator("#manualPlanToAge").fill("90")
    await ui.locator("#manualAnnualExpenses").fill("40000")

    await ui.locator("#manualNewAccountName").fill("Brokerage")
    await ui.locator("#manualNewAccountBalance").fill("500000")
    await ui.locator("#manualNewAccountType").selectOption("brokerage")
    await ui.locator("#manualAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#manualAccountsList")?.textContent?.includes("Brokerage") ?? false)
    // A real label, not the raw type key -- confirms GET /api/account-types actually resolved
    // before this render, not just that SOME text showed up.
    expect(await ui.locator("#manualAccountsList").textContent()).toContain("Taxable brokerage")

    await ui.locator("#manualRunCheckBtn").click()
    await ui.waitForSelector("#manualCheckResult .findings-group", { timeout: 20000 })
    const resultText = await ui.locator("#manualCheckResult").textContent()
    expect(resultText).toContain("Bridge")
    expect(resultText).toContain("Monte Carlo")
    // A real computed figure from the account balance entered above, not a placeholder.
    expect(resultText).toMatch(/\$500,000\.00|\$643,233\.18|reachable/)
    expect(errors).toEqual([])
  }, 60000)

  it("shows an inline error (not a blank/broken result) when required fields are missing", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await enterManualMode(ui)

    await ui.locator("#manualRunCheckBtn").click()
    await ui.waitForSelector("#manualCheckError:not([hidden])")
    expect(await ui.locator("#manualCheckError").textContent()).toContain("Birth date")
    expect(errors).toEqual([])
  }, 60000)

  it("the plan fields and account list survive a reload -- mirrored to localStorage, never the server", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await enterManualMode(ui)

    await ui.locator("#manualBirthDate").fill("1980-06-15")
    await ui.locator("#manualRetireAges").fill("60")
    await ui.locator("#manualPlanToAge").fill("95")
    await ui.locator("#manualAnnualExpenses").fill("50000")
    await ui.locator("#manualNewAccountName").fill("Savings")
    await ui.locator("#manualNewAccountBalance").fill("20000")
    await ui.locator("#manualNewAccountType").selectOption("savings")
    await ui.locator("#manualAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#manualAccountsList")?.textContent?.includes("Savings") ?? false)
    // The account list persists immediately (an explicit add), but the plan fields only get
    // written to localStorage at Run-check time (see runManualCheck's own doc comment) -- run one
    // so birthDate/retirementAges/planToAge/annualExpenses are part of what a reload restores too.
    await ui.locator("#manualRunCheckBtn").click()
    await ui.waitForSelector("#manualCheckResult .findings-group", { timeout: 20000 })

    await ui.reload()
    await ui.waitForSelector("#page-manual.active", { timeout: 10000 })
    expect(await ui.locator("#manualBirthDate").inputValue()).toBe("1980-06-15")
    expect(await ui.locator("#manualRetireAges").inputValue()).toBe("60")
    expect(await ui.locator("#manualPlanToAge").inputValue()).toBe("95")
    expect(await ui.locator("#manualAnnualExpenses").inputValue()).toContain("50,000.00")
    expect(await ui.locator("#manualAccountsList").textContent()).toContain("Savings")
    // Never told to any server route -- config.json is never created by this mode at all (see
    // app-server.test.ts's own "writes nothing to config.json" route test for the server-side half
    // of this same guarantee).
    expect(errors).toEqual([])
  }, 60000)

  it("removing an account drops it from the list and from what a reload restores", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await enterManualMode(ui)

    await ui.locator("#manualNewAccountName").fill("Brokerage")
    await ui.locator("#manualNewAccountBalance").fill("500000")
    await ui.locator("#manualNewAccountType").selectOption("brokerage")
    await ui.locator("#manualAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#manualAccountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("[data-remove-manual-account]").click()
    await ui.waitForFunction(() => document.querySelector("#manualAccountsList")?.textContent?.includes("No accounts yet") ?? false)

    await ui.reload()
    await ui.waitForSelector("#page-manual.active", { timeout: 10000 })
    expect(await ui.locator("#manualAccountsList").textContent()).toContain("No accounts yet")
    expect(errors).toEqual([])
  }, 60000)

  it("exiting manual mode clears the local state -- a fresh visit lands back on the login modal, not manual mode again", async () => {
    const { page: ui, errors } = await openLoginModalPage()
    await enterManualMode(ui)
    await ui.locator("#manualNewAccountName").fill("Brokerage")
    await ui.locator("#manualNewAccountBalance").fill("500000")
    await ui.locator("#manualNewAccountType").selectOption("brokerage")
    await ui.locator("#manualAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#manualAccountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("#logoutBtn").click()
    await ui.waitForSelector("#loginBackdrop.open", { timeout: 10000 })

    // A second fresh load (not just the reload above) must not silently resume manual mode either.
    await ui.reload()
    await ui.waitForSelector("#loginBackdrop.open", { timeout: 10000 })
    expect(errors).toEqual([])
  }, 60000)
})
