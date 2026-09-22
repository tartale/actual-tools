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
// (src/browser-tests/app-ui.test.ts). Its own accounts/transactions import was unified onto file
// mode's exact same header-chip + modal UI the same day, per the user's own "these should match"
// request -- there is no detached-only import control left to test separately from that shared one.
// POST /api/retirement/detached/{check,state,parse-accounts,expense-categories} and the MODE gate
// itself are covered at the route level (app-server.test.ts); what neither reaches is the client's
// own half: that a detached server skips the login modal entirely at boot and lands straight on
// #page-retirement with its own nav/subline hidden, that the shared import modal actually merges
// into the client-held draft instead of POSTing to file mode's own persistent /api/data-source,
// that the real rich account editor persists a detached-mode edit (there's no server-side override
// store to fall back on if the client-side merge is wrong), and (the whole point of "data lives
// only in the browser") that the plan/account/transactions state actually survives a reload via
// localStorage with no server ever told about it.
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

// Opens the same shared import modal file mode's own header chips use (see #dataSourceChip's own
// doc comment in index.html) and submits an accounts file, an optional transactions file, or both
// -- exactly the flow a detached-mode person actually clicks through, rather than driving the
// underlying routes directly.
async function importViaModal(ui: Page, { accountsCsv, transactionsCsv }: { accountsCsv?: string; transactionsCsv?: string }): Promise<void> {
  await ui.locator("#dataSourceChip").click()
  await ui.waitForSelector("#loginBackdrop.open")
  if (accountsCsv !== undefined) {
    await ui.locator("#importFilePicker").setInputFiles({ name: "accounts.csv", mimeType: "text/csv", buffer: Buffer.from(accountsCsv) })
  }
  if (transactionsCsv !== undefined) {
    await ui.locator("#importTransactionsFilePicker").setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(transactionsCsv) })
  }
  await ui.locator("#loginSubmitBtn").click()
}

describe.skipIf(!browser)("Detached mode in a browser", () => {
  it("lands directly on #page-retirement with no login modal, nav and the Actual-Budget subline hidden, Budget internally disabled", async () => {
    const { page: ui, errors } = await openDetachedPage()
    expect(await ui.locator("#loginBackdrop").isVisible()).toBe(false)
    // Removed entirely for detached mode (2026-09-22, per the user's own request) -- there's only
    // ever one page here (Budget never works), and no Actual connection to be a "companion" to.
    expect(await ui.locator(".sections").isHidden()).toBe(true)
    expect(await ui.locator(".wordmark .subline").isHidden()).toBe(true)
    expect(await ui.locator('.section-item[data-section="budget"]').evaluate((el) => el.classList.contains("disabled"))).toBe(true)
    expect(await ui.locator("#logoutBtn").getAttribute("title")).toBe("Clear my data")
    expect(errors).toEqual([])
  }, 60000)

  it("adds an account through the real Accounts card, edits its type, and renders a real Bridge/Monte Carlo result", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await fillPlanFields(ui)

    // Named to not collide (Playwright's hasText is case-insensitive) with the seeded example
    // account -- "Example brokerage" -- which is present here too, see defaultDetachedDraft.
    await ui.locator("#newAccountName").fill("New Account")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountsList")?.textContent?.includes("New Account") ?? false)

    // A fresh account defaults to type "other" (same as a fresh file/linked-mode account -- see
    // applyAccountPatch's own not-found branch), so the portfolio-only fields (allocation, expected
    // return) start hidden -- picking a real portfolio type here is what a person configuring a
    // brand new detached-mode account would actually do next, and is what proves patchAccount's
    // detached-mode branch actually persists an edit (not just that adding an account works).
    const row = ui.locator("#accountsList .account-row", { hasText: "New Account" })
    await row.locator("select[data-field='type']").selectOption("brokerage")
    // Scoped to THIS row, not the whole #accountsList -- the seeded example account is already a
    // portfolio type and already shows its own Allocation field, so a list-wide text check would
    // pass immediately regardless of whether this edit took effect at all.
    await row.locator("select[data-field='allocationPreset']").waitFor({ state: "visible" })

    // A findings-group already exists from the boot-time check (the seeded example account alone);
    // poll for the SPECIFIC number the new account's type edit above should produce as the wait
    // condition itself, not just "a findings-group exists" (true of the pre-edit result too) or
    // "Monte Carlo" (also true of an intermediate render that can land between the edit and
    // scheduleRecheck's own 500ms-debounced settle).
    await expect.poll(async () => (await ui.locator("#checkResult").textContent()) ?? "", { timeout: 20000 }).toContain("reachable at retirement (100%)")
    const resultText = await ui.locator("#checkResult").textContent()
    expect(resultText).toContain("Bridge")
    expect(resultText).toContain("Monte Carlo")
    expect(errors).toEqual([])
  }, 60000)

  it("boots directly into a complete, working example -- no setup needed, real Bridge/Monte Carlo content immediately", async () => {
    const { page: ui, errors } = await openDetachedPage()
    // No field-filling, no account-adding -- this is the page exactly as a first-time visitor
    // with an empty browser sees it. Detached mode has no server-side fallback for a missing birth
    // date the way file mode's own annual-expense figure has (see requirePlan), so without a seeded
    // example this would show an error, not a working tool -- see defaultDetachedDraft's own doc
    // comment for why that matters specifically for this mode.
    await expect.poll(async () => (await ui.locator("#checkResult").textContent()) ?? "", { timeout: 20000 }).toContain("Monte Carlo")
    expect(await ui.locator("#birthDate").inputValue()).toBe("1986-01-01")
    expect(await ui.locator("#retireAges").inputValue()).toBe("65")
    expect(await ui.locator("#fileModeAnnualExpense").inputValue()).toContain("50,000.00")
    expect(await ui.locator("#accountCountHint").textContent()).toBe("1 open accounts")
    expect(await ui.locator("#accountsList").textContent()).toContain("Example brokerage")
    expect(await ui.locator("#checkResult").textContent()).toContain("Bridge")
    // The chips read "using the example/nothing imported" until something real is imported (2026-
    // 09-22, per the user's own "the chips should indicate that" request) -- never a real filename
    // for data that was never actually uploaded.
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("example data")
    expect(await ui.locator("#transactionsChip").textContent()).toContain("none imported")
    expect(errors).toEqual([])
  }, 60000)

  it("still shows a clear inline error (not a blank/broken result) if birth date is cleared", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.waitForSelector("#checkResult .findings-group", { timeout: 20000 }) // the example's own boot-time result
    await ui.locator("#birthDate").fill("")
    await ui.locator("#birthDate").press("Tab")
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

  it("the header chip reopens the same shared import modal file mode uses, with no Actual-vs-file choice to make", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.locator("#dataSourceChip").click()
    await ui.waitForSelector("#loginBackdrop.open")
    expect(await ui.locator("#loginTitle").textContent()).toBe("Import accounts / transactions")
    expect(await ui.locator("#dataSourceModeField").isHidden()).toBe(true)
    expect(await ui.locator("#loginModalClose").isVisible()).toBe(true) // cancelable -- there's always something to fall back to
    expect(await ui.locator("#fileFields").isHidden()).toBe(false)
    expect(errors).toEqual([])
  }, 60000)

  it("importing accounts and a transactions file together replaces the example, switches to Transactions file, and it survives a reload", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")

    const recentDate = new Date().toISOString().slice(0, 10)
    await importViaModal(ui, {
      accountsCsv: "name,balance\nImported Brokerage,75000.00\nImported Savings,15000.00\n",
      transactionsCsv: `Date,Category_Group,Category,Amount\n${recentDate},Bills,Rent,-1500.00\n`,
    })
    // REPLACES the seeded example, not appended to it -- same "starting fresh" semantics as file
    // mode's own accounts-file import.
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "2 open accounts")
    expect(await ui.locator("#accountsList").textContent()).not.toContain("Example brokerage")
    expect(await ui.locator("#accountsList").textContent()).toContain("Imported Brokerage")
    expect(await ui.locator("#accountsList").textContent()).toContain("Imported Savings")
    // Same "match what was just done" behavior as file mode's own combined import -- a bundled
    // transactions file becomes the active expense source immediately, not left on Manual.
    await expect.poll(() => ui.locator("#fileModeSpendSourceTransactions").isChecked(), { timeout: 15000 }).toBe(true)
    // The chips now name the real files, not "example data"/"none imported" any more.
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("accounts.csv")
    expect(await ui.locator("#transactionsChip").textContent()).toContain("transactions.csv")
    // Real category groups derived from the transactions file, same as file mode's own picker.
    await expect.poll(() => ui.locator("#expenseCategoryPicker").textContent(), { timeout: 15000 }).toContain("Rent")
    await ui.waitForSelector("#checkResult .findings-group", { timeout: 20000 })

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "2 open accounts")
    expect(await ui.locator("#accountsList").textContent()).toContain("Imported Brokerage")
    expect(await ui.locator("#fileModeSpendSourceTransactions").isChecked()).toBe(true)
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("accounts.csv")
    expect(errors).toEqual([])
  }, 60000)

  it("shows an inline error in the modal for a malformed accounts file, without touching anything", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")

    await importViaModal(ui, { accountsCsv: "not,the,right,header\n" })
    await ui.waitForSelector("#loginError:not([hidden])")
    expect(await ui.locator("#loginError").textContent()).toContain("name,balance")
    // The modal itself stays open (a failed submit doesn't silently close it), and the seeded
    // example is still exactly what it was -- a failed import doesn't half-apply.
    expect(await ui.locator("#loginBackdrop").isHidden()).toBe(false)
    expect(await ui.locator("#accountCountHint").textContent()).toBe("1 open accounts")
    expect(await ui.locator("#accountsList").textContent()).toContain("Example brokerage")
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("example data")
    expect(errors).toEqual([])
  }, 60000)

  it("removing an account drops it from the list and from what a reload restores, leaving the seeded example alone", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")

    // Named to not collide (Playwright's hasText is case-insensitive) with the seeded example
    // account -- "Example brokerage" -- already present here, see defaultDetachedDraft.
    await ui.locator("#newAccountName").fill("New Account")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "2 open accounts")

    await ui.locator("#accountsList .account-row", { hasText: "New Account" }).locator("[data-remove-account]").click()
    // "no longer contains New Account" alone is a weak wait condition here -- it's also trivially
    // true the instant loadState() sets its own "Loading accounts…" placeholder, well before the
    // real post-removal state has actually loaded and rendered. #accountCountHint is written only
    // by renderSummary() (inside the real render(), never the placeholder), so waiting for its
    // exact expected text is the positive, unambiguous signal that the removal really landed.
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")
    expect(await ui.locator("#accountsList").textContent()).not.toContain("New Account")
    expect(await ui.locator("#accountsList").textContent()).toContain("Example brokerage")

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")
    expect(await ui.locator("#accountsList").textContent()).not.toContain("New Account")
    expect(errors).toEqual([])
  }, 60000)

  it("\"Clear my data\" (the logout icon) resets to the same seeded example, with no reload, and nothing custom left for a later visit to restore", async () => {
    const { page: ui, errors } = await openDetachedPage()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")
    await fillPlanFields(ui)
    await ui.locator("#newAccountName").fill("New Account")
    await ui.locator("#newAccountBalance").fill("500000")
    await ui.locator("#addAccountBtn").click()
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "2 open accounts")

    await ui.locator("#logoutBtn").click()
    // Resets to the SAME seeded example defaultDetachedDraft() provides everywhere else -- not a
    // blank state (see its own doc comment) -- so #accountCountHint back to exactly 1 is the
    // positive, unambiguous signal the real cleared-and-reseeded render actually landed, not
    // merely "New Account is gone," which is also true of the loadState() placeholder shown well
    // before the clear actually lands.
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")
    // Still on the same page -- no navigation, no whole-page reload (there's nowhere else to go).
    expect(await ui.locator("#page-retirement").isVisible()).toBe(true)
    expect(await ui.locator("#accountsList").textContent()).not.toContain("New Account")
    expect(await ui.locator("#accountsList").textContent()).toContain("Example brokerage")
    expect(await ui.locator("#birthDate").inputValue()).toBe("1986-01-01")
    expect(await ui.locator("#dataSourceChip").textContent()).toContain("example data")
    expect(await ui.locator("#transactionsChip").textContent()).toContain("none imported")

    await ui.reload()
    await ui.waitForSelector("#page-retirement.active", { timeout: 10000 })
    await ui.waitForFunction(() => document.querySelector("#accountCountHint")?.textContent === "1 open accounts")
    expect(await ui.locator("#accountsList").textContent()).not.toContain("New Account")
    expect(await ui.locator("#birthDate").inputValue()).toBe("1986-01-01")
    expect(errors).toEqual([])
  }, 60000)
})
