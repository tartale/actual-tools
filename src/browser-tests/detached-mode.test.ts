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
// server-driven design real rather than cosmetic). POST /api/retirement/detached/check and the
// MODE gate itself are covered at the route level (app-server.test.ts); what neither reaches is
// the client's own half: that a detached server skips the login modal entirely and lands straight
// on #page-detached, that the account-add/remove UI works, and (the whole point of "data lives
// only in the browser") that the plan and account list actually survive a reload via localStorage
// with no server ever told about it.
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
  await opened.waitForSelector("#page-detached.active", { timeout: 10000 })
  return { page: opened, errors }
}

describe.skipIf(!browser)("Detached mode in a browser", () => {
  it("lands directly on #page-detached with no login modal, and the nav is hidden entirely", async () => {
    const { page: ui, errors } = await openDetachedPage()
    expect(await ui.locator("#loginBackdrop").isVisible()).toBe(false)
    expect(await ui.locator(".sections").isHidden()).toBe(true)
    expect(errors).toEqual([])
  }, 60000)

  it("adds an account, runs a real check, and renders an actual Bridge/Monte Carlo result -- the full stateless round trip", async () => {
    const { page: ui, errors } = await openDetachedPage()

    await ui.locator("#detachedBirthDate").fill("1975-01-01")
    await ui.locator("#detachedRetireAges").fill("55")
    await ui.locator("#detachedPlanToAge").fill("90")
    await ui.locator("#detachedAnnualExpenses").fill("40000")

    await ui.locator("#detachedNewAccountName").fill("Brokerage")
    await ui.locator("#detachedNewAccountBalance").fill("500000")
    await ui.locator("#detachedNewAccountType").selectOption("brokerage")
    await ui.locator("#detachedAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("Brokerage") ?? false)
    // A real label, not the raw type key -- confirms GET /api/account-types actually resolved
    // before this render, not just that SOME text showed up.
    expect(await ui.locator("#detachedAccountsList").textContent()).toContain("Taxable brokerage")

    await ui.locator("#detachedRunCheckBtn").click()
    await ui.waitForSelector("#detachedCheckResult .findings-group", { timeout: 20000 })
    const resultText = await ui.locator("#detachedCheckResult").textContent()
    expect(resultText).toContain("Bridge")
    expect(resultText).toContain("Monte Carlo")
    expect(resultText).toMatch(/\$500,000\.00|\$643,233\.18|reachable/)
    expect(errors).toEqual([])
  }, 60000)

  it("shows an inline error (not a blank/broken result) when required fields are missing", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.locator("#detachedRunCheckBtn").click()
    await ui.waitForSelector("#detachedCheckError:not([hidden])")
    expect(await ui.locator("#detachedCheckError").textContent()).toContain("Birth date")
    expect(errors).toEqual([])
  }, 60000)

  it("the plan fields and account list survive a reload -- mirrored to localStorage, never the server", async () => {
    const { page: ui, errors } = await openDetachedPage()

    await ui.locator("#detachedBirthDate").fill("1980-06-15")
    await ui.locator("#detachedRetireAges").fill("60")
    await ui.locator("#detachedPlanToAge").fill("95")
    await ui.locator("#detachedAnnualExpenses").fill("50000")
    await ui.locator("#detachedNewAccountName").fill("Savings")
    await ui.locator("#detachedNewAccountBalance").fill("20000")
    await ui.locator("#detachedNewAccountType").selectOption("savings")
    await ui.locator("#detachedAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("Savings") ?? false)
    // The account list persists immediately (an explicit add), but the plan fields only get
    // written to localStorage at Run-check time (see runDetachedCheck's own doc comment) -- run
    // one so birthDate/retirementAges/planToAge/annualExpenses are part of what a reload restores.
    await ui.locator("#detachedRunCheckBtn").click()
    await ui.waitForSelector("#detachedCheckResult .findings-group", { timeout: 20000 })

    await ui.reload()
    await ui.waitForSelector("#page-detached.active", { timeout: 10000 })
    expect(await ui.locator("#detachedBirthDate").inputValue()).toBe("1980-06-15")
    expect(await ui.locator("#detachedRetireAges").inputValue()).toBe("60")
    expect(await ui.locator("#detachedPlanToAge").inputValue()).toBe("95")
    expect(await ui.locator("#detachedAnnualExpenses").inputValue()).toContain("50,000.00")
    expect(await ui.locator("#detachedAccountsList").textContent()).toContain("Savings")
    expect(errors).toEqual([])
  }, 60000)

  it("removing an account drops it from the list and from what a reload restores", async () => {
    const { page: ui, errors } = await openDetachedPage()

    await ui.locator("#detachedNewAccountName").fill("Brokerage")
    await ui.locator("#detachedNewAccountBalance").fill("500000")
    await ui.locator("#detachedNewAccountType").selectOption("brokerage")
    await ui.locator("#detachedAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("[data-remove-detached-account]").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("No accounts yet") ?? false)

    await ui.reload()
    await ui.waitForSelector("#page-detached.active", { timeout: 10000 })
    expect(await ui.locator("#detachedAccountsList").textContent()).toContain("No accounts yet")
    expect(errors).toEqual([])
  }, 60000)

  it("\"Clear my data\" (the logout icon) resets in place, with no reload and nothing left for a later visit to restore", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.locator("#detachedNewAccountName").fill("Brokerage")
    await ui.locator("#detachedNewAccountBalance").fill("500000")
    await ui.locator("#detachedNewAccountType").selectOption("brokerage")
    await ui.locator("#detachedAddAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("Brokerage") ?? false)

    await ui.locator("#logoutBtn").click()
    await ui.waitForFunction(() => document.querySelector("#detachedAccountsList")?.textContent?.includes("No accounts yet") ?? false)
    // Still on the same page -- no navigation, no reload (there's nowhere else to go).
    expect(await ui.locator("#page-detached").isVisible()).toBe(true)

    await ui.reload()
    await ui.waitForSelector("#page-detached.active", { timeout: 10000 })
    expect(await ui.locator("#detachedAccountsList").textContent()).toContain("No accounts yet")
    expect(errors).toEqual([])
  }, 60000)
})
