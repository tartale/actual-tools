// Vanilla JS, no framework, no build step -- this is a config form, not a heavy client app. All
// state lives on the server (config.json); this file's only job is to render what GET
// /api/retirement/state returns and PATCH/POST the endpoints when something changes.

let STATE = null
// The non-income category groups from GET /api/budget/context, cached here so the Spend
// configuration section's expense-category picker (see renderExpenseCategoryPicker) can redraw on
// every render() without refetching -- categories don't change from inside this app, so one fetch
// per page load suffices.
let EXPENSE_CATEGORY_GROUPS = null
// The category/month-range a "Find anomalies" run just used, so "Tag flagged transactions" can
// re-run the exact same query server-side (see runTagAnomalies) without the client having to
// round-trip full Finding objects (each carrying a full CategoryMonth) back to the server.
let lastAnomalyQuery = null
// A single in-flight guard for every mutating action -- a "Max" toggle is really two sequential
// requests (clear a sibling, then set this one), and without a lock, an impatient second click
// during that window could interleave a second pair of requests, so the account you clicked isn't
// what ends up as "max" moments later. Ignoring a click while one chain is already running is
// simpler and safer than trying to cancel/merge overlapping requests.
let requestInFlight = false
// The account row currently being dragged (see renderAccounts' drag handle wiring), tracked at
// module scope since the list container's own dragover listener is wired once (below), not
// re-wired on every render the way each row's dragstart/dragend listeners are.
let draggingAccountRow = null

function setBusy(busy) {
  requestInFlight = busy
  document.body.classList.toggle("busy", busy)
}

// Function to run one exclusive round of edits (a plain field change, or a "Max" toggle's whole
// clear-sibling-then-set chain) -- ignored, not queued, if another one is already in flight.
async function runExclusive(fn) {
  if (requestInFlight) return
  setBusy(true)
  try {
    await fn()
  } finally {
    setBusy(false)
  }
}

function usd(cents) {
  const sign = cents < 0 ? "-" : ""
  return sign + "$" + (Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Splits a formatted dollar string ("$1,234.56"/"-$1,234.56", from usd()/usdCompact() alike) into
// the sign+$ prefix and the digits -- privacy mode blurs only the digits (see .money in style.css),
// leaving the $ itself (and any leading -) visible so a blurred figure still reads as "this is a
// dollar amount," not just an unreadable smudge. Returns ready-to-insert HTML.
function moneyHtml(formatted) {
  const dollarIndex = formatted.indexOf("$")
  return `${formatted.slice(0, dollarIndex + 1)}<span class="money">${formatted.slice(dollarIndex + 1)}</span>`
}

// Chart text (the SVG axis/markers, and the hover tooltip) swaps its own dollar/age content for a
// fixed placeholder in privacy mode, rather than relying on the .money blur filter every other
// dollar figure on the page uses -- a real bug hit building this: CSS filter on an SVG <tspan> (the
// only way to style part of one <text> element differently from the rest) doesn't reliably render
// in every engine (computed style reports blur(6px), nothing visibly blurs), and the tooltip is
// rebuilt fresh on every pointermove regardless, so there's no re-render step to hang a blur toggle
// off anyway. Swapping content sidesteps both problems, and is the same convention Actual's own UI
// uses for masked figures. Both keep the real content when privacy mode is off, so callers can use
// these unconditionally without their own if/else.
function moneyMaskText(formatted, isPrivate) {
  if (!isPrivate) return formatted
  const dollarIndex = formatted.indexOf("$")
  return `${formatted.slice(0, dollarIndex + 1)}~~~~~`
}
function ageMaskText(value, isPrivate) {
  return isPrivate ? "~~" : String(value)
}

// Wraps a read-only dollar figure so privacy mode (see the eye toggle) can blur it without
// touching the ones still being edited (plain <input> values are never wrapped in this).
function moneySpan(cents) {
  return `<span class="num">${moneyHtml(usd(cents))}</span>`
}

// A dollar <input> stores/shows a comma-formatted string ("1,500.00") at rest, since a native
// type="number" input can never render commas -- these are type="text" instead. Strips any
// currency symbol/commas/whitespace before parsing, so pasting a formatted figure back in (or
// leaving one from the last render) still works.
function parseMoneyInputCents(text) {
  const cleaned = text.replace(/[^0-9.-]/g, "")
  if (cleaned === "" || cleaned === "-") return null
  const dollars = parseFloat(cleaned)
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null
}
function formatMoneyInputValue(cents) {
  return cents == null ? "" : (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// Function to wire the focus/blur pair every dollar <input> needs: plain digits while editing (so
// typing isn't fighting inserted commas), reformatted with commas the moment it's not. Also fires
// a "moneycommit" event on blur when the value actually changed -- callers listen for that instead
// of the native "change" event, because the focus handler's own rewrite of input.value (formatted
// -> plain digits) becomes the browser's new baseline for its dirty check, so retyping the same
// number back (e.g. "10,000.00" -> focus rewrites to "10000" -> user types "10000" again) leaves
// the field textually identical to that baseline and the native "change" event never fires at all.
function attachMoneyFormatting(input) {
  if (!input) return
  let centsAtFocus = null
  input.addEventListener("focus", () => {
    centsAtFocus = parseMoneyInputCents(input.value)
    input.value = centsAtFocus == null ? "" : (centsAtFocus / 100).toString()
    // Rewriting .value above drops the caret at the end with nothing selected, so typing right
    // after a click appends to the old number instead of replacing it -- select it all so typing
    // overwrites, the way clicking into a pre-filled amount field is expected to behave.
    input.select()
  })
  input.addEventListener("blur", () => {
    const cents = parseMoneyInputCents(input.value)
    input.value = formatMoneyInputValue(cents)
    if (cents !== centsAtFocus) input.dispatchEvent(new Event("moneycommit"))
  })
}

// onRetry is optional -- when given, the banner grows a Retry button wired to it (used by
// loadState's initial-load failure, where the server itself already retried a few times -- see
// actualRequest's own retry loop in actual-helpers.ts -- so a further failure here is worth a
// one-click way to try again without a full page reload, rather than just a static message).
function showError(message, onRetry) {
  const el = document.getElementById("topError")
  if (onRetry) {
    el.innerHTML = `<span>${escapeHtml(message)}</span> <button type="button" class="btn secondary error-retry">Retry</button>`
    el.querySelector(".error-retry").addEventListener("click", onRetry)
  } else {
    el.textContent = message
  }
  el.hidden = false
}
function clearError() {
  document.getElementById("topError").hidden = true
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options && options.headers) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error((body && body.error) || `Request to ${path} failed (${res.status})`)
  }
  return body
}

async function loadState() {
  // The server itself already retries a transient Actual-still-starting-up failure a few times
  // (actualRequest in actual-helpers.ts) before this ever rejects, so a slow-but-eventually-fine
  // load can take a couple of seconds -- this placeholder is what fills that window instead of a
  // blank accounts list that looks broken/frozen.
  document.getElementById("accountsList").innerHTML = `<div class="empty-note">Loading accounts…</div>`
  try {
    STATE = await api("/api/retirement/state")
    clearError()
    saveSkeletonCache(STATE)
    render()
  } catch (error) {
    showError(error.message, () => loadState())
    document.getElementById("accountsList").innerHTML = `<div class="empty-note">Couldn't load accounts — see error above.</div>`
  }
}

async function patchPlan(partial, savedFlagId) {
  try {
    STATE = await api("/api/retirement/plan", { method: "PATCH", body: JSON.stringify(partial) })
    clearError()
    render()
    flashSaved(savedFlagId)
    scheduleRecheck()
  } catch (error) {
    showError(error.message)
  }
}

async function patchAccount(id, partial) {
  try {
    STATE = await api(`/api/retirement/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(partial) })
    clearError()
    render()
    scheduleRecheck()
  } catch (error) {
    showError(error.message)
  }
}

async function reorderAccounts(orderedIds) {
  try {
    STATE = await api("/api/retirement/accounts/order", { method: "PATCH", body: JSON.stringify({ orderedIds }) })
    clearError()
    render()
    scheduleRecheck()
  } catch (error) {
    showError(error.message)
  }
}

function flashSaved(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.add("show")
  setTimeout(() => el.classList.remove("show"), 1400)
}

function render() {
  if (!STATE) return
  renderSummary()
  revealTopSectionIfReady()
  renderPlan()
  renderIncome()
  renderSimSettings()
  renderWithdrawalRule()
  renderTaxBands()
  renderExpenseCategoryPicker()
  renderExpenseAdjustments()
  renderAccounts()
  // Restoring "retirement" as the remembered active section (see the activateSection call at the
  // bottom of this file) fires runCheck() synchronously at page load, well before this STATE fetch
  // (a real ~3.7s round trip through Actual's own API) resolves -- so the very first call renders
  // renderLoadingSkeleton's plain LOADING_MARKUP fallback, never the real axis/legend/title version
  // that needs STATE. Re-running it here, now that STATE actually exists, upgrades that fallback in
  // place. Only while the check itself is still pending (retirementChecked but not firstCheckDone
  // yet) -- render() fires on every later STATE update too (any field edit's own patch), and must
  // never clobber real chart content that's already showing with this loading placeholder again.
  if (retirementChecked && !firstCheckDone) {
    renderLoadingSkeleton()
  }
}

function renderSummary() {
  const portfolioAccounts = STATE.accounts.filter((a) => a.isPortfolio)
  const portfolioTotal = portfolioAccounts.reduce((sum, a) => sum + a.balance, 0)
  document.getElementById("sumPortfolio").innerHTML = `${moneySpan(portfolioTotal)} <span class="tile-note">(${portfolioAccounts.length} account${portfolioAccounts.length === 1 ? "" : "s"})</span>`
  document.getElementById("accountCountHint").textContent = `${STATE.accounts.length} open accounts`
}

function renderPlan() {
  const birthInput = document.getElementById("birthDate")
  const agesInput = document.getElementById("retireAges")
  const planInput = document.getElementById("planToAge")
  const filingStatusInput = document.getElementById("filingStatus")
  const householdSizeInput = document.getElementById("householdSize")
  const acaTargetPctFplInput = document.getElementById("acaTargetPctFpl")
  const medicareAgeInput = document.getElementById("medicareAge")
  const acaFloorPctFplInput = document.getElementById("acaFloorPctFpl")
  // Only overwrite a field the user isn't actively editing -- avoids clobbering keystrokes if a
  // response from one field's PATCH arrives while another is still focused.
  if (document.activeElement !== birthInput) birthInput.value = STATE.dashboard.birthDate ?? ""
  if (document.activeElement !== agesInput) agesInput.value = STATE.dashboard.retirementAges.join(", ")
  if (document.activeElement !== planInput) planInput.value = STATE.dashboard.planToAge
  if (document.activeElement !== filingStatusInput) filingStatusInput.value = STATE.dashboard.filingStatus ?? ""
  if (document.activeElement !== householdSizeInput) householdSizeInput.value = STATE.dashboard.householdSize ?? ""
  if (document.activeElement !== acaTargetPctFplInput) acaTargetPctFplInput.value = STATE.dashboard.acaTargetPctFpl ?? ""
  if (document.activeElement !== medicareAgeInput) medicareAgeInput.value = STATE.dashboard.medicareAge ?? ""
  if (document.activeElement !== acaFloorPctFplInput) acaFloorPctFplInput.value = STATE.dashboard.acaFloorPctFpl ?? ""
  document.getElementById("ageDerived").textContent = STATE.currentAge ?? "—"
}

// Renders the optional Pension/Social Security boxes and attaches their money-field formatting --
// these patch the same /api/retirement/plan route as birth date/retirement ages, since they're
// plan-wide facts, not tied to any one Actual account.
function renderIncome() {
  const d = STATE.dashboard
  const fields = [
    ["pensionStartAge", d.pensionStartAge ?? ""],
    ["ss62", formatMoneyInputValue(d.socialSecurityMonthlyAt62)],
    ["ss67", formatMoneyInputValue(d.socialSecurityMonthlyAt67)],
    ["ss70", formatMoneyInputValue(d.socialSecurityMonthlyAt70)],
  ]
  fields.forEach(([id, value]) => {
    const el = document.getElementById(id)
    if (document.activeElement !== el) el.value = value
  })
  const pensionAmountEl = document.getElementById("pensionMonthlyAmount")
  if (document.activeElement !== pensionAmountEl) pensionAmountEl.value = formatMoneyInputValue(d.pensionMonthlyAmount)
  const claimSelect = document.getElementById("ssClaimAge")
  if (document.activeElement !== claimSelect) claimSelect.value = d.socialSecurityClaimingAge == null ? "" : String(d.socialSecurityClaimingAge)
}

// Renders the "Simulation settings" fields a person can pin (see fire-dashboard.ts's
// monteCarloAssumptionsWithOverrides) so every retirement-age comparison widget uses the same
// value -- an empty field means "not entered," not zero.
function renderSimSettings() {
  const d = STATE.dashboard
  const setIfIdle = (id, value) => {
    const el = document.getElementById(id)
    if (document.activeElement !== el) el.value = value
  }
  setIfIdle("mcWithdrawalStrategy", d.monteCarloWithdrawalStrategy ?? "")
  setIfIdle("mcReturnModel", d.monteCarloReturnModel ?? "")
  setIfIdle("mcTaxModel", d.monteCarloTaxModel ?? "")
  setIfIdle("mcInflationMean", d.monteCarloInflationMean == null ? "" : Math.round(d.monteCarloInflationMean * 1000) / 10)
  setIfIdle("mcInflationStdDev", d.monteCarloInflationStdDev == null ? "" : Math.round(d.monteCarloInflationStdDev * 1000) / 10)
  setIfIdle("mcMinimumWithdrawal", formatMoneyInputValue(d.monteCarloMinimumWithdrawal))
  setIfIdle("mcSimulationCount", d.monteCarloSimulationCount ?? "")
  setIfIdle("crossoverExpenseAdjustment", d.crossoverExpenseAdjustmentFactor == null ? "" : Math.round(d.crossoverExpenseAdjustmentFactor * 100))
  setIfIdle("crossoverSpendHistoryMonths", d.crossoverSpendHistoryMonths ?? "")
}

// Withdrawal rule (see MonteCarloWithdrawalRuleMeta in fire-accounts.ts): pinned as one whole
// object rather than field-by-field like the other Simulation settings, since its own parameters
// vary by type and only make sense together. WR_TYPE_TO_BLOCK_ID's keys are the DOM ids for each
// type's own parameter block (index.html), shown/hidden based on the currently selected type --
// same "reveal the fields that make sense once a variant is picked" pattern as the account-type
// conditional fields (see .acct-fields .field.hidden in style.css).
const WR_TYPE_TO_BLOCK_ID = {
  guardrails: "wrParamsGuardrails",
  ratcheting: "wrParamsRatcheting",
  "floor-ceiling": "wrParamsFloorCeiling",
  boundaries: "wrParamsBoundaries",
}
// pct: true fields are decimal fractions (0.2 = 20%) shown/entered as a plain percent number, same
// convention as every other rate field in this app -- balanceThresholdMultiple (a multiple of the
// initial balance) and consecutiveYears (a plain count) are the only two that aren't.
const WR_FIELD_DEFS = [
  { key: "prosperityTriggerPct", inputId: "wrProsperityTriggerPct", pct: true },
  { key: "prosperityIncreasePct", inputId: "wrProsperityIncreasePct", pct: true },
  { key: "preservationTriggerPct", inputId: "wrPreservationTriggerPct", pct: true },
  { key: "preservationCutPct", inputId: "wrPreservationCutPct", pct: true },
  { key: "balanceThresholdMultiple", inputId: "wrBalanceThresholdMultiple", pct: false },
  { key: "consecutiveYears", inputId: "wrConsecutiveYears", pct: false },
  { key: "ratchetIncreasePct", inputId: "wrRatchetIncreasePct", pct: true },
  { key: "floorPct", inputId: "wrFloorPct", pct: true },
  { key: "ceilingPct", inputId: "wrCeilingPct", pct: true },
  { key: "upperRateThreshold", inputId: "wrUpperRateThreshold", pct: true },
  { key: "upperCutPct", inputId: "wrUpperCutPct", pct: true },
  { key: "lowerRateThreshold", inputId: "wrLowerRateThreshold", pct: true },
  { key: "lowerIncreasePct", inputId: "wrLowerIncreasePct", pct: true },
]

function renderWithdrawalRule() {
  const rule = STATE.dashboard.monteCarloWithdrawalRule
  const typeSelect = document.getElementById("mcWithdrawalRuleType")
  if (document.activeElement !== typeSelect) typeSelect.value = rule?.type ?? ""
  Object.values(WR_TYPE_TO_BLOCK_ID).forEach((blockId) => {
    document.getElementById(blockId).hidden = true
  })
  if (rule && WR_TYPE_TO_BLOCK_ID[rule.type]) {
    document.getElementById(WR_TYPE_TO_BLOCK_ID[rule.type]).hidden = false
  }
  WR_FIELD_DEFS.forEach(({ key, inputId, pct }) => {
    const el = document.getElementById(inputId)
    if (document.activeElement === el) return
    const value = rule ? rule[key] : undefined
    el.value = value == null ? "" : pct ? Math.round(value * 1000) / 10 : value
  })
}

// Renders the Tax bands list (see MonteCarloTaxBandMeta) -- pinned as a whole array, same
// "authoritative once set" convention as withdrawalRule above. `from` is cents (matches
// minimumWithdrawal's own convention -- both compare directly against withdrawal amounts in the
// vendored engine); `rate` is a decimal fraction like every other rate field.
function renderTaxBands() {
  const bands = STATE.dashboard.monteCarloTaxBands
  const container = document.getElementById("taxBandsList")
  container.innerHTML = (bands ?? [])
    .map(
      (band) => `
    <div class="tax-band-row" data-band-id="${escapeHtml(band.id)}">
      <div class="field">
        <label>From</label>
        <div class="input-affix prefix-dollar"><input type="text" inputmode="decimal" class="tb-from" placeholder="0" value="${escapeHtml(formatMoneyInputValue(band.from ?? null))}"></div>
      </div>
      <div class="field">
        <label>Rate</label>
        <div class="input-affix suffix-percent"><input type="number" step="0.1" class="tb-rate" placeholder="not entered" value="${band.rate == null ? "" : Math.round(band.rate * 1000) / 10}"></div>
      </div>
      <button type="button" class="tax-band-remove" title="Remove band" aria-label="Remove band">×</button>
    </div>`,
    )
    .join("")
  container.querySelectorAll(".tax-band-row").forEach((row) => {
    const bandId = row.dataset.bandId
    const fromInput = row.querySelector(".tb-from")
    attachMoneyFormatting(fromInput)
    const commitRow = () => {
      const next = (STATE.dashboard.monteCarloTaxBands ?? []).map((band) =>
        band.id === bandId ? { id: bandId, from: parseMoneyInputCents(fromInput.value) ?? undefined, rate: rateInput.value === "" ? undefined : parseFloat(rateInput.value) / 100 } : band,
      )
      runExclusive(() => patchPlan({ monteCarloTaxBands: next }, "savedSimSettings"))
    }
    const rateInput = row.querySelector(".tb-rate")
    fromInput.addEventListener("moneycommit", commitRow)
    rateInput.addEventListener("change", commitRow)
    row.querySelector(".tax-band-remove").addEventListener("click", () => {
      const next = (STATE.dashboard.monteCarloTaxBands ?? []).filter((band) => band.id !== bandId)
      runExclusive(() => patchPlan({ monteCarloTaxBands: next }, "savedSimSettings"))
    })
  })
}

let taxBandIdCounter = 0
// Plain timestamp+counter id, not crypto.randomUUID() -- this app is also reached over plain HTTP
// from other devices on the LAN (see the server's own startup banner), which isn't a secure
// context, and randomUUID throws there.
function nextTaxBandId() {
  taxBandIdCounter += 1
  return `band-${Date.now()}-${taxBandIdCounter}`
}

// Function to render the Expense adjustments list (issue #24) -- same add/edit/remove-row pattern
// as renderTaxBands just above (one dynamic list item per ExpenseAdjustment, a whole-array PATCH
// on every edit rather than a per-field route), with a sign selector splitting the stored signed
// annualAmount into a magnitude the user enters as a MONTHLY figure (matching pensionMonthlyAmount's
// own convention) and a +/- direction, rather than asking for a signed number directly.
function renderExpenseAdjustments() {
  const adjustments = STATE.dashboard.expenseAdjustments
  const container = document.getElementById("expenseAdjustmentsList")
  container.innerHTML = adjustments
    .map(
      (adjustment) => `
    <div class="expense-adjustment-row" data-adjustment-id="${escapeHtml(adjustment.id)}">
      <div class="field">
        <label>Name</label>
        <input type="text" class="ea-name" value="${escapeHtml(adjustment.name)}">
      </div>
      <div class="field">
        <label>Effect</label>
        <select class="ea-sign">
          <option value="1"${adjustment.annualAmount >= 0 ? " selected" : ""}>Additional expense (+)</option>
          <option value="-1"${adjustment.annualAmount < 0 ? " selected" : ""}>Reduced expense (-)</option>
        </select>
      </div>
      <div class="field">
        <label>Monthly amount</label>
        <div class="input-affix prefix-dollar"><input type="text" inputmode="decimal" class="ea-amount" value="${escapeHtml(formatMoneyInputValue(Math.round(Math.abs(adjustment.annualAmount) / 12)))}"></div>
      </div>
      <div class="field">
        <label>Start age</label>
        <input type="number" min="1" class="ea-start-age" value="${adjustment.startAge}">
      </div>
      <div class="field">
        <label>End age</label>
        <input type="number" min="1" class="ea-end-age" placeholder="none" value="${adjustment.endAge ?? ""}">
      </div>
      <div class="field ea-inflate-field">
        <label class="checkbox-label"><input type="checkbox" class="ea-inflate"${adjustment.inflate ? " checked" : ""}> Grows with inflation</label>
      </div>
      <button type="button" class="icon-btn ea-remove" title="Remove" aria-label="Remove expense adjustment">✕</button>
    </div>`,
    )
    .join("")
  container.querySelectorAll(".expense-adjustment-row").forEach((row) => {
    const adjustmentId = row.dataset.adjustmentId
    const amountInput = row.querySelector(".ea-amount")
    attachMoneyFormatting(amountInput)
    const commitRow = () => {
      const signInput = row.querySelector(".ea-sign")
      const startAgeInput = row.querySelector(".ea-start-age")
      const endAgeInput = row.querySelector(".ea-end-age")
      const inflateInput = row.querySelector(".ea-inflate")
      const monthlyAmount = parseMoneyInputCents(amountInput.value) ?? 0
      const next = STATE.dashboard.expenseAdjustments.map((adjustment) =>
        adjustment.id === adjustmentId
          ? {
              id: adjustmentId,
              name: row.querySelector(".ea-name").value,
              annualAmount: monthlyAmount * 12 * Number(signInput.value),
              startAge: startAgeInput.value === "" ? adjustment.startAge : parseInt(startAgeInput.value, 10),
              endAge: endAgeInput.value === "" ? null : parseInt(endAgeInput.value, 10),
              inflate: inflateInput.checked,
            }
          : adjustment,
      )
      runExclusive(() => patchPlan({ expenseAdjustments: next }, "savedExpenseAdjustments"))
    }
    row.querySelector(".ea-name").addEventListener("change", commitRow)
    row.querySelector(".ea-sign").addEventListener("change", commitRow)
    amountInput.addEventListener("moneycommit", commitRow)
    row.querySelector(".ea-start-age").addEventListener("change", commitRow)
    row.querySelector(".ea-end-age").addEventListener("change", commitRow)
    row.querySelector(".ea-inflate").addEventListener("change", commitRow)
    row.querySelector(".ea-remove").addEventListener("click", () => {
      const next = STATE.dashboard.expenseAdjustments.filter((adjustment) => adjustment.id !== adjustmentId)
      runExclusive(() => patchPlan({ expenseAdjustments: next }, "savedExpenseAdjustments"))
    })
  })
}

let expenseAdjustmentIdCounter = 0
function nextExpenseAdjustmentId() {
  expenseAdjustmentIdCounter += 1
  return `expense-${Date.now()}-${expenseAdjustmentIdCounter}`
}

// Function to render the Spend configuration section's own expense-category picker (see
// fire-accounts.ts's DashboardConfig.crossoverExpenseCategoryIds) from the cached
// /api/budget/context fetch (see loadExpenseCategoryOptions) -- income categories are excluded
// server-side, same set spendFromLocalSelection falls back to. The checklist is always visible (no
// "use every category" master toggle) -- a null selection (nothing customized yet) renders every
// non-hidden category checked, matching the actual server-side default.
//
// Each group is its own foldable section with a tri-state "select all in this group" checkbox
// (setTriState, shared with the Budget table's own group checkboxes below) and a live N/total
// count, so a folded group's selection is still legible without opening it. "Show hidden" reveals
// categories Actual itself has hidden (excluded from allIds/the default selection either way,
// but selectable once shown); "Hide unchecked" is a pure view filter, narrowing the list to what's
// already checked without changing the underlying selection. Fold state lives in
// EXPENSE_CATEGORY_FOLDS (a plain Set of collapsed group ids), and the two toggles live in
// EXPENSE_CATEGORY_VIEW, both independent of STATE so they survive the full re-render every
// checkbox change triggers -- redrawn on every render() (not just after its own fetch) the same way
// renderSimSettings et al. are; checkboxes have no in-progress-typing state to protect the way a
// text <input> does, so there's no idle guard needed here.
// Persisted the same way RETIREMENT_SECTIONS' own fold state is (see saveSectionFolds/
// applySectionFolds) -- a cookie of collapsed group ids, read once here at load (group ids are
// stable Actual category-group ids, so a saved set from a previous session still means the same
// groups) and rewritten on every fold/unfold and Expand/Collapse all below.
let EXPENSE_CATEGORY_FOLDS = new Set()
try {
  const savedFolds = getCookie("expenseCategoryFolds")
  if (savedFolds) EXPENSE_CATEGORY_FOLDS = new Set(savedFolds.split(","))
} catch {
  // Cookies disabled -- starts fully expanded for this page view, same as the default.
}
function saveExpenseCategoryFolds() {
  try {
    setCookie("expenseCategoryFolds", [...EXPENSE_CATEGORY_FOLDS].join(","))
  } catch {
    // Cookies disabled -- folding still works for this page view, it just won't be remembered.
  }
}
// Persisted the same simple "1"/"0" way privacyMode's own cookie is -- see
// [[persist-expand-collapse-state]] (this isn't a fold, but the same "don't reset a view
// preference on refresh" principle applies to it too). The checkboxes themselves are restored to
// match once the DOM's ready, near the bottom of this file.
let EXPENSE_CATEGORY_VIEW
try {
  EXPENSE_CATEGORY_VIEW = { showHidden: getCookie("expenseCategoriesShowHidden") === "1", hideUnchecked: getCookie("expenseCategoriesHideUnchecked") === "1" }
} catch {
  EXPENSE_CATEGORY_VIEW = { showHidden: false, hideUnchecked: false }
}
function saveExpenseCategoryView() {
  try {
    setCookie("expenseCategoriesShowHidden", EXPENSE_CATEGORY_VIEW.showHidden ? "1" : "0")
    setCookie("expenseCategoriesHideUnchecked", EXPENSE_CATEGORY_VIEW.hideUnchecked ? "1" : "0")
  } catch {
    // Cookies disabled -- the view filters still work for this page view, they just won't be remembered.
  }
}

// Same pattern as EXPENSE_CATEGORY_FOLDS just above -- a cookie of collapsed account ids, read once
// at load and rewritten on every fold/unfold, so an account's own expand/collapse state survives a
// refresh the same way (see [[persist-expand-collapse-state]]).
let ACCOUNT_FOLDS = new Set()
try {
  const savedAccountFolds = getCookie("accountFolds")
  if (savedAccountFolds) ACCOUNT_FOLDS = new Set(savedAccountFolds.split(","))
} catch {
  // Cookies disabled -- starts fully expanded for this page view, same as the default.
}
function saveAccountFolds() {
  try {
    setCookie("accountFolds", [...ACCOUNT_FOLDS].join(","))
  } catch {
    // Cookies disabled -- folding still works for this page view, it just won't be remembered.
  }
}

function renderExpenseCategoryPicker() {
  const container = document.getElementById("expenseCategoryPicker")
  if (!EXPENSE_CATEGORY_GROUPS || !STATE) return
  const selected = STATE.dashboard.crossoverExpenseCategoryIds
  const allIds = EXPENSE_CATEGORY_GROUPS.flatMap((group) => group.categories.filter((category) => !category.hidden).map((category) => category.id))
  const checkedIds = new Set(selected === null ? allIds : selected)
  // Two independent filters over the same group/category data: "selectable" (respects Show
  // hidden, decides what the group's own N/total count is out of) and "displayed" (selectable,
  // further narrowed by Hide unchecked -- a pure view filter that never changes the count).
  const groupsToRender = EXPENSE_CATEGORY_GROUPS.map((group) => {
    const selectable = group.categories.filter((category) => EXPENSE_CATEGORY_VIEW.showHidden || !category.hidden)
    const displayed = selectable.filter((category) => !EXPENSE_CATEGORY_VIEW.hideUnchecked || checkedIds.has(category.id))
    return { ...group, selectable, displayed }
  }).filter((group) => group.displayed.length > 0)
  if (groupsToRender.length === 0) {
    container.innerHTML = `<div class="empty-note">Nothing matches the current filters.</div>`
    return
  }
  container.innerHTML = groupsToRender
    .map((group) => {
      const checkedCount = group.selectable.filter((category) => checkedIds.has(category.id)).length
      const folded = EXPENSE_CATEGORY_FOLDS.has(group.id)
      return `
      <div class="category-picker-group">
        <div class="category-picker-group-head">
          <button type="button" class="bt-fold-toggle" data-fold-group="${group.id}" aria-expanded="${!folded}">${folded ? "▶" : "▼"}</button>
          <label class="checkbox-label bt-group-check-label"><input type="checkbox" class="expense-category-group-check" data-group="${group.id}">${escapeHtml(group.name)}</label>
          <span class="category-picker-count">${checkedCount}/${group.selectable.length}</span>
        </div>
        <div class="category-picker-body" data-group-body="${group.id}" ${folded ? "hidden" : ""}>
          ${group.displayed
            .map(
              (category) =>
                `<label class="checkbox-label category-picker-item${category.hidden ? " hidden-category" : ""}"><input type="checkbox" class="expense-category-check" data-category-id="${category.id}" data-group="${group.id}" ${checkedIds.has(category.id) ? "checked" : ""}>${escapeHtml(category.name)}${category.hidden ? hiddenCategoryMark() : ""}</label>`,
            )
            .join("")}
        </div>
      </div>`
    })
    .join("")
  container.querySelectorAll("[data-fold-group]").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const groupId = toggle.dataset.foldGroup
      const collapsing = toggle.getAttribute("aria-expanded") === "true"
      if (collapsing) EXPENSE_CATEGORY_FOLDS.add(groupId)
      else EXPENSE_CATEGORY_FOLDS.delete(groupId)
      saveExpenseCategoryFolds()
      toggle.setAttribute("aria-expanded", String(!collapsing))
      toggle.textContent = collapsing ? "▶" : "▼"
      container.querySelector(`[data-group-body="${groupId}"]`).hidden = collapsing
    })
  })
  // Tracked as a Set derived from checkedIds, not read back from the DOM on every change --
  // Hide unchecked and Show hidden both mean the DOM only ever contains a subset of the real
  // selection (an unchecked-and-hidden category, or one checked while Show hidden was on and
  // since hidden from view again, simply isn't rendered), so reconstructing "what's checked" by
  // querying visible checkboxes would silently drop whatever the current filters happen to hide.
  const working = new Set(checkedIds)
  const commitSelection = () => {
    const ids = [...working]
    if (ids.length === 0) {
      showError("Select at least one expense category.")
      renderExpenseCategoryPicker()
      return
    }
    runExclusive(() => patchPlan({ crossoverExpenseCategoryIds: ids }, "savedExpenseCategories"))
  }
  container.querySelectorAll(".expense-category-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) working.add(checkbox.dataset.categoryId)
      else working.delete(checkbox.dataset.categoryId)
      commitSelection()
    })
  })
  container.querySelectorAll(".expense-category-group-check").forEach((groupCheckbox) => {
    const group = groupsToRender.find((g) => g.id === groupCheckbox.dataset.group)
    groupCheckbox.addEventListener("change", () => {
      group.selectable.forEach((category) => {
        if (groupCheckbox.checked) working.add(category.id)
        else working.delete(category.id)
      })
      commitSelection()
    })
    setTriState(
      groupCheckbox,
      group.selectable.map((category) => ({ checked: checkedIds.has(category.id) })),
    )
  })
}

// The eye-off glyph Actual's own budget table already uses for a hidden category (see hiddenMark
// in renderPickerTable) -- same shape, generic enough to reuse here without duplicating the SVG.
function hiddenCategoryMark() {
  return ` <span class="bt-hidden-mark" title="Hidden in Actual" aria-label="Hidden in Actual"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12C4.5 7 8 4.5 12 4.5S19.5 7 22 12c-2.5 5-6 7.5-10 7.5S4.5 17 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></span>`
}

async function loadExpenseCategoryOptions() {
  try {
    const { categoryGroups } = await api("/api/budget/context")
    EXPENSE_CATEGORY_GROUPS = categoryGroups.filter((group) => !group.hidden || group.categories.some((category) => category.hidden))
    renderExpenseCategoryPicker()
  } catch (error) {
    document.getElementById("expenseCategoryPicker").innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
  }
}

// The one Refresh button (top of page, beside Expand/Collapse all) pulls fresh data for the whole
// page at once, from a single /api/retirement/check call.
async function refreshAll() {
  const btn = document.getElementById("refreshBtn")
  btn.disabled = true
  try {
    await runCheck()
  } finally {
    btn.disabled = false
    // "Refresh reloads the same remembered file when in file mode" (issue #35) already falls out
    // of runCheck() re-hitting /api/retirement/check, which goes through currentAccountDataSource
    // -- this just picks up the resulting lastLoadedAt/availability for the topbar chip.
    refreshDataSourceChip()
  }
}

function parseRetirementAges(text) {
  const tokens = text.split(/[,\s]+/).filter((t) => t !== "")
  const ages = tokens.map(Number)
  if (tokens.length === 0 || !ages.every((age) => Number.isFinite(age) && age > 0)) {
    throw new Error("Enter one or more positive numbers, separated by spaces or commas.")
  }
  return ages
}

function renderAccounts() {
  const list = document.getElementById("accountsList")
  list.innerHTML = ""
  const typeKeys = Object.keys(STATE.accountTypes)

  // Pot drain order matters whenever there's more than one portfolio account to order -- not just
  // when the Monte Carlo widget's own strategy is "sequential" (its one-time earlier gate): this
  // app's own bridge/MAGI simulation reads the same withdrawalOrder field too (see
  // allocateWithdrawal in fire-analysis.ts), and a plan can care about draw order there without
  // ever exporting a widget, or while that widget uses a different strategy entirely. A single
  // portfolio account has nothing to order against, so the control stays hidden until there's
  // actually a choice to make.
  const reorderEnabled = STATE.accounts.filter((account) => account.isPortfolio).length > 1
  document.getElementById("reorderHint").hidden = !reorderEnabled

  STATE.accounts.forEach((account) => {
    const typeInfo = STATE.accountTypes[account.type]
    const row = document.createElement("div")
    row.className = `account-row${reorderEnabled ? " reorderable" : ""}`
    row.dataset.accountId = account.id
    row.draggable = reorderEnabled

    const typeOptions = typeKeys
      .map((key) => `<option value="${key}" ${key === account.type ? "selected" : ""}>${STATE.accountTypes[key].label}</option>`)
      .join("")
    const allocOptions = STATE.allocationPresets
      .map((preset) => `<option value="${preset.value}" ${preset.value === account.allocationPreset ? "selected" : ""}>${preset.value} — ${preset.label}</option>`)
      .join("")
    const allocationLabel = account.allocationPreset != null ? (STATE.allocationPresets.find((preset) => preset.value === account.allocationPreset)?.label ?? account.allocationPreset) : ""

    const accessNote = account.earlyWithdrawalPenalty && account.accessAge !== null
      ? `Accessible now — 10% penalty before age ${account.accessAge}`
      : account.accessAge === null
        ? account.type === "inherited-ira"
          ? "No age restriction (IRC §72(t)(2)(A)(iv))"
          : "Always accessible"
        : `Accessible at ${account.accessAge}`
    const ruleOf55Note = account.ruleOf55SeparationAge ? ` — Rule of 55 at <span class="money">${account.ruleOf55SeparationAge}</span>` : ""
    const seppNote = account.seppMethod != null && account.seppStartAge != null
      ? ` — SEPP (${account.seppMethod === "rmd" ? "RMD" : "amortization"}) from <span class="money">${account.seppStartAge}</span>`
      : ""

    const showContribution = typeInfo.contributionAllowed
    const contributionValue = formatMoneyInputValue(account.monthlyContribution)
    const maxCaption = account.monthlyContributionIsMax
      ? `<div class="derived">≈ ${moneySpan(account.monthlyContribution ?? 0)}/mo — remainder of the ${typeInfo.limitGroup} limit after other accounts</div>`
      : ""

    const isRuleOf55Active = account.ruleOf55SeparationAge != null
    // A 401(k)-family account with no active employer relationship has nothing to contribute
    // to right now -- disabled, not hidden, so the field stays in the same place either way.
    const contributionDisabled = typeInfo.ruleOf55Eligible && !isRuleOf55Active

    const employer = account.employerContribution
    const employerNote = employer
      ? `<div class="derived${employer.exceedsLimit ? " warn-text" : ""}">Employer ≈ ${moneySpan(employer.employerAnnualContribution)}/yr — combined with yours: ${moneySpan(employer.combinedAnnual)}/yr of a ${moneySpan(employer.combinedLimit)}/yr IRC §415(c) limit${employer.exceedsLimit ? " (exceeds it)" : ""}</div>`
      : ""

    const payoff = account.mortgagePayoff
    const payoffNote = payoff
      ? payoff.error
        ? `<div class="derived warn-text">${escapeHtml(payoff.error)}</div>`
        : `<div class="derived">Payoff in <span class="money">~${payoff.monthsRemaining} mo, around ${payoff.payoffDate}${account.mortgagePayoffAge != null ? ` (age ~${account.mortgagePayoffAge})` : ""}</span></div>`
      : ""

    const accountFolded = ACCOUNT_FOLDS.has(account.id)
    row.innerHTML = `
      <div class="acct-id">
        ${reorderEnabled ? `<div class="drag-handle" title="Drag to change withdrawal order">⠿</div>` : ""}
        <button type="button" class="bt-fold-toggle" data-fold-account="${account.id}" aria-expanded="${!accountFolded}">${accountFolded ? "▶" : "▼"}</button>
        <div class="acct-id-text">
          <div class="name">${escapeHtml(account.name)}</div>
          <div class="balance">${moneySpan(account.balance)}</div>
          <div class="cat-note">${accessNote}${ruleOf55Note}${seppNote}</div>
        </div>
      </div>
      <div class="acct-fields" ${accountFolded ? "hidden" : ""}>
        <div class="field full">
          <label>Account type</label>
          <select data-field="type">${typeOptions}</select>
        </div>
        <div class="field wide ${typeInfo.isPortfolio ? "" : "hidden"}">
          <label>Allocation</label>
          <select data-field="allocationPreset">${allocOptions}</select>
        </div>
        <div class="field ${typeInfo.isPortfolio ? "" : "hidden"}">
          <label>Expected return</label>
          <div class="input-affix suffix-percent">
            <input type="number" step="0.1" data-field="customReturnMean" value="${account.customReturnMean != null ? account.customReturnMean * 100 : (account.defaultReturnMean != null ? Math.round(account.defaultReturnMean * 1000) / 10 : "")}" placeholder="e.g. 6">
          </div>
          <div class="derived">Defaults to ${escapeHtml(allocationLabel)}</div>
        </div>
        <div class="field ${typeInfo.isPortfolio ? "" : "hidden"}">
          <label>Volatility</label>
          <div class="input-affix suffix-percent">
            <input type="number" min="0" step="0.1" data-field="customReturnStdDev" value="${account.customReturnStdDev != null ? account.customReturnStdDev * 100 : (account.defaultReturnStdDev != null ? Math.round(account.defaultReturnStdDev * 1000) / 10 : "")}" placeholder="e.g. 12">
          </div>
        </div>
        <div class="field ${typeInfo.isPortfolio ? "" : "hidden"}">
          <label>Withdrawal tax rate</label>
          <div class="input-affix suffix-percent">
            <input type="number" min="0" step="0.5" data-field="customWithdrawalTaxRate" value="${account.customWithdrawalTaxRate != null ? account.customWithdrawalTaxRate * 100 : ""}" placeholder="auto (${Math.round(account.defaultWithdrawalTaxRate * 100)}%)">
          </div>
        </div>
        <div class="field full ${typeInfo.isPortfolio && account.accessAge !== null ? "" : "hidden"}">
          <label class="checkbox-label"><input type="checkbox" data-field="earlyWithdrawalPenalty" ${account.earlyWithdrawalPenalty ? "checked" : ""}> Accept the 10% early withdrawal penalty for full access now, instead of waiting for age ${account.accessAge}<button type="button" class="help-icon" data-help="IRC §72(t): an early distribution from a qualified retirement plan owes an extra 10% on top of ordinary income tax. Enabling this makes the account fully accessible right away in the Bridge check, at that extra cost for any year before its normal access age.">?</button></label>
        </div>
        <div class="employer-block ${account.seppMethod ? "" : "inactive"} ${typeInfo.isPortfolio && account.accessAge !== null ? "" : "hidden"}">
          <div class="field full">
            <label>72(t) SEPP election<button type="button" class="help-icon" data-help="Substantially Equal Periodic Payments -- an IRS-approved way to take penalty-free early distributions before your normal access age, in exchange for a MANDATORY annual amount the app computes for you (it must continue for the longer of 5 years or until you reach 59½, or the penalty applies retroactively to everything already taken).&#10;&#10;RMD method: this year's balance ÷ this year's own IRS life-expectancy factor -- recalculated every year, so it moves with the market.&#10;&#10;Fixed amortization: a level payment, calculated once at the start from your balance, life expectancy, and a chosen interest rate -- like a mortgage payment, it never changes afterward.">?</button></label>
            <select data-field="seppMethod">
              <option value="" ${account.seppMethod == null ? "selected" : ""}>Not electing</option>
              <option value="rmd" ${account.seppMethod === "rmd" ? "selected" : ""}>RMD method</option>
              <option value="amortization" ${account.seppMethod === "amortization" ? "selected" : ""}>Fixed amortization</option>
            </select>
          </div>
          <div class="field">
            <label>Start age</label>
            <input type="number" min="1" data-field="seppStartAge" value="${account.seppStartAge ?? ""}" ${account.seppMethod ? "" : "disabled"}>
          </div>
          <div class="field ${account.seppMethod === "amortization" ? "" : "hidden"}">
            <label>Interest rate</label>
            <div class="input-affix suffix-percent">
              <input type="number" min="0" step="0.1" data-field="seppInterestRate" value="${account.seppInterestRate != null ? account.seppInterestRate * 100 : ""}" ${account.seppMethod === "amortization" ? "" : "disabled"}>
            </div>
          </div>
          ${account.seppAnnualAmount != null ? `<div class="derived">≈ ${moneySpan(account.seppAnnualAmount)}/yr mandatory once started</div>` : ""}
        </div>
        <div class="field ${showContribution ? "" : "hidden"}">
          <label>Monthly contribution</label>
          <div class="contrib-row">
            <div class="input-affix prefix-dollar">
              <input type="text" inputmode="decimal" data-field="monthlyContribution" value="${contributionValue}" placeholder="0" ${account.monthlyContributionIsMax || contributionDisabled ? "disabled" : ""}>
            </div>
            ${typeInfo.limitGroup ? `<button type="button" class="toggle ${account.monthlyContributionIsMax ? "on" : ""}" data-toggle-max ${contributionDisabled ? "disabled" : ""}><span class="dot"></span>Max</button>` : ""}
          </div>
          ${maxCaption}
        </div>
        ${typeInfo.ruleOf55Eligible ? `
        <div class="employer-block ${isRuleOf55Active ? "" : "inactive"}">
          <div class="field full">
            <label class="checkbox-label"><input type="checkbox" data-field="ruleOf55Active" ${isRuleOf55Active ? "checked" : ""}> Account is active</label>
          </div>
          <div class="field">
            <label>Age you'll separate from this employer</label>
            <input type="number" min="1" data-field="ruleOf55SeparationAge" value="${account.ruleOf55SeparationAge ?? 55}" ${isRuleOf55Active ? "" : "disabled"}>
          </div>
          <div class="field">
            <label>Annual salary</label>
            <div class="input-affix prefix-dollar">
              <input type="text" inputmode="decimal" data-field="annualSalary" value="${formatMoneyInputValue(account.annualSalary)}" placeholder="not entered" ${isRuleOf55Active ? "" : "disabled"}>
            </div>
          </div>
          <div class="field">
            <label>Employer match</label>
            <div class="input-affix suffix-percent">
              <input type="number" min="0" step="1" data-field="employerMatchRate" value="${account.employerMatchRate != null ? (account.employerMatchRate * 100) : ""}" placeholder="e.g. 100" ${isRuleOf55Active ? "" : "disabled"}>
            </div>
          </div>
          <div class="field">
            <label>...up to this % of pay</label>
            <div class="input-affix suffix-percent">
              <input type="number" min="0" step="0.5" data-field="employerMatchCapRate" value="${account.employerMatchCapRate != null ? (account.employerMatchCapRate * 100) : ""}" placeholder="e.g. 4" ${isRuleOf55Active ? "" : "disabled"}>
            </div>
          </div>
          ${isRuleOf55Active ? employerNote : ""}
        </div>` : ""}
        ${account.type === "hsa" ? `
        <div class="field wide">
          <label>Coverage</label>
          <div class="radio-row">
            <label><input type="radio" name="hsaCoverage-${account.id}" data-field="hsaCoverage" value="self" ${account.hsaCoverage !== "family" ? "checked" : ""}> Self-only</label>
            <label><input type="radio" name="hsaCoverage-${account.id}" data-field="hsaCoverage" value="family" ${account.hsaCoverage === "family" ? "checked" : ""}> Family</label>
          </div>
        </div>` : ""}
        ${account.type === "roth-ira" ? `
        <div class="field wide">
          <label>Contributed basis (withdrawable anytime)</label>
          <div class="input-affix prefix-dollar">
            <input type="text" inputmode="decimal" data-field="rothBasis" value="${formatMoneyInputValue(account.rothBasis)}" placeholder="not entered">
          </div>
          <div class="derived">Optional. Roth IRA contributions (not earnings) can be withdrawn tax- and penalty-free at any age (IRC §408A(d)(4)) — affects the Analyze tab's Bridge check only, not the generated Monte Carlo widget.</div>
        </div>` : ""}
        ${account.type === "debt" ? `
        <div class="field">
          <label>Interest rate</label>
          <div class="input-affix suffix-percent">
            <input type="number" min="0" step="0.01" data-field="mortgageInterestRate" value="${account.mortgageInterestRate != null ? (account.mortgageInterestRate * 100) : ""}" placeholder="e.g. 6.5">
          </div>
        </div>
        <div class="field">
          <label>Monthly payment</label>
          <div class="input-affix prefix-dollar">
            <input type="text" inputmode="decimal" data-field="mortgageMonthlyPayment" value="${formatMoneyInputValue(account.mortgageMonthlyPayment)}" placeholder="not entered">
          </div>
        </div>
        <div class="field">
          <label>Balance as of</label>
          <input type="date" data-field="mortgageBalanceAsOfDate" value="${account.mortgageBalanceAsOfDate ?? ""}">
        </div>
        <div class="field">
          <label>Balance on that date</label>
          <div class="input-affix prefix-dollar">
            <input type="text" inputmode="decimal" data-field="mortgageBalanceAsOf" value="${formatMoneyInputValue(account.mortgageBalanceAsOf)}" placeholder="not entered">
          </div>
        </div>
        <div class="field">
          <label>Extra principal<button type="button" class="help-icon" data-help="Extra paid toward principal each month, on top of the regular payment above -- shortens the payoff estimate below.&#10;&#10;Only the regular payment is assumed to free up spend once this is paid off, not this extra amount -- it's usually a discretionary overpayment funded outside your regular budgeted spend, even when the regular payment itself is tracked normally.">?</button></label>
          <div class="input-affix prefix-dollar">
            <input type="text" inputmode="decimal" data-field="mortgageExtraPrincipal" value="${formatMoneyInputValue(account.mortgageExtraPrincipal)}" placeholder="not entered">
          </div>
        </div>
        ${payoffNote}` : ""}
        ${!typeInfo.isPortfolio ? `<div class="no-fields-note">Not part of the investable portfolio — no allocation or contribution to set.</div>` : ""}
        ${!typeInfo.isPortfolio ? "" : account.limitLines.length ? `<div class="limit-lines">${account.limitLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : (showContribution ? `<div class="limit-lines"><span class="empty">No IRS contribution limit applies to this account type.</span></div>` : "")}
      </div>
    `

    row.querySelector("[data-fold-account]").addEventListener("click", (e) => {
      const collapsing = e.target.getAttribute("aria-expanded") === "true"
      if (collapsing) ACCOUNT_FOLDS.add(account.id)
      else ACCOUNT_FOLDS.delete(account.id)
      saveAccountFolds()
      e.target.setAttribute("aria-expanded", String(!collapsing))
      e.target.textContent = collapsing ? "▶" : "▼"
      row.querySelector(".acct-fields").hidden = collapsing
    })
    row.querySelector("select[data-field='type']").addEventListener("change", (e) => runExclusive(() => patchAccount(account.id, { type: e.target.value })))
    const allocSelect = row.querySelector("select[data-field='allocationPreset']")
    if (allocSelect) {
      allocSelect.addEventListener("change", (e) => runExclusive(() => patchAccount(account.id, { allocationPreset: e.target.value })))
    }
    const customReturnInput = row.querySelector("input[data-field='customReturnMean']")
    if (customReturnInput) {
      customReturnInput.addEventListener("change", (e) => {
        const pct = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { customReturnMean: pct === null ? null : pct / 100 }))
      })
    }
    const customVolatilityInput = row.querySelector("input[data-field='customReturnStdDev']")
    if (customVolatilityInput) {
      customVolatilityInput.addEventListener("change", (e) => {
        const pct = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { customReturnStdDev: pct === null ? null : pct / 100 }))
      })
    }
    const customTaxRateInput = row.querySelector("input[data-field='customWithdrawalTaxRate']")
    if (customTaxRateInput) {
      customTaxRateInput.addEventListener("change", (e) => {
        const pct = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { customWithdrawalTaxRate: pct === null ? null : pct / 100 }))
      })
    }
    const contribInput = row.querySelector("input[data-field='monthlyContribution']")
    if (contribInput) {
      attachMoneyFormatting(contribInput)
      contribInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { monthlyContribution: parseMoneyInputCents(e.target.value) }))
      })
    }
    const earlyPenaltyCheckbox = row.querySelector("[data-field='earlyWithdrawalPenalty']")
    if (earlyPenaltyCheckbox) {
      earlyPenaltyCheckbox.addEventListener("change", (e) => {
        runExclusive(() => patchAccount(account.id, { earlyWithdrawalPenalty: e.target.checked }))
      })
    }
    const seppMethodSelect = row.querySelector("[data-field='seppMethod']")
    if (seppMethodSelect) {
      seppMethodSelect.addEventListener("change", (e) => {
        const method = e.target.value === "" ? null : e.target.value
        runExclusive(() => patchAccount(account.id, { seppMethod: method, seppStartAge: method === null ? null : (account.seppStartAge ?? 55) }))
      })
    }
    const seppStartAgeInput = row.querySelector("input[data-field='seppStartAge']")
    if (seppStartAgeInput) {
      seppStartAgeInput.addEventListener("change", (e) => {
        const age = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { seppStartAge: age === null || age <= 0 ? null : age }))
      })
    }
    const seppInterestRateInput = row.querySelector("input[data-field='seppInterestRate']")
    if (seppInterestRateInput) {
      seppInterestRateInput.addEventListener("change", (e) => {
        const pct = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { seppInterestRate: pct === null ? null : pct / 100 }))
      })
    }
    const ruleActiveCheckbox = row.querySelector("[data-field='ruleOf55Active']")
    if (ruleActiveCheckbox) {
      ruleActiveCheckbox.addEventListener("change", (e) => {
        runExclusive(() => patchAccount(account.id, { ruleOf55SeparationAge: e.target.checked ? 55 : null }))
      })
    }
    const ruleInput = row.querySelector("input[data-field='ruleOf55SeparationAge']")
    if (ruleInput) {
      ruleInput.addEventListener("change", (e) => {
        const age = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { ruleOf55SeparationAge: age === null || age <= 0 ? null : age }))
      })
    }
    const salaryInput = row.querySelector("input[data-field='annualSalary']")
    if (salaryInput) {
      attachMoneyFormatting(salaryInput)
      salaryInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { annualSalary: parseMoneyInputCents(e.target.value) }))
      })
    }
    const matchRateInput = row.querySelector("input[data-field='employerMatchRate']")
    if (matchRateInput) {
      matchRateInput.addEventListener("change", (e) => {
        const percent = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { employerMatchRate: percent === null ? null : percent / 100 }))
      })
    }
    const matchCapInput = row.querySelector("input[data-field='employerMatchCapRate']")
    if (matchCapInput) {
      matchCapInput.addEventListener("change", (e) => {
        const percent = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { employerMatchCapRate: percent === null ? null : percent / 100 }))
      })
    }
    row.querySelectorAll("input[data-field='hsaCoverage']").forEach((input) => {
      input.addEventListener("change", (e) => {
        if (e.target.checked) runExclusive(() => patchAccount(account.id, { hsaCoverage: e.target.value }))
      })
    })
    const rothBasisInput = row.querySelector("input[data-field='rothBasis']")
    if (rothBasisInput) {
      attachMoneyFormatting(rothBasisInput)
      rothBasisInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { rothBasis: parseMoneyInputCents(e.target.value) }))
      })
    }
    const mortgageRateInput = row.querySelector("input[data-field='mortgageInterestRate']")
    if (mortgageRateInput) {
      mortgageRateInput.addEventListener("change", (e) => {
        const percent = e.target.value === "" ? null : parseFloat(e.target.value)
        runExclusive(() => patchAccount(account.id, { mortgageInterestRate: percent === null ? null : percent / 100 }))
      })
    }
    const mortgagePaymentInput = row.querySelector("input[data-field='mortgageMonthlyPayment']")
    if (mortgagePaymentInput) {
      attachMoneyFormatting(mortgagePaymentInput)
      mortgagePaymentInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { mortgageMonthlyPayment: parseMoneyInputCents(e.target.value) }))
      })
    }
    const mortgageExtraPrincipalInput = row.querySelector("input[data-field='mortgageExtraPrincipal']")
    if (mortgageExtraPrincipalInput) {
      attachMoneyFormatting(mortgageExtraPrincipalInput)
      mortgageExtraPrincipalInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { mortgageExtraPrincipal: parseMoneyInputCents(e.target.value) }))
      })
    }
    const mortgageDateInput = row.querySelector("input[data-field='mortgageBalanceAsOfDate']")
    if (mortgageDateInput) {
      mortgageDateInput.addEventListener("change", (e) => {
        runExclusive(() => patchAccount(account.id, { mortgageBalanceAsOfDate: e.target.value || null }))
      })
    }
    const mortgageBalanceInput = row.querySelector("input[data-field='mortgageBalanceAsOf']")
    if (mortgageBalanceInput) {
      attachMoneyFormatting(mortgageBalanceInput)
      mortgageBalanceInput.addEventListener("moneycommit", (e) => {
        runExclusive(() => patchAccount(account.id, { mortgageBalanceAsOf: parseMoneyInputCents(e.target.value) }))
      })
    }
    const maxToggle = row.querySelector("[data-toggle-max]")
    if (maxToggle) {
      maxToggle.addEventListener("click", () => {
        runExclusive(async () => {
          if (account.monthlyContributionIsMax) {
            await patchAccount(account.id, { monthlyContribution: null })
            return
          }
          // At most one "max" per limit group -- clear any sibling in the same group first.
          const group = typeInfo.limitGroup
          const siblings = STATE.accounts.filter((a) => a.id !== account.id && a.monthlyContributionIsMax && STATE.accountTypes[a.type].limitGroup === group)
          await Promise.all(siblings.map((sibling) => patchAccount(sibling.id, { monthlyContribution: null })))
          await patchAccount(account.id, { monthlyContribution: "max" })
        })
      })
    }

    if (reorderEnabled) {
      row.addEventListener("dragstart", () => {
        draggingAccountRow = row
        row.classList.add("dragging")
      })
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging")
        draggingAccountRow = null
        const orderedIds = [...list.querySelectorAll(".account-row")].map((r) => r.dataset.accountId)
        runExclusive(() => reorderAccounts(orderedIds))
      })
    }

    list.appendChild(row)
  })
}

// Function to find which row a dragged row should land BEFORE, based on vertical mouse position --
// the standard vanilla-JS drag-reorder technique (compare against each row's own vertical midpoint
// rather than tracking index math directly). Returns null to mean "at the end."
function dragAfterElement(list, y) {
  const rows = [...list.querySelectorAll(".account-row:not(.dragging)")]
  return rows.reduce(
    (closest, row) => {
      const box = row.getBoundingClientRect()
      const offset = y - box.top - box.height / 2
      return offset < 0 && offset > closest.offset ? { offset, element: row } : closest
    },
    { offset: Number.NEGATIVE_INFINITY, element: null },
  ).element
}

function escapeHtml(text) {
  const div = document.createElement("div")
  div.textContent = text
  return div.innerHTML
}

// Server-built sentences (findings, boost/payoff lines) embed dollar amounts and ages as plain
// text -- this wraps both in .money spans after escaping (moneyHtml keeps a dollar figure's own $
// visible), so the eye toggle can blur them without needing the server to mark them up itself.
// Percentages/durations/simulation counts are left readable, and so is a retirement age being
// *compared* (a planning input, not a real fact) or plan-to-age -- see CLAUDE.md's own privacy
// rule for what counts as sensitive and why. Only "at age N"/"around age N"/"access age N" match
// (real facts: an unlock/payoff/depletion age, a live-vs-configured access-age drift finding,
// never the sentence's own leading "age N --" retirement-age lead-in or an "until/through/short of
// age N" planToAge mention) -- every sensitive-age sentence in fire-analysis.ts is written with
// one of those three exact lead-ins for this reason; a new one needs to follow the same convention
// to get blurred here. Only the number itself is wrapped, not the word "age" -- that's just
// English, not the sensitive part.
function moneyify(text) {
  return escapeHtml(text)
    .replace(/-?\$[\d,]+\.\d{2}/g, (match) => moneyHtml(match))
    .replace(/\b(at|around|access) age (\d+(?:\/\d+)*)/g, (_match, lead, nums) => `${lead} age <span class="money">${nums}</span>`)
    // MAGI's own %FPL figure (see magiFinding in fire-analysis.ts) reads as "just a percentage,"
    // but it's MAGI divided by a PUBLISHED, public FPL table value -- unmasked, it'd let anyone who
    // looks up that table solve backward for the real (otherwise-blurred) MAGI dollar figure. Masked
    // the same way an age is: just the number, "% FPL" stays put so it's still legible as a %FPL
    // figure, just not which one.
    .replace(/\((\d+(?:\.\d+)?)% FPL\)/g, (_match, pct) => `(<span class="money">${pct}</span>% FPL)`)
    // Same reasoning, same fix, for the marginal ("N% federal bracket") and effective ("N%
    // effective") rate in that same finding -- both are federalTax/taxableIncome ratios, and
    // federalTaxOwed is a deterministic function of a PUBLIC bracket table -- given the visible
    // filing status, knowing both rates together is enough to solve backward for the exact
    // (otherwise-blurred) MAGI, not just narrow it down.
    .replace(/(\d+(?:\.\d+)?)% federal bracket/g, (_match, pct) => `<span class="money">${pct}</span>% federal bracket`)
    .replace(/(\d+(?:\.\d+)?)% effective/g, (_match, pct) => `<span class="money">${pct}</span>% effective`)
}

// --- Bridge burndown chart (Analyze tab) ---

// Fixed slot order, validated (dataviz skill's scripts/validate_palette.js) against this app's own
// --surface as the chart background: all 8 pass lightness, chroma, adjacent CVD separation (worst
// 8.4), adjacent normal-vision separation (worst 19.3), and contrast vs --surface. Assigned to
// scenarios by POSITION in the selected retirement-age list, never by value, so a given age keeps
// its color for as long as it stays selected and a filtered-down comparison never repaints the
// scenarios that remain.
const BRIDGE_SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]

// Mirrors DEFAULT_MONTE_CARLO_ASSUMPTIONS in fire-dashboard.ts -- only used for the loading
// skeleton's own group-label text (see renderLoadingSkeleton), since the real ones only ever
// travel from server to client already resolved (inside a check response), never the other way.
const DEFAULT_MONTE_CARLO_INFLATION_MEAN = 0.03
const DEFAULT_MONTE_CARLO_SIMULATION_COUNT = 5000

// Mirrors HISTORY_LOOKBACK_YEARS_MAX in fire-generate.ts -- the real check response is what
// decides how far back a chart's history actually reaches (some accounts don't have this much
// transaction history), but the loading skeleton has no real data yet to know that, so it reserves
// space for the largest a chart could turn out to be (see [[no-layout-shift-ux-rule]]) rather than
// starting at currentAge and jumping wider the moment real history arrives.
const SKELETON_HISTORY_LOOKBACK_YEARS_MAX = 5

// Function to format cents as a compact dollar figure for the chart's own axis -- $0, $50K, $1.2M
// -- never the full $50,000.00 usd() prints elsewhere, which would crowd a narrow axis gutter.
function usdCompact(cents) {
  const dollars = cents / 100
  const abs = Math.abs(dollars)
  const sign = dollars < 0 ? "-" : ""
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(/\.0$/, "")}M`
  if (abs >= 1000) return `${sign}$${Math.round(abs / 1000)}K`
  return `${sign}$${Math.round(abs)}`
}

// Function to lay out gridline ticks at a clean (1/2/2.5/5 x 10^k) step -- from $0 up to the
// smallest multiple of that step that clears `maxCents` -- so EVERY tick is a round number.
// Dividing a rounded ceiling into N equal parts (the more obvious approach) doesn't guarantee
// that: a $5M ceiling split into 4 lands on $1.25M/$3.75M, neither of them clean.
//
// The last tick pushed is guaranteed >= maxCents -- a do-while, not a for loop with a `<=`
// bound, deliberately: a plain `for (value <= maxCents; value += step)` stops as soon as value
// exceeds maxCents WITHOUT pushing that value, so whenever maxCents doesn't land exactly on a
// step multiple the top tick ends up a step short of the real max (e.g. step=$1M, a real max of
// $3.6M topped out at a $3M tick) -- every series scaled off that tick then draws part of its own
// line above the visible plot, clipped by the raw SVG canvas rather than the intended axis. Caught
// by rendering real data and looking at it, not from the math alone.
function niceAxisTicks(maxCents, targetCount) {
  if (maxCents <= 0) return [0, 100]
  const roughStep = maxCents / targetCount
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= roughStep) ?? 10 * magnitude
  const ticks = []
  let value = 0
  do {
    ticks.push(Math.round(value))
    value += step
  } while (ticks[ticks.length - 1] < maxCents)
  return ticks
}

// Function to draw the bridge burndown: one line per selected retirement age, tracing the
// accessible balance from retirement toward zero (or the end of the plan), with the still-locked
// balance as a dashed companion in the same color -- the same two figures the prose finding below
// it already states, drawn as a shape rather than left to be read as numbers. Returns null when
// there is nothing worth plotting (no portfolio balance at all in any scenario).
//
// How far past retirement a scenario that never depletes is actually DRAWN: the point of this
// chart is the bridge gap in the years right after retirement, not a decades-long net-worth
// projection (Actual's own Monte Carlo widget already does that job). A portfolio whose growth
// rate outpaces its spending can compound to genuinely enormous nominal figures over a 40+ year
// horizon -- true, and worth showing on ITS OWN, but on a shared axis with a scenario that depletes
// in year six, it swamps the scale and squashes the only years that scenario actually tells a story
// in down to an unreadable sliver. So a funded scenario is capped here; a depleting one never is --
// its own line already stops naturally at the age it runs out, which is the entire point.
const BRIDGE_WINDOW_YEARS = 20

function renderBridgeChart(bridgeResults, currentAge, planToAge, ruleOf55Boosts = [], debtPayoffs = [], incomeStreams = [], acaCliffCrossings = [], expenseAdjustments = []) {
  const usable = bridgeResults.filter((r) => r.timeline.length > 0 && r.accessibleAtRetirement + r.lockedAtRetirement > 0)
  if (usable.length === 0) return null
  // Read once, not per-figure -- see svgMoneyText/svgAgeText's own doc comment for why this
  // chart's own dollar/age text swaps content instead of relying on a blur filter.
  const isPrivate = document.body.classList.contains("privacy")

  // What actually gets drawn for each scenario, and where its line stops. `trimmed` scenarios keep
  // no end mark at all below -- a line simply running off the right edge of a windowed chart is the
  // ordinary, unremarkable way to read "still fine beyond here" (the legend, tooltip, and the prose
  // finding below all still carry the real number); a marker drawn away from the age it actually
  // describes would be a label lying about its own position.
  // Joins history/accumulation/drawn into one continuous line with no seam: history's last point
  // and accumulation's first are both just "today," and accumulation's last and drawn's first are
  // both exactly accessibleAtRetirement/lockedAtRetirement (see the doc comments on BridgeResult's
  // own history/accumulation fields) -- only actually dropped when the ages agree, so this stays
  // correct however many of the three segments turn out to be empty.
  const mergeBridgeSegments = (...segments) =>
    segments.reduce((merged, segment) => {
      if (segment.length === 0) return merged
      const dupe = merged.length > 0 && merged[merged.length - 1].age === segment[0].age
      return [...merged, ...segment.slice(dupe ? 1 : 0)]
    }, [])

  const scenarios = usable.map((result) => {
    const naturalEndAge = result.timeline[result.timeline.length - 1].age
    const displayEndAge = result.depletionAge != null ? naturalEndAge : Math.min(naturalEndAge, result.retirementAge + BRIDGE_WINDOW_YEARS)
    const drawn = result.timeline.filter((point) => point.age <= displayEndAge)
    const full = mergeBridgeSegments(result.history, result.accumulation, drawn)
    return { result, drawn, full, trimmed: displayEndAge < naturalEndAge }
  })

  const width = 640
  const height = 240
  const margin = { top: 12, right: 16, bottom: 24, left: 54 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom

  // Same domain as the Monte Carlo chart (currentAge through planToAge), so the two are directly
  // comparable at a glance -- widened past whatever a scenario's own line actually covers when a
  // depletion or unlock age runs later than planToAge itself, and pulled earlier still by real
  // account history (result.history), when there's any -- see checkDashboard's own history/
  // historicalAges for how far back that can go.
  const minAge = Math.min(currentAge, ...scenarios.map((s) => s.full[0].age))
  const maxAge = Math.max(planToAge, ...scenarios.flatMap((s) => [s.drawn[s.drawn.length - 1].age, s.result.nextUnlockAfterDepletion ?? -Infinity]))
  const maxBalance = Math.max(1, ...scenarios.flatMap((s) => s.full.flatMap((point) => [point.accessibleBalance, point.lockedBalance])))
  const yTicks = niceAxisTicks(maxBalance, 4)
  const yMax = yTicks[yTicks.length - 1]

  const scaleX = (age) => margin.left + (maxAge === minAge ? 0 : ((age - minAge) / (maxAge - minAge)) * plotWidth)
  const scaleY = (cents) => margin.top + plotHeight - (cents / yMax) * plotHeight
  const linePath = (points, key) => points.map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(point.age).toFixed(1)},${scaleY(point[key]).toFixed(1)}`).join(" ")
  // Pixel length of the same polyline linePath would draw, for dashOffsetEndingMidDash below --
  // stroke-dasharray's on/off phase is purely a function of arc length, with no notion of "make
  // sure a mark actually lands on the endpoint."
  const pathPixelLength = (points, key) => {
    let total = 0
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(scaleX(points[i].age) - scaleX(points[i - 1].age), scaleY(points[i][key]) - scaleY(points[i - 1][key]))
    }
    return total
  }
  // The stroke-dashoffset that puts the MIDDLE of an "on" dash exactly at the end of a path of the
  // given length, for a "dashLength off gapLength" pattern. Without this, a dashed line's visible
  // end depends purely on how its total length happens to divide by the pattern's period -- for
  // the locked/accessible join below, where the dashed line is meant to visibly reach the exact
  // point the solid line takes over, that's the difference between it looking connected or not.
  const dashOffsetEndingMidDash = (length, dashLength, gapLength) => {
    const period = dashLength + gapLength
    return (((dashLength / 2 - length) % period) + period) % period
  }

  const gridlines = yTicks
    .map(
      (tickCents) =>
        `<line x1="${margin.left}" y1="${scaleY(tickCents).toFixed(1)}" x2="${width - margin.right}" y2="${scaleY(tickCents).toFixed(1)}" class="bridge-grid" />` +
        `<text x="${margin.left - 8}" y="${scaleY(tickCents).toFixed(1)}" class="bridge-axis-label" text-anchor="end" dominant-baseline="middle">${moneyMaskText(usdCompact(tickCents), isPrivate)}</text>`,
    )
    .join("")

  // 5-year steps read cleanly for the common decade-plus span; a short one (a handful of years to
  // an early depletion) switches to 1s rather than showing one bare tick at either end.
  const span = maxAge - minAge
  const ageStep = span > 40 ? 10 : span > 12 ? 5 : 1
  const ageTicks = []
  for (let age = Math.ceil(minAge / ageStep) * ageStep; age <= maxAge; age += ageStep) ageTicks.push(age)
  if (ageTicks[0] !== minAge) ageTicks.unshift(minAge)
  if (ageTicks[ageTicks.length - 1] !== maxAge) ageTicks.push(maxAge)
  const ageAxis = ageTicks
    .map((age) => `<text x="${scaleX(age).toFixed(1)}" y="${height - margin.bottom + 16}" class="bridge-axis-label" text-anchor="middle">${age}</text>`)
    .join("")

  // One shared, neutral reference line per distinct "would unlock at" age among the scenarios that
  // actually depleted before it -- neutral because it belongs to no one series (dedup: two
  // scenarios retiring at different ages can still name the same locked account's own access age).
  const unlockAges = [...new Set(scenarios.map((s) => s.result.nextUnlockAfterDepletion).filter((age) => age != null))]
  const unlockLines = unlockAges
    .map((age) => `<line x1="${scaleX(age).toFixed(1)}" y1="${margin.top}" x2="${scaleX(age).toFixed(1)}" y2="${height - margin.bottom}" class="bridge-unlock-line" />`)
    .join("")

  // Four kinds of "something changes at this age" reference line -- a 401(k)'s Rule-of-55
  // separation making it accessible early, a mortgage/loan's projected payoff, a pension or Social
  // Security stream starting, a scenario's MAGI crossing the ACA subsidy cliff -- neutral like the
  // unlock lines above (belongs to no one scenario's balance line, drawn regardless of whether any
  // scenario depletes). Combined into one x-sorted stack so a crowded age never collides: each
  // keeps its own class for color, but a shared row index decides its label's height -- leftmost
  // (soonest) highest, stepping one row lower per marker as age increases to the right, however
  // many of the four kinds actually land in that stretch.
  const ruleOf55Ages = [...new Set(ruleOf55Boosts.map((b) => b.to))].filter((age) => age > minAge && age <= maxAge)
  const debtPayoffAges = [...new Set(debtPayoffs.map((d) => d.payoffAge))].filter((age) => age > minAge && age <= maxAge)
  const incomeAges = [...new Set(incomeStreams.map((s) => s.startAge))].filter((age) => age > minAge && age <= maxAge)
  const acaCliffAges = [...new Set(acaCliffCrossings.map((c) => c.crossesAtAge))].filter((age) => age > minAge && age <= maxAge)
  // Each adjustment contributes up to two dated events -- the start (its own signed amount) and,
  // only when it has an end age, the reversal one year later (endAge is the LAST year it applies,
  // so the reversal lands at endAge + 1, matching how startAge itself is the first year it applies).
  const expenseEvents = expenseAdjustments.flatMap((adjustment) => {
    const events = [{ age: adjustment.startAge, name: adjustment.name, amount: adjustment.annualAmount }]
    if (adjustment.endAge != null) {
      events.push({ age: adjustment.endAge + 1, name: `${adjustment.name} ends`, amount: -adjustment.annualAmount })
    }
    return events
  })
  const expenseAges = [...new Set(expenseEvents.map((e) => e.age))].filter((age) => age > minAge && age <= maxAge)
  const markers = [
    ...ruleOf55Ages.map((age) => ({
      age,
      className: "ruleof55",
      name: "Rule of 55",
      amount: `+${usdCompact(ruleOf55Boosts.filter((b) => b.to === age).reduce((total, b) => total + b.amount, 0))}`,
    })),
    ...debtPayoffAges.map((age) => ({
      age,
      className: "mortgage",
      name: "Debt Paid Off",
      amount: `-${usdCompact(debtPayoffs.filter((d) => d.payoffAge === age).reduce((total, d) => total + d.monthlyAmount, 0) * 12)}/yr`,
    })),
    ...incomeAges.map((age) => {
      const streamsAtAge = incomeStreams.filter((s) => s.startAge === age)
      return {
        age,
        className: "income",
        name: streamsAtAge.map((s) => s.name).join(" + "),
        amount: `+${usdCompact(streamsAtAge.reduce((total, s) => total + s.annualAmount, 0))}/yr`,
      }
    }),
    // Only ever drawn for a scenario that actually crosses -- see acaCliffCrossings in
    // fire-generate.ts. %FPL reads as "just a percentage," but it's MAGI divided by a PUBLISHED,
    // public FPL table value -- unmasked, it'd let anyone who looks up that table solve backward
    // for the real (otherwise-blurred) MAGI dollar figure. Masked the same way an age is on this
    // chart (content-swapped to "~~", not CSS blur -- see moneyMaskText/ageMaskText's own doc
    // comments on why filter:blur doesn't reliably paint on SVG <tspan>s), baked in here at
    // construction time rather than left to the shownAmount step below (which only knows how to
    // mask a DOLLAR figure), so "% FPL" stays legible either way, same as every other masked figure
    // on this page keeping its own unit/label visible.
    ...acaCliffAges.map((age) => {
      const crossingsAtAge = acaCliffCrossings.filter((c) => c.crossesAtAge === age)
      const name = scenarios.length > 1 ? `ACA Subsidy Cliff (retire ${crossingsAtAge.map((c) => c.retirementAge).join(", ")})` : "ACA Subsidy Cliff"
      // More than one scenario can cross at the same age with different %FPL values (different
      // withdrawal needs) -- the highest is the one furthest past the cliff, so that's what's shown.
      const pctFPL = Math.max(...crossingsAtAge.map((c) => c.pctFPL))
      return { age, className: "acacliff", name, amount: `${ageMaskText(pctFPL, isPrivate)}% FPL` }
    }),
    ...expenseAges.map((age) => {
      const eventsAtAge = expenseEvents.filter((e) => e.age === age)
      const name = eventsAtAge.map((e) => e.name).join(" + ")
      const total = eventsAtAge.reduce((sum, e) => sum + e.amount, 0)
      return { age, className: "expense", name, amount: `${total >= 0 ? "+" : "-"}${usdCompact(Math.abs(total))}/yr` }
    }),
  ].sort((a, b) => a.age - b.age)
  const markerRowStep = 13
  // One line per DISTINCT age, not one per marker -- two marker types landing on the exact same
  // age (e.g. a pension starting the same year a mortgage happens to be paid off) would otherwise
  // draw two fully-overlapping <line> elements at the identical x, and the later one would just
  // paint over the earlier one entirely, silently hiding it. Each marker keeps its OWN row (still
  // stacked, one label per line, not comma-joined onto one row -- easier to read at a glance,
  // especially past two facts) -- only the vertical guide line itself is shared.
  const markersByAge = new Map()
  markers.forEach((m) => {
    if (!markersByAge.has(m.age)) markersByAge.set(m.age, [])
    markersByAge.get(m.age).push(m)
  })
  let nextRow = 0
  const positionedMarkers = [...markersByAge.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([age, entries]) => {
      const x = scaleX(age)
      const withLabel = entries.map((entry) => {
        // The amount actually rendered -- masked text in privacy mode, so the width used for
        // anchor/halo math below matches what's really on screen either way. Skipped for the ACA
        // cliff marker: its "amount" was already masked (or not) when it was built above, using
        // ageMaskText's "~~" convention rather than this moneyMaskText -- which assumes a leading
        // "$" to preserve, and would otherwise mangle a %-only string into a bare "~~~~~".
        const shownAmount = entry.className === "acacliff" ? entry.amount : moneyMaskText(entry.amount, isPrivate)
        const label = `${entry.name}: ${shownAmount}`
        // No canvas measurement available for an inline SVG string -- ~5.3px/char is a fair
        // estimate for this label's font-size (8.5px), good enough for the edge checks below.
        return { ...entry, shownAmount, label, labelWidth: label.length * 5.3 }
      })
      // One shared anchor for every row sharing this age -- left-aligned by default (each row's
      // text starting at the same x, reading as one aligned block down the line) rather than each
      // row independently centering on x by its own width, which left shorter/longer labels at
      // visibly different starting edges even though they belong to the same stack. Only flips to
      // right-aligned (still one shared choice for the whole stack) when the WIDEST row would
      // otherwise run off the plot's own right edge.
      const maxLabelWidth = Math.max(...withLabel.map((w) => w.labelWidth))
      const anchor = x + 4 + maxLabelWidth > width - margin.right ? "end" : "start"
      const dx = anchor === "end" ? -4 : 4
      return withLabel.map((w) => {
        const labelY = margin.top + 8 + nextRow * markerRowStep
        nextRow++
        const haloLeft = anchor === "start" ? x + dx : x + dx - w.labelWidth
        return { x, labelY, className: w.className, name: w.name, shownAmount: w.shownAmount, anchor, dx, labelWidth: w.labelWidth, haloLeft }
      })
    })
  // Each marker type's own label/line color (mirrors the --accent/--info/--ok/--fail custom
  // properties in style.css -- duplicated here rather than read via getComputedStyle, since these
  // strings are assembled into markup before anything is in the DOM to compute against). When two
  // or more distinct types share an age, their line blends all of them via color-mix rather than
  // falling back to one flat neutral tone -- a quick visual hint of WHICH kinds of things are
  // stacked on that line before even reading the labels. Chained pairwise at decreasing weights
  // (1/2, 1/3, 1/4, ...) rather than flat 50/50 so N colors end up EQUALLY weighted regardless of
  // how many are being folded in, not biased toward whichever was mixed in last.
  const MARKER_COLORS = { ruleof55: "#9446ed", mortgage: "#66b5fa", income: "#65d6ad", acacliff: "#ff9b9b", expense: "#f2b544" }
  const blendMarkerColors = (classNames) =>
    classNames
      .map((cls) => MARKER_COLORS[cls])
      .reduce((acc, color, i) => (i === 0 ? color : `color-mix(in srgb, ${color} ${Math.round(100 / (i + 1))}%, ${acc} ${Math.round(100 - 100 / (i + 1))}%)`))
  const sharedAgeLines = [...markersByAge.entries()]
    .map(([age, atAge]) => {
      const distinctClasses = [...new Set(atAge.map((m) => m.className))]
      const x = scaleX(age)
      const style = distinctClasses.length > 1 ? ` style="stroke: ${blendMarkerColors(distinctClasses)}"` : ""
      const className = distinctClasses.length === 1 ? distinctClasses[0] : "shared"
      return `<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${height - margin.bottom}" class="bridge-${className}-line"${style} />`
    })
    .join("")
  // Every marker's own vertical guide line runs the FULL plot height, so a marker whose x lands
  // under an earlier row's (wider) label would otherwise pierce it -- painting every line, THEN
  // every halo, THEN every label (rather than looping once and emitting each marker's own
  // line+halo+text together) means a label's halo covers ANY marker's line behind it, not just the
  // one it shares a row with.
  const markerLines =
    sharedAgeLines +
    positionedMarkers
      .map(({ labelY, haloLeft, labelWidth }) => `<rect x="${haloLeft.toFixed(1)}" y="${(labelY - 8).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="11" class="bridge-label-halo" />`)
      .join("") +
    positionedMarkers
      .map(
        ({ x, labelY, className, name, shownAmount, anchor, dx }) =>
          `<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" class="bridge-${className}-label" text-anchor="${anchor}" dx="${dx}">${escapeHtml(`${name}: ${shownAmount}`)}</text>`,
      )
      .join("")

  // Past 4 series, direct end-labels start to collide with each other rather than with the lines
  // -- fall back to the legend + tooltip, per the series-count ladder. Only depleting scenarios
  // carry one regardless (see the doc comment on BRIDGE_WINDOW_YEARS for why a funded one doesn't).
  const directLabels = scenarios.length <= 4
  // "depletes at age N" labels used to sit right on each scenario's own line, at that scenario's
  // own endY -- which put two labels on top of each other whenever two scenarios happened to
  // deplete at a similar balance, regardless of how far apart their ages were. Stacked along the
  // plot's bottom edge instead, ordered left to right by age (soonest first) and built bottom-up
  // (the same shape as positionedMarkers' own top-down stack above, just anchored to the opposite
  // edge) -- two labels can never land on the same row regardless of where their lines actually
  // end, so they can never collide with each other, only ever with the axis (which margin.bottom
  // already reserves room for).
  const DEPLETION_LABEL_ROW_STEP = 12
  const depletionLabels = directLabels
    ? scenarios
        .map(({ result, drawn }) => (result.depletionAge == null ? null : { age: result.depletionAge, endX: scaleX(drawn[drawn.length - 1].age) }))
        .filter((entry) => entry !== null)
        .sort((a, b) => a.endX - b.endX)
        .map((entry, row) => ({ ...entry, labelY: height - margin.bottom - 8 - row * DEPLETION_LABEL_ROW_STEP }))
    : []
  const depletionLabelsSvg = depletionLabels
    .map(
      ({ age, endX, labelY }) =>
        `<text x="${endX.toFixed(1)}" y="${labelY.toFixed(1)}" class="bridge-end-label" text-anchor="${endX > width - margin.right - 56 ? "end" : "middle"}">depletes at age ${age}</text>`,
    )
    .join("")
  const seriesSvg = scenarios
    .map(({ result, drawn, full, trimmed }, index) => {
      const color = BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]
      // One continuous line across real history, the projected accumulation phase, and the
      // withdrawal-phase simulation -- see mergeBridgeSegments above for why `full` has no seam at
      // either join. Same solid-accessible/dashed-locked styling throughout; nothing here marks
      // where real data ends and projection begins, since the finding text and (once hovered) the
      // tooltip both already carry that distinction age-by-age.
      //
      const firstLockedIndex = full.findIndex((point) => point.lockedBalance > 0)
      const lastLockedIndex = full.map((point) => point.lockedBalance > 0).lastIndexOf(true)
      const hasUnlock = lastLockedIndex !== -1 && lastLockedIndex + 1 < full.length
      // The TRUE combined value both lines converge on at the unlock age -- full[lastLockedIndex
      // + 1].accessibleBalance, not full[lastLockedIndex].lockedBalance. Those two look like they
      // should be the same figure (all of what was locked, become accessible) but aren't: the
      // former has a further year of growth on it that the latter doesn't, so joining on the
      // pre-growth figure left the dashed line's own endpoint visibly below where the solid line
      // actually lands.
      const unlockValue = hasUnlock ? full[lastLockedIndex + 1].accessibleBalance : 0
      // Held flat one age further than the real data (lockedBalance is already 0 the moment it
      // unlocks, at full[lastLockedIndex + 1]) and up to unlockValue, not its own pre-growth
      // figure, so its endpoint is the exact point the solid line's jump lands on.
      const lockedPoints =
        firstLockedIndex === -1
          ? []
          : hasUnlock
            ? [...full.slice(firstLockedIndex, lastLockedIndex + 1), { age: full[lastLockedIndex + 1].age, lockedBalance: unlockValue }]
            : full.slice(firstLockedIndex, lastLockedIndex + 1)
      // The jump itself: held flat to the SAME age the dashed line was extended to (its own low
      // value didn't change between these two whole-year snapshots either, only locked's did),
      // THEN straight up to unlockValue at that same x -- moving only the top of the jump to the
      // unlock age and leaving the bottom at the prior age would draw a DIAGONAL spanning both
      // ages instead of a vertical rise at one; both ends need to move together for the two lines
      // to actually meet. full.slice(lastLockedIndex + 1) already starts at this same value (its
      // own first point IS unlockValue), so nothing further needs inserting after it.
      const accessiblePoints = hasUnlock
        ? [...full.slice(0, lastLockedIndex + 1), { age: full[lastLockedIndex + 1].age, accessibleBalance: full[lastLockedIndex].accessibleBalance }, ...full.slice(lastLockedIndex + 1)]
        : full
      const last = drawn[drawn.length - 1]
      const endX = scaleX(last.age)
      const endY = scaleY(last.accessibleBalance)
      // The chart's own right edge now runs out to planToAge (see minAge/maxAge above), past where
      // a windowed funded scenario's line actually stops -- so "runs off the right edge" no longer
      // reads as "still fine" for it the way it used to. A small open chevron in the series' own
      // color stands in for that: "still going, deliberately not drawn past here" (see
      // BRIDGE_WINDOW_YEARS), rather than a line that just dead-ends with blank chart after it.
      const endMarker =
        result.depletionAge != null
          ? `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="4.5" class="bridge-end-critical" />`
          : trimmed
            ? `<path d="M${(endX + 1).toFixed(1)},${(endY - 4).toFixed(1)} L${(endX + 7).toFixed(1)},${endY.toFixed(1)} L${(endX + 1).toFixed(1)},${(endY + 4).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" class="bridge-end-continues" />`
            : `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2" />`
      const lockedDashOffset = lockedPoints.length > 1 ? dashOffsetEndingMidDash(pathPixelLength(lockedPoints, "lockedBalance"), 4, 3) : 0
      return `<g data-series="${index}">
          ${lockedPoints.length > 1 ? `<path d="${linePath(lockedPoints, "lockedBalance")}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 3" stroke-dashoffset="${lockedDashOffset.toFixed(2)}" opacity="0.55" />` : ""}
          <path d="${linePath(accessiblePoints, "accessibleBalance")}" fill="none" stroke="${color}" stroke-width="2" />
          ${endMarker}
        </g>`
    })
    .join("")

  const showsLocked = scenarios.some((s) => s.full.some((point) => point.lockedBalance > 0))

  const wrap = document.createElement("div")
  wrap.className = "bridge-chart"
  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="bridge-chart-svg" role="img" aria-label="Bridge burndown: accessible balance by age for each selected retirement age">
      ${gridlines}
      ${ageAxis}
      ${seriesSvg}
      ${unlockLines}
      ${markerLines}
      ${depletionLabelsSvg}
      <line class="bridge-crosshair" x1="0" y1="${margin.top}" x2="0" y2="${height - margin.bottom}" hidden />
      <rect class="bridge-hit" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
    </svg>
    <div class="bridge-tooltip" hidden></div>
    <div class="bridge-chart-side">
      <div class="bridge-legend">${scenarios
        .map(
          ({ result }, index) =>
            `<span class="bridge-legend-item"><span class="bridge-legend-swatch" style="background:${BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]}"></span>Retire at ${result.retirementAge}</span>`,
        )
        .join("")}</div>
      ${showsLocked ? `<div class="bridge-style-key"><span class="bridge-style-key-item"><span class="bridge-key-line bridge-key-solid"></span>Accessible</span><span class="bridge-style-key-item"><span class="bridge-key-line bridge-key-dashed"></span>Locked</span></div>` : ""}
    </div>
  `

  wireBridgeTooltip(wrap, scenarios, { width, scaleX, minAge, maxAge, margin, plotWidth, currentAge })
  return addChartZoom(wrap, "Bridge burndown chart")
}

// Which scenario the Bridge table is currently showing, when more than one retirement age is
// selected -- module-level (not per-render state) so re-rendering after a scenario change (the
// picker below) or a privacy toggle doesn't reset back to the first one. Not persisted across a
// reload the way the chart/table view itself is (see applyBridgeTableView) -- simple enough to
// just default back to the first scenario each fresh load.
let selectedBridgeTableScenarioIndex = 0

// Whether the Bridge table's own column-picker popover is open -- module-level, not per-render
// state, for the same reason closeHelpPopover's own open/closed state is: a document-level
// click-outside-closes-it listener (wired once, below) needs to reach it regardless of which
// renderBridgeTable call most recently rebuilt the table, and needs to stay in sync with
// whatever renderAll draws next even though closing it from outside doesn't itself call renderAll.
let bridgeTableColumnsPopoverOpen = false
function closeBridgeTableColumnsPopover() {
  if (!bridgeTableColumnsPopoverOpen) return
  bridgeTableColumnsPopoverOpen = false
  // Direct DOM manipulation, not a re-render -- there's only ever one .bridge-table live at a
  // time (addChartZoom/openChartZoom reparent the same node rather than cloning it), and closing
  // a popover shouldn't have to rebuild the whole table underneath it.
  document.querySelectorAll(".bridge-table-columns-popover").forEach((el) => (el.hidden = true))
  document.querySelectorAll(".bridge-table-columns-btn").forEach((btn) => btn.setAttribute("aria-expanded", "false"))
}
document.addEventListener("click", (e) => {
  if (bridgeTableColumnsPopoverOpen && !e.target.closest(".bridge-table-columns")) closeBridgeTableColumnsPopover()
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bridgeTableColumnsPopoverOpen) closeBridgeTableColumnsPopover()
})

// Every column the Bridge table can show, beyond Age (always shown -- it's the row key, not a
// toggleable column). "kind" drives both bridgeTableHeaderCell/bridgeTableDataCell below; the
// "account" columns are one per this plan's own portfolio accounts, so the full list has to be
// rebuilt from a real BridgeResult rather than living as a fixed constant. Built from usable[0]
// (see renderBridgeTable) regardless of which scenario is currently selected -- every scenario
// simulates the SAME portfolio, just at a different retirement age, so the account list itself
// doesn't vary between them.
function bridgeTableColumnDefs(result) {
  return [
    { id: "taxDeferred", label: "Tax-deferred", kind: "taxDeferred" },
    // Right next to Tax-deferred, not off with the summary/MAGI columns further down -- it's the
    // same kind of tax-deferred-account activity (issue #29's ACA subsidy floor), just a transfer
    // instead of a withdrawal.
    { id: "rothConversion", label: "Roth conversion", kind: "rothConversion" },
    { id: "nonTaxable", label: "Non-taxable", kind: "nonTaxable" },
    { id: "pctFPL", label: "%FPL", kind: "pctFPL" },
    { id: "magi", label: "MAGI", kind: "magi" },
    { id: "expenses", label: "Expenses", kind: "expenses" },
    ...result.accounts.map((account) => ({ id: `account:${account.id}`, label: account.name, kind: "account", account })),
  ]
}

// Function to read the Bridge table's own column order + visibility -- persisted the same
// getCookie/setCookie way the chart/table toggle itself is (see applyBridgeTableView), as one
// ordered, comma-joined list where a `-` prefix means "in the picker's list, but not currently
// shown" (so one cookie value carries both the full picker order AND the visible subset, rather
// than needing two separate ones that could drift out of sync with each other). A column id no
// longer present in defs (an account renamed or removed since) is silently dropped; one that's
// never been seen before (a brand new account, on a saved cookie from before it existed) is
// appended at the end, unselected, so it's discoverable in the picker without silently widening
// the table underneath whoever's looking at it right now. A first-ever visit (no cookie yet)
// defaults to every column, all selected, in bridgeTableColumnDefs' own order -- the table's own
// horizontal scroll (and the picker itself, to trim it back down) is what absorbs a wide portfolio
// from there, rather than a narrower default guessing which few columns matter most.
function bridgeTableColumnState(defs) {
  const validIds = new Set(defs.map((col) => col.id))
  let saved = null
  try {
    const raw = getCookie("bridgeTableColumns")
    if (raw !== null) saved = raw === "" ? [] : raw.split(",")
  } catch {
    // Cookies disabled -- falls through to the defaults below, same as everywhere else on this
    // page that reads a cookie.
  }
  const order = []
  const selected = new Set()
  ;(saved ?? defs.map((col) => col.id)).forEach((entry) => {
    const isSelected = !entry.startsWith("-")
    const id = isSelected ? entry : entry.slice(1)
    if (!validIds.has(id) || order.includes(id)) return
    order.push(id)
    if (isSelected) selected.add(id)
  })
  defs.forEach((col) => {
    if (!order.includes(col.id)) order.push(col.id)
  })
  return { order, selected }
}
function saveBridgeTableColumnState(order, selected) {
  try {
    setCookie("bridgeTableColumns", order.map((id) => (selected.has(id) ? id : `-${id}`)).join(","))
  } catch {
    // Cookies disabled -- the picker still works for this page view, it just won't be remembered.
  }
}

// Function to build one column's own header <th> -- an account column additionally carries its
// tax-treatment chip (see the account-head CSS for why that lives on an inner span, not the <th>
// itself).
function bridgeTableHeaderCell(col) {
  if (col.kind === "account") {
    return `<th class="bt-account-head"><span class="bt-account-head-inner"><span class="bt-account-name">${escapeHtml(col.label)}</span><span class="chip ${col.account.taxTreatment}">${col.account.taxTreatment}</span></span></th>`
  }
  // Tax-deferred/non-taxable are GROSS (pre-tax) withdrawal figures, same as every account
  // column's own balance -- can legitimately exceed that year's Expenses once an account's own
  // tax rate (and any early-withdrawal penalty) is backed out, since covering $60,000 of real
  // spend from a 22%-taxed account means actually withdrawing ~$76,900 gross. Not obvious just
  // from the column name, so it gets a title tooltip the other (need- rather than tax-rate-
  // driven) columns don't.
  if (col.kind === "rothConversion") {
    return `<th title="Money moved from a traditional account to a Roth one this year to keep MAGI at the ACA subsidy floor -- a transfer, not a withdrawal, so it doesn't fund any of that year's spending">${escapeHtml(col.label)}</th>`
  }
  const title = col.kind === "taxDeferred" || col.kind === "nonTaxable" ? ` title="Gross (pre-tax) withdrawal -- can exceed Expenses once the account's own tax rate is backed out"` : ""
  return `<th${title}>${escapeHtml(col.label)}</th>`
}
// Function to build one column's own <td> for a given row -- isPrivate only matters for the
// account column's own title-attribute withdrawal tooltip (see its own doc comment on why that
// one can't just rely on the usual .money CSS-blur convention every dollar cell here otherwise
// uses).
function bridgeTableDataCell(col, point, isPrivate) {
  switch (col.kind) {
    case "expenses":
      return `<td class="bt-num">${point.projectedSpend != null ? moneySpan(point.projectedSpend) : "—"}</td>`
    case "account": {
      const balance = point.balancesByAccountId?.[col.account.id]
      if (balance == null) return `<td class="bt-num">—</td>`
      const locked = col.account.accessAge != null && point.age < col.account.accessAge
      const withdrawn = point.withdrawalsByAccountId?.[col.account.id]
      // Native title attribute -- the lightest existing per-cell tooltip mechanism (matches the
      // budget table's own bt-flagged convention), showing what came out of THIS account during
      // THIS age (which is what reduces it by the time next age's row is reached), rather than a
      // whole new positioned-tooltip system for one figure.
      const title = withdrawn != null ? ` title="Withdrawn this year: ${escapeHtml(moneyMaskText(usd(withdrawn), isPrivate))}"` : ""
      return `<td class="bt-num${locked ? " bt-locked" : ""}"${title}>${moneySpan(balance)}</td>`
    }
    case "taxDeferred":
    case "nonTaxable": {
      const gross = col.kind === "taxDeferred" ? point.grossTaxDeferredWithdrawal : point.grossNonTaxDeferredWithdrawal
      if (gross == null) return `<td class="bt-num">—</td>`
      // This figure is GROSS (pre-tax) -- it can legitimately exceed Expenses (what's actually
      // available to spend, after tax) once the tax owed on withdrawing it is backed out. Spelled
      // out with this row's own real numbers, not just the column header's generic version,
      // since that's the more natural place to look once a specific figure looks surprising.
      const title =
        point.projectedSpend != null
          ? ` title="Gross (pre-tax) withdrawal -- this year's Expenses (what's actually available to spend, after tax): ${escapeHtml(moneyMaskText(usd(point.projectedSpend), isPrivate))}. The difference covers the tax owed on this withdrawal."`
          : ""
      return `<td class="bt-num"${title}>${moneySpan(gross)}</td>`
    }
    case "rothConversion":
      // Undefined on the vast majority of rows (no acaFloorPctFpl set, or none needed that year)
      // -- "—", not $0.00, so a row that genuinely converted $0 (impossible today, but the same
      // "no real figure computed" convention every other column here uses) would be
      // distinguishable in principle.
      return `<td class="bt-num">${point.rothConversionAmount != null ? moneySpan(point.rothConversionAmount) : "—"}</td>`
    case "pctFPL":
      return `<td class="bt-num">${point.pctFPL != null ? `<span class="money">${(Math.round(point.pctFPL * 10) / 10).toLocaleString()}</span>%` : "—"}</td>`
    case "magi":
      return `<td class="bt-num">${point.magi != null ? moneySpan(point.magi) : "—"}</td>`
    default:
      return `<td class="bt-num">—</td>`
  }
}

// Function to find which column row a dragged one should land BEFORE, based on vertical mouse
// position -- the same standard vanilla-JS drag-reorder technique (and near-identical code) as
// dragAfterElement above, just scoped to .bridge-table-column-row instead of .account-row; kept
// separate rather than generalizing the one function over both, since the two lists live in
// entirely different parts of the page with no shared lifecycle to couple them through one helper.
function bridgeTableColumnAfterElement(list, y) {
  const rows = [...list.querySelectorAll(".bridge-table-column-row:not(.dragging)")]
  return rows.reduce(
    (closest, row) => {
      const box = row.getBoundingClientRect()
      const offset = y - box.top - box.height / 2
      return offset < 0 && offset > closest.offset ? { offset, element: row } : closest
    },
    { offset: Number.NEGATIVE_INFINITY, element: null },
  ).element
}

// Function to render the Bridge chart's own per-age/per-account numbers as a table instead of a
// line -- toggled via #bridgeViewToggle (see applyBridgeTableView), issue #25. Same "usable"
// filter and addChartZoom wiring as renderBridgeChart so the two views are interchangeable from
// the same call site (renderCheckResult) and equally available zoomed or not. Deliberately a much
// simpler function than renderBridgeChart: no scaling/axes/windowing to compute, just formatting
// numbers simulateBridge and fire-generate.ts's attachMagi already produced.
function renderBridgeTable(bridgeResults, currentAge, planToAge) {
  const usable = bridgeResults.filter((result) => result.timeline.length > 0 && result.accessibleAtRetirement + result.lockedAtRetirement > 0)
  if (usable.length === 0) return null
  // Read once, not per-row -- see renderBridgeChart's own isPrivate for why (this table uses the
  // normal moneySpan/.money CSS-blur convention for its dollar cells, which reacts to body.privacy
  // live and so doesn't itself need isPrivate; it's only needed here for the title-attribute
  // withdrawal tooltip below, a NATIVE tooltip with no CSS/DOM to blur and no re-render hook of its
  // own to react to a later privacy toggle -- same reasoning as the chart's own moneyMaskText).
  const isPrivate = document.body.classList.contains("privacy")

  // One row per age from currentAge through wherever this scenario's own real data actually ends
  // (planToAge if funded, its own depletion age otherwise) -- unlike the chart's own line, this
  // is NOT windowed (see BRIDGE_WINDOW_YEARS): a table of numbers has no "runs off-scale and
  // misleads the eye" problem to avoid, so it shows the real figures all the way through. Shared
  // by the rendered table and its CSV export below, so the two can never disagree about which
  // rows exist.
  const rowsForScenario = (result) => {
    const pointsByAge = new Map()
    result.accumulation.forEach((point) => pointsByAge.set(point.age, point))
    result.timeline.forEach((point) => pointsByAge.set(point.age, point))
    const rows = []
    for (let age = currentAge; age <= planToAge; age++) {
      const point = pointsByAge.get(age)
      if (point) rows.push(point)
    }
    return rows
  }

  const renderScenarioTable = (result, rows, columns) => {
    const headHtml = columns.map(bridgeTableHeaderCell).join("")
    const rowsHtml = rows
      .map((point) => `<tr><td class="bt-age">${point.age}</td>${columns.map((col) => bridgeTableDataCell(col, point, isPrivate)).join("")}</tr>`)
      .join("")

    return `<div class="bridge-table-wrap">
      <table class="bridge-table-el">
        <thead>
          <tr>
            <th class="bt-age">Age</th>
            ${headHtml}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`
  }

  const wrap = document.createElement("div")
  wrap.className = "bridge-table"
  let draggingColumnRow = null

  const renderAll = () => {
    const index = Math.min(selectedBridgeTableScenarioIndex, usable.length - 1)
    const result = usable[index]
    const defs = bridgeTableColumnDefs(usable[0])
    const { order, selected } = bridgeTableColumnState(defs)
    const allColumns = order.map((id) => defs.find((col) => col.id === id)).filter((col) => col != null)
    const visibleColumns = allColumns.filter((col) => selected.has(col.id))

    const picker =
      usable.length > 1
        ? `<div class="bridge-table-scenario-picker">
            <label for="bridgeTableScenario">Scenario</label>
            <select id="bridgeTableScenario" class="bridge-table-scenario-select">
              ${usable.map((r, i) => `<option value="${i}"${i === index ? " selected" : ""}>Retire at ${r.retirementAge}</option>`).join("")}
            </select>
          </div>`
        : ""
    const columnsPopover = `<div class="bridge-table-columns">
      <button type="button" class="bridge-table-columns-btn" aria-haspopup="true" aria-expanded="${bridgeTableColumnsPopoverOpen}">Columns</button>
      <div class="bridge-table-columns-popover"${bridgeTableColumnsPopoverOpen ? "" : " hidden"}>
        ${allColumns
          .map(
            (col) => `<div class="bridge-table-column-row" draggable="true" data-col-id="${escapeHtml(col.id)}">
              <span class="bt-col-drag-handle" aria-hidden="true">⣶</span>
              <label><input type="checkbox" data-col-id="${escapeHtml(col.id)}"${selected.has(col.id) ? " checked" : ""}> ${escapeHtml(col.label)}</label>
            </div>`,
          )
          .join("")}
      </div>
    </div>`
    const toolbar = `<div class="bridge-table-toolbar">${picker}<div class="bridge-table-toolbar-right">${columnsPopover}<button type="button" class="bridge-table-export">Export CSV</button></div></div>`
    wrap.innerHTML = toolbar + renderScenarioTable(result, rowsForScenario(result), visibleColumns)
  }
  renderAll()

  wrap.addEventListener("change", (e) => {
    if (e.target.matches(".bridge-table-scenario-select")) {
      selectedBridgeTableScenarioIndex = Number(e.target.value)
      renderAll()
      return
    }
    if (e.target.matches(".bridge-table-column-row input")) {
      const defs = bridgeTableColumnDefs(usable[0])
      const { order, selected } = bridgeTableColumnState(defs)
      if (e.target.checked) selected.add(e.target.dataset.colId)
      else selected.delete(e.target.dataset.colId)
      saveBridgeTableColumnState(order, selected)
      renderAll()
    }
  })
  wrap.addEventListener("click", (e) => {
    // The toolbar (scenario picker, columns popover, export button) lives inside the same wrap
    // addChartZoom below makes click-anywhere-to-zoom -- stopImmediatePropagation (not
    // stopPropagation; addChartZoom's own listener is on this SAME element, not an ancestor) keeps
    // using any of them from also zooming.
    if (e.target.closest(".bridge-table-toolbar")) e.stopImmediatePropagation()
    if (e.target.closest(".bridge-table-export")) {
      const index = Math.min(selectedBridgeTableScenarioIndex, usable.length - 1)
      const result = usable[index]
      // Every column, in bridgeTableColumnDefs' own canonical order -- deliberately ignoring the
      // picker's own current show/hide and reordering (unlike the rendered table itself): a CSV
      // is a data export, not a screenshot of the current view, so it should be complete every
      // time regardless of whatever subset happens to be on screen right now.
      downloadBridgeTableCsv(result, rowsForScenario(result), bridgeTableColumnDefs(usable[0]))
    }
    if (e.target.closest(".bridge-table-columns-btn")) {
      bridgeTableColumnsPopoverOpen = !bridgeTableColumnsPopoverOpen
      renderAll()
    }
  })
  // Drag-reorder for the columns popover's own list -- same technique (and near-identical code,
  // see bridgeTableColumnAfterElement's own doc comment) as the Accounts list's reorder-by-drag
  // handle elsewhere on this page. Delegated on wrap, not bound per-row, since renderAll rebuilds
  // the popover's rows on every change rather than mutating them in place.
  wrap.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".bridge-table-column-row")
    if (!row) return
    draggingColumnRow = row
    row.classList.add("dragging")
  })
  wrap.addEventListener("dragover", (e) => {
    if (!draggingColumnRow) return
    const list = e.target.closest(".bridge-table-columns-popover")
    if (!list) return
    e.preventDefault()
    const afterElement = bridgeTableColumnAfterElement(list, e.clientY)
    if (afterElement == null) list.appendChild(draggingColumnRow)
    else if (afterElement !== draggingColumnRow) list.insertBefore(draggingColumnRow, afterElement)
  })
  wrap.addEventListener("dragend", (e) => {
    const row = e.target.closest(".bridge-table-column-row")
    if (!row) return
    row.classList.remove("dragging")
    draggingColumnRow = null
    const list = wrap.querySelector(".bridge-table-columns-popover")
    const newOrder = [...list.querySelectorAll(".bridge-table-column-row")].map((r) => r.dataset.colId)
    const defs = bridgeTableColumnDefs(usable[0])
    const { selected } = bridgeTableColumnState(defs)
    saveBridgeTableColumnState(newOrder, selected)
    renderAll()
  })

  return addChartZoom(wrap, "Bridge burndown table")
}

// Escapes one CSV field -- quoted (with internal quotes doubled) only when it actually needs to
// be (contains a comma, quote, or newline), matching the common convention of leaving simple
// fields unquoted for readability rather than quoting everything unconditionally.
function csvField(value) {
  const str = String(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

// Function to save one Bridge table scenario as a CSV file -- the same rows renderBridgeTable
// itself draws (rowsForScenario), but EVERY column (see its own call site for why this
// deliberately ignores the picker's current show/hide and reordering), reformatted as plain
// numbers (no $/commas -- a comma inside an unquoted field would corrupt the CSV, and a
// spreadsheet reads a bare number as currency-ready on its own) rather than parsed back out of
// the rendered HTML. Always exports the real, unmasked figures regardless of privacy mode -- this
// is an explicit local save-to-disk action by
// the account owner, not something shown on screen to a stranger, so there's nothing for privacy
// mode to protect here the way there is for the rendered table/chart.
function downloadBridgeTableCsv(result, rows, columns) {
  const dollars = (cents) => (cents == null ? "" : (cents / 100).toFixed(2))
  const csvValue = (col, point) => {
    switch (col.kind) {
      case "expenses":
        return dollars(point.projectedSpend)
      case "account":
        return dollars(point.balancesByAccountId?.[col.account.id])
      case "taxDeferred":
        return dollars(point.grossTaxDeferredWithdrawal)
      case "nonTaxable":
        return dollars(point.grossNonTaxDeferredWithdrawal)
      case "rothConversion":
        return dollars(point.rothConversionAmount)
      case "pctFPL":
        return point.pctFPL != null ? (Math.round(point.pctFPL * 10) / 10).toFixed(1) : ""
      case "magi":
        return dollars(point.magi)
      default:
        return ""
    }
  }
  const header = ["Age", ...columns.map((col) => col.label)]
  const dataRows = rows.map((point) => [point.age, ...columns.map((col) => csvValue(col, point))])
  const csv = [header, ...dataRows].map((row) => row.map(csvField).join(",")).join("\r\n")
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `bridge-retire-at-${result.retirementAge}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// Function to show/hide an SVG element via the `hidden` ATTRIBUTE directly, not the `.hidden` IDL
// property -- confirmed live that setting `.hidden` on an SVGElement (unlike an HTMLElement) does
// not reliably remove the attribute in this browser, so the CSS `[hidden] { display: none }` rule
// it's meant to drive kept matching regardless of the property's own value. This silently broke the
// bridge/Monte Carlo crosshair specifically (a plain <div> tooltip alongside it uses .hidden fine,
// since that one really is an HTMLElement): the crosshair line could never actually show, on either
// chart, so the tooltip's reported age had nothing on screen confirming which exact x it snapped to.
function setSvgHidden(el, hidden) {
  if (hidden) el.setAttribute("hidden", "")
  else el.removeAttribute("hidden")
}

// Function to wire the chart's hover layer: a crosshair that snaps to the nearest whole age (every
// series has an exact point at every age it covers -- see simulateBridge's timeline -- so there is
// never a value to interpolate), and one tooltip row per series that still has data at that age.
// Every figure it shows is also in the prose finding below the chart, so this enhances rather than
// gates -- there is no keyboard-equivalent hover here, which is fine precisely because of that.
function wireBridgeTooltip(wrap, scenarios, scale) {
  const svg = wrap.querySelector(".bridge-chart-svg")
  const hit = wrap.querySelector(".bridge-hit")
  const crosshair = wrap.querySelector(".bridge-crosshair")
  const tooltip = wrap.querySelector(".bridge-tooltip")
  // Keyed off what is actually drawn (the merged history/accumulation/withdrawal line, `full`),
  // not each scenario's raw timeline -- a funded scenario's line may be windowed short of its real
  // end (see BRIDGE_WINDOW_YEARS), and the tooltip should never offer a value for an age that isn't
  // on screen to hover in the first place.
  const byAge = scenarios.map(({ full }) => new Map(full.map((point) => [point.age, point])))

  const move = (event) => {
    const rect = svg.getBoundingClientRect()
    const svgX = ((event.clientX - rect.left) / rect.width) * scale.width
    const fraction = Math.min(1, Math.max(0, (svgX - scale.margin.left) / scale.plotWidth))
    const age = Math.round(scale.minAge + fraction * (scale.maxAge - scale.minAge))

    // Past a windowed scenario's own arrowhead (see BRIDGE_WINDOW_YEARS), byAge has no entry for
    // this age -- but the crosshair should still land there and show what age it is, since that's
    // the whole point of hovering there in the first place. Only the per-scenario metric rows,
    // which need real data, drop out for a scenario with nothing at this age.
    const rows = scenarios.map(({ result }, index) => ({ result, index, point: byAge[index].get(age) })).filter((row) => row.point)

    setSvgHidden(crosshair, false)
    crosshair.setAttribute("x1", scale.scaleX(age).toFixed(1))
    crosshair.setAttribute("x2", scale.scaleX(age).toFixed(1))

    // Read fresh on every hover move, not cached at wireBridgeTooltip's own call time -- the
    // tooltip is rebuilt from scratch here regardless, so it may as well always reflect whatever
    // the privacy toggle currently says rather than whatever it said when the chart was drawn.
    const isPrivate = document.body.classList.contains("privacy")
    tooltip.innerHTML = ""
    const heading = document.createElement("div")
    heading.className = "bridge-tooltip-age"
    heading.textContent = `Age ${age}`
    tooltip.appendChild(heading)
    // One flex-item span per figure (label + its value together), not bare text nodes -- the
    // row's own flex gap only reads as a clean, even gap next to each "|" separator this way,
    // rather than also prying a label away from its own value.
    const metricSpan = (unitLabel, amount) => {
      const metric = document.createElement("span")
      metric.className = "bridge-tooltip-metric"
      const value = document.createElement("span")
      value.className = "bridge-tooltip-value"
      value.textContent = moneyMaskText(usd(amount), isPrivate)
      metric.append(`${unitLabel}: `, value)
      return metric
    }
    rows.forEach(({ result, index, point }) => {
      const row = document.createElement("div")
      row.className = "bridge-tooltip-row"
      const key = document.createElement("span")
      key.className = "bridge-tooltip-key"
      key.style.background = BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]
      row.appendChild(key)
      if (scenarios.length > 1) {
        const label = document.createElement("span")
        label.className = "bridge-tooltip-label"
        label.textContent = `retire at ${result.retirementAge}:`
        row.appendChild(label)
      }
      // "Projected" only reads right for an age that hasn't happened yet -- a pre-currentAge point
      // runs the same formula backward (see BridgeYear's own projectedSpend doc comment), which
      // isn't a projection at all, just this plan's own expense figure restated for that year.
      const metrics = []
      if (point.projectedSpend != null) metrics.push(metricSpan(age < scale.currentAge ? "expenses" : "projected expenses", point.projectedSpend))
      metrics.push(metricSpan("accessible", point.accessibleBalance))
      if (point.lockedBalance > 0) metrics.push(metricSpan("locked", point.lockedBalance))
      metrics.forEach((metric, metricIndex) => {
        if (metricIndex > 0) {
          const sep = document.createElement("span")
          sep.className = "bridge-tooltip-sep"
          sep.textContent = "|"
          row.appendChild(sep)
        }
        row.appendChild(metric)
      })
      tooltip.appendChild(row)
    })
    tooltip.hidden = false
    const wrapRect = wrap.getBoundingClientRect()
    const left = Math.min(event.clientX - wrapRect.left + 12, wrapRect.width - tooltip.offsetWidth - 4)
    tooltip.style.left = `${Math.max(4, left)}px`
    tooltip.style.top = `${Math.max(0, event.clientY - wrapRect.top - tooltip.offsetHeight - 12)}px`
  }

  hit.addEventListener("pointermove", move)
  hit.addEventListener("pointerleave", () => {
    tooltip.hidden = true
    setSvgHidden(crosshair, true)
  })
}

// Area-fill opacity for the two nested percentile bands -- both a wash, never a saturated block
// (see the dataviz skill's own mark spec: ~10% for a single area fill). The inner band is a
// narrower, more-likely range (25th-75th percentile) than the outer one (10th-90th), so it reads
// slightly more solid -- still well short of "saturated."
const MC_BAND_OUTER_OPACITY = 0.1
const MC_BAND_INNER_OPACITY = 0.22
let mcChartInstanceCounter = 0

// Function to draw the Monte Carlo fan chart: one percentile band per selected retirement age,
// from today's age through the plan's target age (every scenario shares the same age range --
// unlike Bridge, the horizon here is fixed by currentAge/targetAge alone, not by when each
// scenario happens to deplete). Outer band = 10th-90th percentile (80% of simulated runs), inner
// band = 25th-75th (the interquartile range), solid line = median (50th). Returns null when there
// is nothing to plot.
function renderMonteCarloChart(monteCarloResults, currentAge, monteCarloHistory = []) {
  const usable = monteCarloResults.filter((r) => r.percentileBands.length > 0)
  if (usable.length === 0) return null
  const isPrivate = document.body.classList.contains("privacy")

  const series = usable.map((result) => ({
    result,
    points: result.percentileBands.map((band) => ({ age: currentAge + band.year, ...band })),
  }))

  const width = 640
  const height = 240
  const margin = { top: 12, right: 16, bottom: 24, left: 54 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom

  // Real account history (monteCarloHistory), not simulated, pulls the domain's start earlier
  // still than currentAge -- contiguous with every series' own first point (band.year 0 is always
  // exactly at currentAge), unlike Bridge's own history, which can leave a real gap before a later
  // retirementAge. See checkDashboard's own history/historicalAges for how far back that can go.
  const minAge = Math.min(currentAge, ...monteCarloHistory.map((point) => point.age), ...series.map((s) => s.points[0].age))
  const maxAge = Math.max(...series.map((s) => s.points[s.points.length - 1].age))
  // Scaled off the MEDIAN's own peak (with headroom), not the 75th/90th percentile bands:
  // compounding at the high end of a 30-40 year horizon can reach genuinely enormous nominal
  // figures (the same reason Bridge windows a funded scenario's own line -- see
  // BRIDGE_WINDOW_YEARS), and a scenario with a real chance of failure often has a median that
  // itself trends toward zero -- if the upper bands set the axis instead, that median (the line
  // that actually answers "does the typical run work") gets squashed into an unreadable sliver
  // near zero even though it's the headline number. The 75th/90th-percentile bands are still real
  // data and still drawn; they're simply clipped at the top of the plot area past this scale (see
  // the clip-path below) rather than resized around -- the same "windowed, not discarded"
  // treatment Bridge gives its own off-chart truth (the real numbers stay in the tooltip and the
  // finding text either way).
  const maxBalance = Math.max(1, ...series.flatMap((s) => s.points.map((point) => point.p50))) * 1.15
  const yTicks = niceAxisTicks(maxBalance, 4)
  const yMax = yTicks[yTicks.length - 1]

  const scaleX = (age) => margin.left + (maxAge === minAge ? 0 : ((age - minAge) / (maxAge - minAge)) * plotWidth)
  // Not clamped to the plot area -- values above yMax intentionally scale off the top edge, so the
  // clip-path below cuts them off cleanly instead of the path folding back on itself.
  const scaleY = (cents) => margin.top + plotHeight - (cents / yMax) * plotHeight
  const linePath = (points, key) => points.map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(point.age).toFixed(1)},${scaleY(point[key]).toFixed(1)}`).join(" ")
  // Standard "area between two curves" construction: forward along the top edge, backward along
  // the bottom edge, close the loop.
  const bandPath = (points, topKey, bottomKey) => {
    const forward = points.map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(point.age).toFixed(1)},${scaleY(point[topKey]).toFixed(1)}`).join(" ")
    const backward = [...points]
      .reverse()
      .map((point) => `L${scaleX(point.age).toFixed(1)},${scaleY(point[bottomKey]).toFixed(1)}`)
      .join(" ")
    return `${forward} ${backward} Z`
  }

  const gridlines = yTicks
    .map(
      (tickCents) =>
        `<line x1="${margin.left}" y1="${scaleY(tickCents).toFixed(1)}" x2="${width - margin.right}" y2="${scaleY(tickCents).toFixed(1)}" class="bridge-grid" />` +
        `<text x="${margin.left - 8}" y="${scaleY(tickCents).toFixed(1)}" class="bridge-axis-label" text-anchor="end" dominant-baseline="middle">${moneyMaskText(usdCompact(tickCents), isPrivate)}</text>`,
    )
    .join("")

  const span = maxAge - minAge
  const ageStep = span > 40 ? 10 : span > 12 ? 5 : 1
  const ageTicks = []
  for (let age = Math.ceil(minAge / ageStep) * ageStep; age <= maxAge; age += ageStep) ageTicks.push(age)
  if (ageTicks[0] !== minAge) ageTicks.unshift(minAge)
  if (ageTicks[ageTicks.length - 1] !== maxAge) ageTicks.push(maxAge)
  const ageAxis = ageTicks
    .map((age) => `<text x="${scaleX(age).toFixed(1)}" y="${height - margin.bottom + 16}" class="bridge-axis-label" text-anchor="middle">${age}</text>`)
    .join("")

  // Direct end-labels (the success rate) only up to 4 series, same series-count ladder Bridge
  // follows -- past that they'd collide with each other rather than with the lines.
  const directLabels = series.length <= 4
  // The median's own end point is pinned to the top of the plot area, not left to disappear,
  // when it's clipped away up there (a plan still climbing off the top of the chart at the target
  // age) -- clip-path only hides the PATH; the marker/label stay a visible "still going" cue.
  const endYRaw = series.map(({ points }) => scaleY(points[points.length - 1].p50))
  const endYClamped = endYRaw.map((y) => Math.max(margin.top + 10, y))
  // Stack collided end-labels vertically (forward pass: push each one down clear of the previous)
  // rather than letting them overlap -- see marks-and-anatomy.md's own "when end-labels collide"
  // guidance. Past ~4 converging series small multiples would be the right call instead;
  // directLabels above already turns labels off before that point.
  const MC_MIN_LABEL_GAP = 11
  const labelOrder = series.map((_, index) => index).sort((a, b) => endYClamped[a] - endYClamped[b])
  const labelY = [...endYClamped]
  labelOrder.forEach((index, order) => {
    if (order === 0) return
    const prevIndex = labelOrder[order - 1]
    if (labelY[index] - labelY[prevIndex] < MC_MIN_LABEL_GAP) labelY[index] = labelY[prevIndex] + MC_MIN_LABEL_GAP
  })
  // Backward pass: several scenarios failing around the same age (as here) all end at $0, so the
  // forward pass above can push the lowest label past the bottom of the plot -- where it would be
  // cut off by the clip-path below. Shift the whole stack back up by however far it overflowed,
  // which preserves the gaps the forward pass just established.
  const labelBottomBound = margin.top + plotHeight - 4
  const lowestLabelIndex = labelOrder[labelOrder.length - 1]
  if (labelY[lowestLabelIndex] > labelBottomBound) {
    const overflow = labelY[lowestLabelIndex] - labelBottomBound
    labelOrder.forEach((index) => {
      labelY[index] -= overflow
    })
  }

  // One shared, neutral line (real data belongs to no one scenario) for the real total-balance
  // history before currentAge -- extended through currentAge itself using the first series' own
  // year-0 point (every scenario's simulation starts from the same real current balance, with no
  // variance yet at year 0), so it meets the fan chart's own p50 line with no gap.
  const historyPoints = monteCarloHistory.length > 0 ? [...monteCarloHistory, { age: currentAge, totalBalance: series[0].points[0].p50 }] : []
  const historySvg = historyPoints.length > 1 ? `<path d="${linePath(historyPoints, "totalBalance")}" fill="none" stroke="var(--ink-soft)" stroke-width="2" />` : ""

  const seriesSvg = series
    .map(({ result, points }, index) => {
      const color = BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]
      const last = points[points.length - 1]
      const endX = scaleX(last.age)
      const endY = endYClamped[index]
      const successPct = Math.round(result.successRate * 100)
      const endLabel = directLabels
        ? `<text x="${endX.toFixed(1)}" y="${(labelY[index] - 9).toFixed(1)}" class="bridge-end-label" text-anchor="${endX > width - margin.right - 56 ? "end" : "middle"}">${successPct}% success</text>`
        : ""
      return `<g data-series="${index}">
          <path d="${bandPath(points, "p90", "p10")}" fill="${color}" opacity="${MC_BAND_OUTER_OPACITY}" stroke="none" />
          <path d="${bandPath(points, "p75", "p25")}" fill="${color}" opacity="${MC_BAND_INNER_OPACITY}" stroke="none" />
          <path d="${linePath(points, "p50")}" fill="none" stroke="${color}" stroke-width="2" />
          <circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2" />
          ${endLabel}
        </g>`
    })
    .join("")

  // Unique per instance so two charts on the same page (there's normally at most one, but IDs
  // must still not collide) don't fight over the same clip-path id.
  const clipId = `mc-plot-${mcChartInstanceCounter++}`
  const wrap = document.createElement("div")
  // mc-chart is a marker class only (no CSS rule of its own) -- lets a test or future selector
  // distinguish this chart from Bridge's, which shares every one of these class names for its
  // identical grid/axis/tooltip/legend styling.
  wrap.className = "bridge-chart mc-chart"
  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="bridge-chart-svg" role="img" aria-label="Monte Carlo simulation: percentile range of the portfolio balance by age, for each selected retirement age">
      <defs><clipPath id="${clipId}"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" /></clipPath></defs>
      ${gridlines}
      ${ageAxis}
      <g clip-path="url(#${clipId})">${historySvg}${seriesSvg}</g>
      <line class="bridge-crosshair" x1="0" y1="${margin.top}" x2="0" y2="${height - margin.bottom}" hidden />
      <rect class="bridge-hit" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
    </svg>
    <div class="bridge-tooltip" hidden></div>
    <div class="bridge-chart-side">
      <div class="bridge-legend">${series
        .map(
          ({ result }, index) =>
            `<span class="bridge-legend-item"><span class="bridge-legend-swatch" style="background:${BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]}"></span>Retire at ${result.retirementAge}</span>`,
        )
        .join("")}</div>
      <div class="bridge-style-key"><span class="bridge-style-key-item"><span class="mc-key-swatch mc-key-outer"></span>10th-90th</span><span class="bridge-style-key-item"><span class="mc-key-swatch mc-key-inner"></span>25th-75th</span><span class="bridge-style-key-item"><span class="bridge-key-line"></span>Median</span></div>
    </div>
  `

  wireMonteCarloTooltip(wrap, series, { width, scaleX, minAge, maxAge, margin, plotWidth })
  return addChartZoom(wrap, "Monte Carlo simulation")
}

// Function to wire the fan chart's hover layer -- same crosshair-snaps-to-the-nearest-whole-age
// approach as Bridge's own tooltip (every series has an exact point at every age in its horizon,
// so there is never a value to interpolate), showing the 10th/50th/90th percentile for whichever
// series still has data at that age.
function wireMonteCarloTooltip(wrap, series, scale) {
  const svg = wrap.querySelector(".bridge-chart-svg")
  const hit = wrap.querySelector(".bridge-hit")
  const crosshair = wrap.querySelector(".bridge-crosshair")
  const tooltip = wrap.querySelector(".bridge-tooltip")
  const byAge = series.map(({ points }) => new Map(points.map((point) => [point.age, point])))

  const move = (event) => {
    const isPrivate = document.body.classList.contains("privacy")
    const rect = svg.getBoundingClientRect()
    const svgX = ((event.clientX - rect.left) / rect.width) * scale.width
    const fraction = Math.min(1, Math.max(0, (svgX - scale.margin.left) / scale.plotWidth))
    const age = Math.round(scale.minAge + fraction * (scale.maxAge - scale.minAge))

    const rows = series.map(({ result }, index) => ({ result, index, point: byAge[index].get(age) })).filter((row) => row.point)
    if (rows.length === 0) {
      tooltip.hidden = true
      setSvgHidden(crosshair, true)
      return
    }

    setSvgHidden(crosshair, false)
    crosshair.setAttribute("x1", scale.scaleX(age).toFixed(1))
    crosshair.setAttribute("x2", scale.scaleX(age).toFixed(1))

    tooltip.innerHTML = ""
    const heading = document.createElement("div")
    heading.className = "bridge-tooltip-age"
    heading.textContent = `Age ${age}`
    tooltip.appendChild(heading)
    rows.forEach(({ result, index, point }) => {
      const row = document.createElement("div")
      row.className = "bridge-tooltip-row"
      const key = document.createElement("span")
      key.className = "bridge-tooltip-key"
      key.style.background = BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]
      const value = document.createElement("span")
      value.className = "bridge-tooltip-value"
      value.textContent = moneyMaskText(usd(point.p50), isPrivate)
      const label = document.createElement("span")
      label.className = "bridge-tooltip-label"
      label.textContent = series.length > 1 ? `retire ${result.retirementAge} (median)` : "median"
      row.append(key, value, label)
      const range = document.createElement("span")
      range.className = "bridge-tooltip-locked"
      const rangeText = isPrivate ? "$~~~~~ to $~~~~~" : `${usd(point.p10)} to ${usd(point.p90)}`
      range.textContent = `· ${rangeText} (80% of runs)`
      row.appendChild(range)
      tooltip.appendChild(row)
    })
    tooltip.hidden = false
    const wrapRect = wrap.getBoundingClientRect()
    const left = Math.min(event.clientX - wrapRect.left + 12, wrapRect.width - tooltip.offsetWidth - 4)
    tooltip.style.left = `${Math.max(4, left)}px`
    tooltip.style.top = `${Math.max(0, event.clientY - wrapRect.top - tooltip.offsetHeight - 12)}px`
  }

  hit.addEventListener("pointermove", move)
  hit.addEventListener("pointerleave", () => {
    tooltip.hidden = true
    setSvgHidden(crosshair, true)
  })
}

function renderFinding(finding) {
  const div = document.createElement("div")
  div.className = "finding"
  div.innerHTML = `<span class="chip ${finding.level}">${finding.level}</span>
    <div>
      <div class="title">${moneyify(finding.title)}</div>
      ${finding.detail.map((line) => `<div class="detail">${moneyify(line)}</div>`).join("")}
    </div>`
  return div
}

// Function to add the Spend/Rule of 55/debt-payoff tiles to the summary row once
// /api/retirement/check resolves -- plain label/number tiles matching Portfolio's own, rather than
// prose ("from your own crossover widget's selection..."). Removes and replaces any tiles a
// previous call added, rather than appending onto them, so a Refresh (or an auto re-check) doesn't
// pile up stale copies alongside fresh ones.
function renderSummaryStats(result) {
  const container = document.getElementById("summaryTiles")
  container.querySelectorAll(".tile-dynamic").forEach((el) => el.remove())
  const tiles = [{ label: "Projected Expenditures", value: `${moneySpan(result.annualSpend)}/yr` }]
  result.ruleOf55Boosts.forEach((b) => {
    tiles.push({ label: escapeHtml(b.accountName), value: `Rule of 55, age <span class="num money">${b.to}</span>` })
  })
  result.debtPayoffs.forEach((d) => {
    tiles.push({ label: escapeHtml(d.accountName), value: `${moneySpan(d.monthlyAmount)}/mo, paid off at age <span class="num money">${d.payoffAge}</span>` })
  })
  tiles.forEach((t) => {
    const div = document.createElement("div")
    div.className = "tile tile-dynamic"
    div.innerHTML = `<div class="label">${t.label}</div><div class="value num">${t.value}</div>`
    container.appendChild(div)
  })
}

// Fallback for the rare case a check fires before STATE itself has loaded (see renderLoadingSkeleton) --
// two plain chart-shaped slots (see [[no-layout-shift-ux-rule]]) at the real chart's own 640:240
// aspect ratio, since there's nothing yet to build a real skeleton (axis/legend/title) from.
const LOADING_MARKUP = `<div class="panel-loading chart-loading">
  <div class="chart-loading-slot">
    <div class="chart-loading-spinner"><div class="spinner" aria-hidden="true"></div>Loading…</div>
  </div>
  <div class="chart-loading-slot">
    <div class="chart-loading-spinner"><div class="spinner" aria-hidden="true"></div>Loading…</div>
  </div>
</div>`

// Function to build one chart's own loading placeholder -- everything a real
// renderBridgeChart/renderMonteCarloChart call already knows before the /api/retirement/check
// response even lands (the age axis, spanning currentAge-planToAge the same way the real charts
// do; the legend, one swatch per configured retirement age; a $ axis scaled off today's real
// portfolio total, since the actual future peak isn't known yet; the style key) drawn for real,
// with only the data that truly depends on the response (the lines themselves) standing in as a
// spinner. Same bridge-chart/bridge-chart-svg classes as the real thing so it's sized and styled
// identically. `styleKey` is the literal HTML for whichever style-key row the real chart would
// show (Accessible/Locked for Bridge, always shown for Monte Carlo) -- passed in rather than
// decided here, since Bridge's own version is conditional on a real guess (does ANY portfolio
// account still have a locked accessAge?) that belongs with the rest of that call's own inputs.
function renderChartSkeleton(ariaLabel, currentAge, planToAge, retirementAges, portfolioTotal, styleKey) {
  const isPrivate = document.body.classList.contains("privacy")
  const width = 640
  const height = 240
  const margin = { top: 12, right: 16, bottom: 24, left: 54 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const minAge = currentAge - SKELETON_HISTORY_LOOKBACK_YEARS_MAX
  const maxAge = planToAge
  const scaleX = (age) => margin.left + (maxAge === minAge ? 0 : ((age - minAge) / (maxAge - minAge)) * plotWidth)

  const span = maxAge - minAge
  const ageStep = span > 40 ? 10 : span > 12 ? 5 : 1
  const ageTicks = []
  for (let age = Math.ceil(minAge / ageStep) * ageStep; age <= maxAge; age += ageStep) ageTicks.push(age)
  if (ageTicks[0] !== minAge) ageTicks.unshift(minAge)
  if (ageTicks[ageTicks.length - 1] !== maxAge) ageTicks.push(maxAge)
  const ageAxis = ageTicks
    .map((age) => `<text x="${scaleX(age).toFixed(1)}" y="${height - margin.bottom + 16}" class="bridge-axis-label" text-anchor="middle">${age}</text>`)
    .join("")

  // A real chart's own y-axis is scaled off whatever the actual simulation peaks at, which isn't
  // known yet -- doubling today's real portfolio total is a plausible enough stand-in that the
  // gridlines/labels look like a real, if soon-to-be-corrected, chart rather than an arbitrary
  // guess, without pretending to forecast the plan's actual growth.
  const yTicks = niceAxisTicks(Math.max(1, portfolioTotal) * 2, 4)
  const yMax = yTicks[yTicks.length - 1]
  const scaleY = (cents) => margin.top + plotHeight - (cents / yMax) * plotHeight
  const gridlines = yTicks
    .map(
      (tickCents) =>
        `<line x1="${margin.left}" y1="${scaleY(tickCents).toFixed(1)}" x2="${width - margin.right}" y2="${scaleY(tickCents).toFixed(1)}" class="bridge-grid" />` +
        `<text x="${margin.left - 8}" y="${scaleY(tickCents).toFixed(1)}" class="bridge-axis-label" text-anchor="end" dominant-baseline="middle">${moneyMaskText(usdCompact(tickCents), isPrivate)}</text>`,
    )
    .join("")

  const wrap = document.createElement("div")
  wrap.className = "bridge-chart"
  wrap.innerHTML = `
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="bridge-chart-svg" role="img" aria-label="${escapeHtml(ariaLabel)} (loading)">
        ${gridlines}
        ${ageAxis}
      </svg>
      <div class="chart-loading-overlay"><div class="chart-loading-spinner"><div class="spinner" aria-hidden="true"></div>Loading…</div></div>
    </div>
    <div class="bridge-chart-side">
      <div class="bridge-legend">${retirementAges
        .map((age, index) => `<span class="bridge-legend-item"><span class="bridge-legend-swatch" style="background:${BRIDGE_SERIES_COLORS[index % BRIDGE_SERIES_COLORS.length]}"></span>Retire at ${age}</span>`)
        .join("")}</div>
      ${styleKey}
    </div>
  `
  return wrap
}

// Function to render the Bridge table's own loading placeholder, when the table view (not the
// chart) is active -- an empty table with the SAME columns (order and selection, from the
// persisted cookie bridgeTableColumnState reads) and row age labels the real table
// (renderBridgeTable) will show once /api/retirement/check actually returns, so the panel doesn't
// visibly reflow once real data lands -- the same reasoning renderChartSkeleton's own doc comment
// gives for drawing everything that doesn't truly depend on the response for real. Account
// columns use portfolioAccounts (id/name only, from skeletonInputsFrom) rather than a real
// BridgeResult's own accounts projection, which doesn't exist yet -- so these headers skip the
// tax-treatment chip a real column would carry; a loading placeholder doesn't need it, and
// tax-treatment isn't known this early anyway.
function renderBridgeTableSkeleton(currentAge, planToAge, portfolioAccounts) {
  const defs = [
    { id: "taxDeferred", label: "Tax-deferred", kind: "static" },
    // Kept in the SAME position bridgeTableColumnDefs' own real version uses -- ids/order have to
    // match exactly for the persisted cookie's column selection/order to carry over cleanly once
    // the real table replaces this skeleton.
    { id: "rothConversion", label: "Roth conversion", kind: "static" },
    { id: "nonTaxable", label: "Non-taxable", kind: "static" },
    { id: "pctFPL", label: "%FPL", kind: "static" },
    { id: "magi", label: "MAGI", kind: "static" },
    { id: "expenses", label: "Expenses", kind: "static" },
    ...portfolioAccounts.map((account) => ({ id: `account:${account.id}`, label: account.name, kind: "account" })),
  ]
  const { order, selected } = bridgeTableColumnState(defs)
  const columns = order.map((id) => defs.find((col) => col.id === id)).filter((col) => col != null && selected.has(col.id))

  const headHtml = columns
    .map((col) =>
      col.kind === "account"
        ? `<th class="bt-account-head"><span class="bt-account-head-inner"><span class="bt-account-name">${escapeHtml(col.label)}</span></span></th>`
        : `<th>${escapeHtml(col.label)}</th>`,
    )
    .join("")
  const cellsHtml = columns.map(() => `<td class="bt-num"><span class="skeleton-bar" style="width:70%"></span></td>`).join("")
  const rowsHtml = []
  for (let age = currentAge; age <= planToAge; age++) {
    rowsHtml.push(`<tr><td class="bt-age">${age}</td>${cellsHtml}</tr>`)
  }

  const wrap = document.createElement("div")
  wrap.className = "bridge-table"
  wrap.innerHTML = `<div class="bridge-table-wrap">
    <table class="bridge-table-el">
      <thead><tr><th class="bt-age">Age</th>${headHtml}</tr></thead>
      <tbody>${rowsHtml.join("")}</tbody>
    </table>
  </div>`
  return wrap
}

// localStorage, not the plan itself -- purely a same-browser hint so the very FIRST paint of a
// fresh page load (before STATE has round-tripped through Actual's own API, ~3.7s in practice) can
// still show a real skeleton instead of the bare LOADING_MARKUP fallback, on the extremely common
// path where "retirement" is the remembered active section (see render()'s own doc comment) and so
// the check fires before that fetch could possibly have landed. Reconciled the instant STATE does
// load (render() re-runs renderLoadingSkeleton while the check is still pending), so a stale cache
// (an age that ticked over, a retirement age added since) is never shown for more than a moment.
const SKELETON_CACHE_KEY = "runway.retirementSkeleton.v1"

function skeletonInputsFrom(state) {
  if (state.currentAge == null) return null
  const portfolioAccounts = state.accounts.filter((account) => account.isPortfolio)
  return {
    currentAge: state.currentAge,
    planToAge: state.dashboard.planToAge,
    retirementAges: state.dashboard.retirementAges,
    inflationMean: state.dashboard.monteCarloInflationMean ?? DEFAULT_MONTE_CARLO_INFLATION_MEAN,
    simulationCount: state.dashboard.monteCarloSimulationCount ?? DEFAULT_MONTE_CARLO_SIMULATION_COUNT,
    portfolioTotal: portfolioAccounts.reduce((total, account) => total + account.balance, 0),
    // A real guess (does any portfolio account still have a locked accessAge?), not a placeholder
    // -- real accounts, real ages, just not run through the actual Bridge simulation yet.
    hasLockedAccounts: portfolioAccounts.some((account) => account.accessAge != null && account.accessAge > state.currentAge),
    // id/name only (not the full account record) -- just enough for renderBridgeTableSkeleton's
    // own column headers when the Bridge table view is active; real tax-treatment/access-age
    // aren't known this early (that's still simulateBridge's own job), so those headers skip the
    // chip a real BridgeResult-backed column would carry.
    portfolioAccounts: portfolioAccounts.map((account) => ({ id: account.id, name: account.name })),
  }
}

function saveSkeletonCache(state) {
  const inputs = skeletonInputsFrom(state)
  if (!inputs) return
  try {
    localStorage.setItem(SKELETON_CACHE_KEY, JSON.stringify(inputs))
  } catch {
    // Storage disabled/unavailable -- the skeleton just falls back to the bare spinner next time.
  }
}

function loadSkeletonCache() {
  try {
    const raw = localStorage.getItem(SKELETON_CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Function to fill #checkResult with a per-chart loading skeleton (see renderChartSkeleton) --
// everything it draws (age axis, legend, group-label text) is real plan config, not a placeholder
// standing in for it, from STATE when it's already loaded or otherwise the same browser's own
// cached copy of it (see SKELETON_CACHE_KEY above). Falls back to the plain LOADING_MARKUP only
// when neither is available, i.e. a genuinely first-ever visit.
function renderLoadingSkeleton() {
  const container = document.getElementById("checkResult")
  const inputs = (STATE && skeletonInputsFrom(STATE)) ?? loadSkeletonCache()
  if (!inputs) {
    container.innerHTML = LOADING_MARKUP
    return
  }
  container.innerHTML = ""
  const { currentAge, planToAge, retirementAges, inflationMean, simulationCount, portfolioTotal, hasLockedAccounts, portfolioAccounts } = inputs
  // Same style-key markup renderBridgeChart/renderMonteCarloChart themselves emit -- see
  // renderChartSkeleton's own doc comment on why Bridge's is conditional and Monte Carlo's isn't.
  const bridgeStyleKey = hasLockedAccounts
    ? `<div class="bridge-style-key"><span class="bridge-style-key-item"><span class="bridge-key-line bridge-key-solid"></span>Accessible</span><span class="bridge-style-key-item"><span class="bridge-key-line bridge-key-dashed"></span>Locked</span></div>`
    : ""
  const monteCarloStyleKey = `<div class="bridge-style-key"><span class="bridge-style-key-item"><span class="mc-key-swatch mc-key-outer"></span>10th-90th</span><span class="bridge-style-key-item"><span class="mc-key-swatch mc-key-inner"></span>25th-75th</span><span class="bridge-style-key-item"><span class="bridge-key-line"></span>Median</span></div>`

  // One placeholder finding row per retirement age -- both bridgeFindings and monteCarloFindings
  // always come back one per configured age (see checkDashboard), so this is a real count, not a
  // guess, reserving the space the real prose findings are about to fill so the chart itself
  // doesn't visibly shift up once they land. detailLines is a real asymmetry between the two, not
  // an arbitrary choice: monteCarloFinding (fire-analysis.ts) only ever prints its own one-line
  // "median ending balance" alone when the plan's success rate is a clean 100%, and otherwise adds
  // a second "depleted runs typically ran out..." line -- the common case, since very few plans
  // clear literally every simulated run. bridgeFinding is the mirror image: one line for its own
  // "funds every year" pass, two for either failure case.
  const findingSkeleton = (detailLines) =>
    `<div class="finding">
        <span class="chip skeleton-chip">&nbsp;</span>
        <div>
          <div class="title"><span class="skeleton-bar" style="width:70%"></span></div>
          ${Array.from({ length: detailLines }, () => `<div class="detail"><span class="skeleton-bar" style="width:45%"></span></div>`).join("")}
        </div>
      </div>`

  const bridgeGroup = document.createElement("div")
  bridgeGroup.className = "findings-group"
  bridgeGroup.innerHTML = `<div class="group-label">Bridge · mean returns, ${Math.round(inflationMean * 1000) / 10}% inflation</div>`
  bridgeGroup.appendChild(
    isBridgeTableView()
      ? renderBridgeTableSkeleton(currentAge, planToAge, portfolioAccounts ?? []) // ?? [] guards a stale pre-portfolioAccounts SKELETON_CACHE_KEY entry from an older version of this page
      : renderChartSkeleton("Bridge burndown", currentAge, planToAge, retirementAges, portfolioTotal, bridgeStyleKey),
  )
  bridgeGroup.insertAdjacentHTML("beforeend", retirementAges.map(() => findingSkeleton(1)).join(""))
  container.appendChild(bridgeGroup)

  const monteCarloGroup = document.createElement("div")
  monteCarloGroup.className = "findings-group"
  monteCarloGroup.innerHTML = `<div class="group-label">Monte Carlo · ${simulationCount.toLocaleString()} simulated runs</div>`
  monteCarloGroup.appendChild(renderChartSkeleton("Monte Carlo simulation", currentAge, planToAge, retirementAges, portfolioTotal, monteCarloStyleKey))
  monteCarloGroup.insertAdjacentHTML("beforeend", retirementAges.map(() => findingSkeleton(2)).join(""))
  container.appendChild(monteCarloGroup)
}

// Guards against two overlapping runCheck() calls landing out of order -- a real risk now that a
// plain field edit can trigger one (see scheduleRecheck) on top of the manual Refresh button and
// the once-per-landing call on first opening the page. Only the response to the most recently
// started call is ever applied; an older one that happens to resolve later is dropped instead of
// briefly showing stale numbers over fresh ones.
let checkRequestId = 0

// The Portfolio/mortgage-and-other tiles and Stale both come from this same call, same as
// Analysis below -- true only once the very first runCheck() has settled (succeeded or failed),
// so revealTopSectionIfReady knows to stop showing #topLoading in their place. Never reset back to
// false afterward: a field edit's own re-check (scheduleRecheck) updates the tiles/Stale in place,
// it doesn't re-hide them behind the loading box the way Analysis re-shows its own spinner.
let firstCheckDone = false

// Function to swap #topLoading for the real Portfolio/mortgage tiles (and let Stale show or stay
// hidden on its own real terms) the moment both halves of "what belongs up top" are actually
// known: STATE (Portfolio's own data) and the first check (everything else up there). Called from
// both render() and runCheck() since neither alone knows when the other one lands.
function revealTopSectionIfReady() {
  if (!STATE || !firstCheckDone) return
  document.getElementById("topLoading").hidden = true
  document.getElementById("summaryTiles").hidden = false
}

// The most recent successful /api/retirement/check response -- kept around so toggling privacy
// mode can redraw the charts (see renderCheckResult) from data already in hand instead of firing a
// fresh API call, since chart SVG text is mask-swapped at render time (see moneyMaskText) rather
// than CSS-blurred, so it needs an actual re-render to pick up the new privacy state.
let lastCheckResult = null

function renderCheckResult(result) {
  const container = document.getElementById("checkResult")
  container.innerHTML = ""
  if (result.bridgeFindings.length === 0 && result.monteCarloFindings.length === 0) {
    container.innerHTML = `<div class="empty-note">No findings.</div>`
    return
  }
  if (result.bridgeFindings.length > 0) {
    const group = document.createElement("div")
    group.className = "findings-group"
    group.innerHTML = `<div class="group-label">Bridge · mean returns, ${Math.round(result.inflationMean * 1000) / 10}% inflation</div>`
    const chart = isBridgeTableView()
      ? renderBridgeTable(result.bridgeResults, result.currentAge, result.planToAge)
      : renderBridgeChart(result.bridgeResults, result.currentAge, result.planToAge, result.ruleOf55Boosts, result.debtPayoffs, result.incomeStreams, result.acaCliffCrossings, result.expenseAdjustments)
    if (chart) group.appendChild(chart)
    result.bridgeFindings.forEach((f) => group.appendChild(renderFinding(f)))
    container.appendChild(group)
  }
  if (result.monteCarloFindings.length > 0) {
    const group = document.createElement("div")
    group.className = "findings-group"
    const simCount = result.monteCarloResults[0]?.simulationCount
    group.innerHTML = `<div class="group-label">Monte Carlo${simCount ? ` · ${simCount.toLocaleString()} simulated runs` : ""}</div>`
    const chart = renderMonteCarloChart(result.monteCarloResults, result.currentAge, result.monteCarloHistory)
    if (chart) group.appendChild(chart)
    result.monteCarloFindings.forEach((f) => group.appendChild(renderFinding(f)))
    container.appendChild(group)
  }
}

async function runCheck() {
  const requestId = ++checkRequestId
  const container = document.getElementById("checkResult")
  renderLoadingSkeleton()
  try {
    const result = await api("/api/retirement/check")
    if (requestId !== checkRequestId) return
    renderSummaryStats(result)
    firstCheckDone = true
    revealTopSectionIfReady()
    lastCheckResult = result
    renderCheckResult(result)
  } catch (error) {
    if (requestId !== checkRequestId) return
    firstCheckDone = true
    revealTopSectionIfReady()
    container.innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
    showError(error.message, () => runCheck())
  }
}

// Function to schedule a re-check a beat after the most recent edit, rather than one right after
// every single field -- an account's fields (or several plan fields in a row) tend to change in a
// quick burst, and re-hitting /api/retirement/check after each keystroke's own change event would
// both spam the endpoint and flash the summary tiles/Stale/Analysis through several intermediate
// states before landing on the final one. Only patchPlan/patchAccount/reorderAccounts call this,
// each after its own STATE update already succeeded -- not on a failed save.
let recheckTimer = null
function scheduleRecheck() {
  if (recheckTimer) clearTimeout(recheckTimer)
  recheckTimer = setTimeout(() => {
    recheckTimer = null
    runCheck()
  }, 500)
}

document.getElementById("birthDate").addEventListener("change", (e) => runExclusive(() => patchPlan({ birthDate: e.target.value || null }, "savedBirth")))
document.getElementById("retireAges").addEventListener("change", (e) => {
  try {
    const ages = parseRetirementAges(e.target.value)
    runExclusive(() => patchPlan({ retirementAges: ages }, "savedRetire"))
  } catch (error) {
    showError(error.message)
  }
})
document.getElementById("planToAge").addEventListener("change", (e) => runExclusive(() => patchPlan({ planToAge: parseFloat(e.target.value) }, "savedPlan")))
document.getElementById("filingStatus").addEventListener("change", (e) => runExclusive(() => patchPlan({ filingStatus: e.target.value === "" ? null : e.target.value }, "savedFilingStatus")))

document.getElementById("householdSize").addEventListener("change", (e) => {
  const size = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ householdSize: size === null || size <= 0 ? null : size }, "savedHouseholdSize"))
})

document.getElementById("acaTargetPctFpl").addEventListener("change", (e) => {
  const pct = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ acaTargetPctFpl: pct === null || pct <= 0 ? null : pct }, "savedAcaTargetPctFpl"))
})

document.getElementById("medicareAge").addEventListener("change", (e) => {
  const age = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ medicareAge: age === null || age <= 0 ? null : age }, "savedMedicareAge"))
})

// A <select> of exactly "", "100", "138" -- not a free-form number the way acaTargetPctFpl's own
// field is, since those are this policy's only two real values (see the field's own help text).
document.getElementById("acaFloorPctFpl").addEventListener("change", (e) => {
  const pct = e.target.value === "" ? null : parseInt(e.target.value, 10)
  runExclusive(() => patchPlan({ acaFloorPctFpl: pct }, "savedAcaFloorPctFpl"))
})

document.getElementById("pensionStartAge").addEventListener("change", (e) => {
  const age = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ pensionStartAge: age === null || age <= 0 ? null : age }, "savedIncome"))
})
const pensionAmountInput = document.getElementById("pensionMonthlyAmount")
attachMoneyFormatting(pensionAmountInput)
pensionAmountInput.addEventListener("moneycommit", (e) => {
  runExclusive(() => patchPlan({ pensionMonthlyAmount: parseMoneyInputCents(e.target.value) }, "savedIncome"))
})
;[
  ["ss62", "socialSecurityMonthlyAt62"],
  ["ss67", "socialSecurityMonthlyAt67"],
  ["ss70", "socialSecurityMonthlyAt70"],
].forEach(([id, field]) => {
  const input = document.getElementById(id)
  attachMoneyFormatting(input)
  input.addEventListener("moneycommit", (e) => {
    runExclusive(() => patchPlan({ [field]: parseMoneyInputCents(e.target.value) }, "savedIncome"))
  })
})
document.getElementById("ssClaimAge").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ socialSecurityClaimingAge: e.target.value === "" ? null : parseInt(e.target.value, 10) }, "savedIncome"))
})

// Wired once, not per-render, since the container element itself is never recreated -- only its
// children are (renderAccounts clears/rebuilds accountsList.innerHTML on every render).
document.getElementById("accountsList").addEventListener("dragover", (e) => {
  if (!draggingAccountRow) return
  e.preventDefault()
  const list = e.currentTarget
  const afterElement = dragAfterElement(list, e.clientY)
  if (afterElement == null) {
    list.appendChild(draggingAccountRow)
  } else if (afterElement !== draggingAccountRow) {
    list.insertBefore(draggingAccountRow, afterElement)
  }
})

document.getElementById("mcWithdrawalStrategy").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloWithdrawalStrategy: e.target.value === "" ? null : e.target.value }, "savedSimSettings"))
})
document.getElementById("mcReturnModel").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloReturnModel: e.target.value === "" ? null : e.target.value }, "savedSimSettings"))
})
document.getElementById("mcTaxModel").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloTaxModel: e.target.value === "" ? null : e.target.value }, "savedSimSettings"))
})
document.getElementById("mcInflationMean").addEventListener("change", (e) => {
  const pct = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ monteCarloInflationMean: pct === null ? null : pct / 100 }, "savedSimSettings"))
})
document.getElementById("mcInflationStdDev").addEventListener("change", (e) => {
  const pct = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ monteCarloInflationStdDev: pct === null ? null : pct / 100 }, "savedSimSettings"))
})
const mcMinWithdrawalInput = document.getElementById("mcMinimumWithdrawal")
attachMoneyFormatting(mcMinWithdrawalInput)
mcMinWithdrawalInput.addEventListener("moneycommit", (e) => {
  runExclusive(() => patchPlan({ monteCarloMinimumWithdrawal: parseMoneyInputCents(e.target.value) }, "savedSimSettings"))
})
document.getElementById("mcSimulationCount").addEventListener("change", (e) => {
  const count = e.target.value === "" ? null : parseInt(e.target.value, 10)
  runExclusive(() => patchPlan({ monteCarloSimulationCount: count === null || count <= 0 ? null : count }, "savedSimSettings"))
})
document.getElementById("crossoverExpenseAdjustment").addEventListener("change", (e) => {
  const pct = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ crossoverExpenseAdjustmentFactor: pct === null ? null : pct / 100 }, "savedSpendConfig"))
})
document.getElementById("crossoverSpendHistoryMonths").addEventListener("change", (e) => {
  const months = e.target.value === "" ? null : parseInt(e.target.value, 10)
  runExclusive(() => patchPlan({ crossoverSpendHistoryMonths: months === null || months <= 0 ? null : months }, "savedSpendConfig"))
})
document.getElementById("expenseCategoriesExpandAll").addEventListener("click", () => {
  if (!EXPENSE_CATEGORY_GROUPS) return
  EXPENSE_CATEGORY_GROUPS.forEach((group) => EXPENSE_CATEGORY_FOLDS.delete(group.id))
  saveExpenseCategoryFolds()
  renderExpenseCategoryPicker()
})
document.getElementById("expenseCategoriesCollapseAll").addEventListener("click", () => {
  if (!EXPENSE_CATEGORY_GROUPS) return
  EXPENSE_CATEGORY_GROUPS.forEach((group) => EXPENSE_CATEGORY_FOLDS.add(group.id))
  saveExpenseCategoryFolds()
  renderExpenseCategoryPicker()
})
document.getElementById("accountsExpandAll").addEventListener("click", () => {
  if (!STATE) return
  STATE.accounts.forEach((account) => ACCOUNT_FOLDS.delete(account.id))
  saveAccountFolds()
  renderAccounts()
})
document.getElementById("accountsCollapseAll").addEventListener("click", () => {
  if (!STATE) return
  STATE.accounts.forEach((account) => ACCOUNT_FOLDS.add(account.id))
  saveAccountFolds()
  renderAccounts()
})
document.getElementById("expenseCategoriesShowHidden").addEventListener("change", (e) => {
  EXPENSE_CATEGORY_VIEW.showHidden = e.target.checked
  saveExpenseCategoryView()
  renderExpenseCategoryPicker()
})
document.getElementById("expenseCategoriesHideUnchecked").addEventListener("change", (e) => {
  EXPENSE_CATEGORY_VIEW.hideUnchecked = e.target.checked
  saveExpenseCategoryView()
  renderExpenseCategoryPicker()
})
// Restores the two checkboxes above to match EXPENSE_CATEGORY_VIEW's own restored-from-cookie
// state -- the view object is read from the cookie at load (see its own declaration), but these
// static checkbox elements need their own .checked set to match, same as applyPrivacyMode does for
// the privacy toggle.
document.getElementById("expenseCategoriesShowHidden").checked = EXPENSE_CATEGORY_VIEW.showHidden
document.getElementById("expenseCategoriesHideUnchecked").checked = EXPENSE_CATEGORY_VIEW.hideUnchecked
document.getElementById("mcWithdrawalRuleType").addEventListener("change", (e) => {
  const type = e.target.value
  if (type === "") {
    runExclusive(() => patchPlan({ monteCarloWithdrawalRule: null }, "savedSimSettings"))
    return
  }
  const current = STATE.dashboard.monteCarloWithdrawalRule ?? {}
  runExclusive(() => patchPlan({ monteCarloWithdrawalRule: { ...current, type } }, "savedSimSettings"))
})
WR_FIELD_DEFS.forEach(({ key, inputId, pct }) => {
  document.getElementById(inputId).addEventListener("change", (e) => {
    const current = STATE.dashboard.monteCarloWithdrawalRule
    if (!current) return // the block is hidden until a rule type is chosen, so this shouldn't fire
    const next = { ...current }
    if (e.target.value === "") {
      delete next[key]
    } else {
      const num = parseFloat(e.target.value)
      next[key] = pct ? num / 100 : num
    }
    runExclusive(() => patchPlan({ monteCarloWithdrawalRule: next }, "savedSimSettings"))
  })
})
document.getElementById("addTaxBandBtn").addEventListener("click", () => {
  const next = [...(STATE.dashboard.monteCarloTaxBands ?? []), { id: nextTaxBandId() }]
  runExclusive(() => patchPlan({ monteCarloTaxBands: next }, "savedSimSettings"))
})
document.getElementById("addExpenseAdjustmentBtn").addEventListener("click", () => {
  // A real (if generic) starting point, not a blank/zero row -- every field already has a valid
  // value, so it shows up on the chart/table immediately rather than needing to be filled in
  // before it does anything. currentAge falls back to 30 on the rare chance birth date isn't set
  // yet (STATE.currentAge is null then) -- an arbitrary but harmless placeholder the user will
  // overwrite long before this ever reaches a real check anyway (no birth date means no check can
  // run at all yet).
  const startAge = (STATE.currentAge ?? 30) + 1
  const next = [...STATE.dashboard.expenseAdjustments, { id: nextExpenseAdjustmentId(), name: "New expense", annualAmount: 0, startAge, endAge: null, inflate: true }]
  runExclusive(() => patchPlan({ expenseAdjustments: next }, "savedExpenseAdjustments"))
})
document.getElementById("refreshBtn").addEventListener("click", refreshAll)

// --- Chart zoom ---
//
// Reparents each chart AND its own finding rows into the modal at once (not a clone/re-render, and
// not just whichever one was clicked), so the chart's tooltip/hover wiring -- set up once at render
// time in wireBridgeTooltip/wireMonteCarloTooltip -- keeps working unchanged; that wiring's own
// coordinate math already normalizes by the SVG's rendered getBoundingClientRect() width rather
// than assuming its in-page size, so both charts draw larger in the modal for free, no separate
// "zoomed" rendering path needed. Triggered by a click anywhere on either chart (see addChartZoom),
// not just its own zoom button.
//
// Side by side rather than stacked (the chart's own inline spot always stacks findings below it) --
// the modal has width to spare that the inline column never does, so spending it here means the
// chart's own line legend (inside the chart node itself) never has to compete with the findings for
// the SAME vertical space the way it does inline. The findings column scrolls on its own
// (chart-zoom-findings-col, see style.css) rather than growing the modal past its own max-height --
// a narrow scrollbar in a column with width to spare reads very differently than one squeezed into
// the inline sidebar's own tight column, which is why that fix stops here instead.
let zoomedNodes = [] // [{ node, home: { parent, nextSibling } }] -- where each goes back on close
function openChartZoom() {
  if (zoomedNodes.length > 0) return // already open
  // Each chart's own group-label ("Bridge · mean returns, 3% inflation") lives on a sibling in
  // #checkResult, not inside the chart wrap itself -- cloned as plain text into the modal (rather
  // than reparenting the real label) so the underlying page's own copy is untouched and doesn't
  // need restoring on close.
  const groups = [...document.querySelectorAll("#checkResult .findings-group")]
    .map((group) => ({
      // .bridge-table too -- the Bridge group's own view toggle (see applyBridgeTableView) can
      // swap what's actually live here for a table instead of the chart; whichever it currently
      // is gets reparented into the modal the same way.
      chart: group.querySelector(".bridge-chart, .bridge-table"),
      findings: [...group.querySelectorAll(".finding")],
      label: group.querySelector(".group-label")?.textContent ?? "",
    }))
    .filter((entry) => entry.chart)
  if (groups.length === 0) return
  zoomedNodes = groups.flatMap(({ chart, findings }) =>
    [chart, ...findings].map((node) => ({ node, home: { parent: node.parentNode, nextSibling: node.nextSibling } })),
  )
  const body = document.getElementById("chartZoomBody")
  body.innerHTML = ""
  groups.forEach(({ chart, findings, label }) => {
    const section = document.createElement("div")
    section.className = "chart-zoom-section"
    if (label) {
      const heading = document.createElement("div")
      heading.className = "group-label"
      heading.textContent = label
      section.appendChild(heading)
    }
    const columns = document.createElement("div")
    columns.className = "chart-zoom-columns"
    const chartCol = document.createElement("div")
    chartCol.className = "chart-zoom-chart-col"
    chartCol.appendChild(chart)
    columns.appendChild(chartCol)
    if (findings.length > 0) {
      const findingsCol = document.createElement("div")
      findingsCol.className = "chart-zoom-findings-col"
      findings.forEach((finding) => findingsCol.appendChild(finding))
      columns.appendChild(findingsCol)
    }
    section.appendChild(columns)
    body.appendChild(section)
  })
  const backdrop = document.getElementById("chartZoomBackdrop")
  backdrop.hidden = false
  // Read a layout property first to force the browser to commit `hidden: false` before the class
  // that starts the transition is added -- without it, both changes can land in the same paint and
  // the modal would just appear instantly instead of animating in.
  void backdrop.offsetHeight
  backdrop.classList.add("open")
}
function closeChartZoom() {
  if (zoomedNodes.length === 0) return
  const backdrop = document.getElementById("chartZoomBackdrop")
  const restore = () => {
    // Reverse order: within a group, a node's own recorded nextSibling is often another node
    // that ALSO got moved (the chart's original next sibling is its group's first finding, that
    // finding's is the next one, and so on) -- restoring last-recorded-first guarantees each
    // nextSibling reference is already back in its parent by the time something needs to
    // insertBefore it, instead of pointing at a node still sitting detached in the modal.
    ;[...zoomedNodes].reverse().forEach(({ node, home }) => home.parent.insertBefore(node, home.nextSibling))
    zoomedNodes = []
    document.getElementById("chartZoomBody").innerHTML = ""
    backdrop.hidden = true
  }
  backdrop.classList.remove("open")
  if (prefersReducedMotion()) {
    restore()
    return
  }
  // Charts must stay in the (still-visible-but-fading-out) modal until the close transition
  // actually finishes -- restoring them immediately would visibly snap the modal's own content
  // back to the page mid-fade instead of the whole panel fading out as one piece.
  backdrop.addEventListener("transitionend", function onEnd(e) {
    if (e.target !== backdrop) return
    backdrop.removeEventListener("transitionend", onEnd)
    restore()
  })
}
document.getElementById("chartZoomClose").addEventListener("click", closeChartZoom)
document.getElementById("chartZoomBackdrop").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeChartZoom()
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("chartZoomBackdrop").hidden) closeChartZoom()
})

document.getElementById("chartZoomOpenBtn").addEventListener("click", () => openChartZoom())

// Issue #28: "you're eligible for an early-access option you haven't set, and it would help"
// suggestions (Rule of 55 / SEPP) -- see fire-suggestions.ts's own doc comment for the mechanics
// behind /api/retirement/suggestions. Fetched fresh on every open, not folded into lastCheckResult
// -- the what-if checks behind that endpoint are several extra checkDashboard calls each, not worth
// paying for on every plain recheck (see #suggestionsOpenBtn's own doc comment in index.html).
let suggestionsResult = null
function openSuggestions() {
  const backdrop = document.getElementById("suggestionsBackdrop")
  const applyBtn = document.getElementById("suggestionsApplyBtn")
  applyBtn.disabled = true
  document.getElementById("suggestionsBody").innerHTML = `<div class="panel-loading"><div class="spinner" aria-hidden="true"></div>Loading…</div>`
  backdrop.hidden = false
  void backdrop.offsetHeight
  backdrop.classList.add("open")
  api("/api/retirement/suggestions")
    .then((result) => {
      if (backdrop.hidden) return // closed before this resolved
      suggestionsResult = result
      renderSuggestions(result)
    })
    .catch((error) => {
      if (backdrop.hidden) return
      document.getElementById("suggestionsBody").innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
    })
}
function closeSuggestions() {
  const backdrop = document.getElementById("suggestionsBackdrop")
  if (backdrop.hidden) return
  const restore = () => {
    backdrop.hidden = true
    document.getElementById("suggestionsBody").innerHTML = ""
    suggestionsResult = null
  }
  backdrop.classList.remove("open")
  if (prefersReducedMotion()) {
    restore()
    return
  }
  backdrop.addEventListener("transitionend", function onEnd(e) {
    if (e.target !== backdrop) return
    backdrop.removeEventListener("transitionend", onEnd)
    restore()
  })
}

// Rule of 55 is a plain checkbox (independent per account, and independent of that SAME account's
// own SEPP suggestion below -- the two aren't mutually exclusive, see effectiveAccessAge's own doc
// comment in fire-dashboard.ts). A SEPP suggestion's own method choice IS mutually exclusive (one
// account can only actually elect one method), so that's the one native <input type="radio"> group
// this feature needs -- issue #28's own "don't allow selecting both" rule, satisfied by plain radio
// semantics rather than extra JS bookkeeping. Neither radio is pre-selected, so "apply nothing for
// this account's SEPP option" is simply leaving both unchosen.
function renderSuggestions(result) {
  const body = document.getElementById("suggestionsBody")
  const applyBtn = document.getElementById("suggestionsApplyBtn")
  body.innerHTML = ""
  if (result.suggestions.length === 0) {
    body.innerHTML = `<div class="empty-note">No early-access option would improve this plan's outcome right now.</div>`
    applyBtn.disabled = true
    return
  }
  // targetRetirementAge is the lowest CONFIGURED retirement age being explored, not a committed
  // decision about any one account -- the same "hypothetical/modeling input" bucket the Plan
  // section's own retirement-ages field is already in, not a real personal-timeline fact (unlike
  // the separation/SEPP-start age an applied suggestion goes on to set on a specific account), so
  // it's shown here in the clear, same as elsewhere on this page.
  const intro = document.createElement("p")
  intro.textContent = `Targeting the lowest configured retirement age (${result.targetRetirementAge}) -- each option below would unlock money earlier and improve this plan's projected outcome.`
  body.appendChild(intro)
  result.suggestions.forEach((s) => {
    const card = document.createElement("div")
    card.className = "suggestion-card"
    if (s.kind === "rule-of-55") {
      card.innerHTML = `
        <label class="suggestion-option">
          <input type="checkbox" class="suggestion-input" data-kind="rule-of-55" data-account-id="${escapeHtml(s.accountId)}">
          Elect Rule of 55 for <strong>${escapeHtml(s.accountName)}</strong>
        </label>
        <ul class="suggestion-pros-cons">
          <li>Unlocks this account at separation from that employer, with no 10% early-withdrawal penalty.</li>
          <li>Only applies to this specific employer plan -- doesn't carry over to an IRA or a different employer's plan.</li>
        </ul>`
    } else {
      const options = s.methodOptions
        .map(
          (opt) => `
        <label class="suggestion-option">
          <input type="radio" class="suggestion-input" name="sepp-${escapeHtml(s.accountId)}" data-kind="sepp" data-account-id="${escapeHtml(s.accountId)}" data-method="${opt.method}">
          ${opt.method === "rmd" ? "RMD method" : "Amortization method"}${opt.annualAmount != null ? ` -- ${moneySpan(opt.annualAmount)}/yr` : ""}
        </label>`,
        )
        .join("")
      card.innerHTML = `
        <div class="suggestion-card-title">Elect a 72(t) SEPP schedule for <strong>${escapeHtml(s.accountName)}</strong></div>
        <div class="suggestion-radio-group">${options}</div>
        <ul class="suggestion-pros-cons">
          <li>Available for IRAs and other tax-deferred accounts -- no employer separation needed.</li>
          <li>A binding schedule once started: fixed for 5 years or until age 59½, whichever is later.</li>
          <li>RMD recalculates (and moves with the market) every year; Amortization is level for the life of the schedule.</li>
        </ul>`
    }
    body.appendChild(card)
  })
  applyBtn.disabled = false
}

// Function to PATCH every checked/selected option's own account, sequentially -- patchAccount
// already re-renders STATE and schedules a recheck after each of its own PATCHes, so this just
// calls it once per selection instead of reimplementing that. Sequential (not Promise.all) since a
// Rule of 55 checkbox and a SEPP radio can both target the SAME account at once -- PATCH already
// merges partial updates account-side, so this only needs to not race two concurrent PATCHes to the
// same account against each other.
async function applySuggestions() {
  const inputs = [...document.querySelectorAll("#suggestionsBody .suggestion-input:checked")]
  for (const input of inputs) {
    const accountId = input.dataset.accountId
    if (input.dataset.kind === "rule-of-55") {
      await patchAccount(accountId, { ruleOf55SeparationAge: suggestionsResult.targetRetirementAge })
    } else {
      await patchAccount(accountId, { seppMethod: input.dataset.method, seppStartAge: suggestionsResult.targetRetirementAge })
    }
  }
  closeSuggestions()
}

document.getElementById("suggestionsOpenBtn").addEventListener("click", () => openSuggestions())
document.getElementById("suggestionsClose").addEventListener("click", closeSuggestions)
document.getElementById("suggestionsBackdrop").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeSuggestions()
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("suggestionsBackdrop").hidden) closeSuggestions()
})
document.getElementById("suggestionsApplyBtn").addEventListener("click", () => runExclusive(applySuggestions))

// Function to make a freshly rendered chart clickable-anywhere-to-zoom -- shared by
// renderBridgeChart/renderMonteCarloChart, since both return the same .bridge-chart wrapper shape.
// The zoom entry point itself is the one pinned button in the Analysis card-head
// (#chartZoomOpenBtn) rather than a button on each chart -- this just makes the chart's own body a
// second way in. Mutates and returns the same `wrap` so a caller can chain it straight into
// `return`.
function addChartZoom(wrap) {
  wrap.classList.add("chart-zoomable")
  wrap.addEventListener("click", () => openChartZoom())
  return wrap
}

// --- Help popovers (the "?" beside a field label) ---
//
// One shared element (like .bt-menu's own single-shared-dropdown pattern) repositioned against
// whichever icon was last clicked, rather than one popover per icon. Click-triggered, not hover,
// so the text stays up while you read it and works on touch devices where hover doesn't exist at
// all -- see each field's own data-help attribute in index.html for the actual copy (adapted from
// Actual's own crossover config UI tooltips).
function closeHelpPopover() {
  const popover = document.getElementById("helpPopover")
  popover.hidden = true
  const active = document.querySelector(".help-icon.active")
  if (active) active.classList.remove("active")
}
function openHelpPopover(icon) {
  const popover = document.getElementById("helpPopover")
  popover.innerHTML = icon.dataset.help
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")
  icon.classList.add("active")
  popover.hidden = false
  const iconRect = icon.getBoundingClientRect()
  const popoverRect = popover.getBoundingClientRect()
  const left = Math.max(8, Math.min(iconRect.left, window.innerWidth - popoverRect.width - 8))
  const top = iconRect.bottom + 6 + popoverRect.height > window.innerHeight ? iconRect.top - popoverRect.height - 6 : iconRect.bottom + 6
  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
}
document.addEventListener("click", (e) => {
  const icon = e.target.closest(".help-icon")
  if (!icon) {
    if (!e.target.closest("#helpPopover")) closeHelpPopover()
    return
  }
  const reopening = !icon.classList.contains("active")
  closeHelpPopover()
  if (reopening) openHelpPopover(icon)
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("helpPopover").hidden) closeHelpPopover()
})

// --- Retirement page: foldable sections (was a Configure/Analyze tab bar) ---

// The foldable cards, in document order, each identified by its own data-section value. The
// summary tiles (see #summaryTiles in index.html) sit above these, always visible, not foldable --
// they're "what's true right now," not a setting someone would want to tuck away. Analysis (the
// other column) isn't in this list either, for the same reason -- it's the one thing on this page
// someone's actually looking at, not a setting to tuck away, so it has no fold toggle at all any
// more (just the always-visible zoom button, see #chartZoomOpenBtn). Simulation settings and
// Retirement income default collapsed (set once, rarely revisited); the rest default open.
// DEFAULT_COLLAPSED_SECTIONS is what a first-ever visit (no cookie yet) applies; after that,
// saveSectionFolds keeps the cookie authoritative for every reload.
const RETIREMENT_SECTIONS = ["plan", "spend-configuration", "simulation-settings", "retirement-income", "accounts"]
const DEFAULT_COLLAPSED_SECTIONS = ["simulation-settings", "retirement-income"]

// Function to fold or unfold one section -- shared by an individual card's own toggle and
// Expand/Collapse all, so both always leave the caret, aria state, and body in step. Folding a
// section only hides it; it never gates or re-triggers loading the data inside it (Analysis and the
// always-visible summary tiles/Stale above all come from the one /api/retirement/check call
// runCheck already makes on landing on this page, whether or not that particular card happens to be
// open).
function setSectionFolded(name, folded) {
  const card = document.querySelector(`[data-section="${name}"]`)
  if (!card) return
  const toggle = card.querySelector(".card-fold-toggle")
  toggle.setAttribute("aria-expanded", String(!folded))
  toggle.textContent = folded ? "▶" : "▼"
  card.querySelector(".card-fold").hidden = folded
}

// Function to persist exactly which sections are collapsed right now, the same per-browser-cookie
// mechanism activeSection/activeRetirementTab already used -- see getCookie/setCookie's own doc
// comment for why a cookie over e.g. localStorage.
function saveSectionFolds() {
  const collapsed = RETIREMENT_SECTIONS.filter((name) => document.querySelector(`[data-section="${name}"] .card-fold`)?.hidden)
  try {
    setCookie("retirementCollapsed", collapsed.join(","))
  } catch {
    // Cookies disabled -- folding still works for this page view, it just won't be remembered.
  }
}

// Function to restore fold state on load -- an absent cookie (first-ever visit) applies
// DEFAULT_COLLAPSED_SECTIONS; an empty saved cookie (everything was expanded) applies none, which
// getCookie's own "" vs null distinction makes possible without a separate sentinel.
function applySectionFolds() {
  let collapsed = DEFAULT_COLLAPSED_SECTIONS
  try {
    const saved = getCookie("retirementCollapsed")
    if (saved !== null) collapsed = saved === "" ? [] : saved.split(",")
  } catch {
    // Cookies disabled -- the hardcoded defaults above still apply for this page view.
  }
  RETIREMENT_SECTIONS.forEach((name) => setSectionFolded(name, collapsed.includes(name)))
}

document.querySelectorAll(".card-fold-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const card = toggle.closest("[data-section]")
    setSectionFolded(card.dataset.section, !card.querySelector(".card-fold").hidden)
    saveSectionFolds()
  })
})
document.getElementById("expandAllBtn").addEventListener("click", () => {
  RETIREMENT_SECTIONS.forEach((name) => setSectionFolded(name, false))
  saveSectionFolds()
})
document.getElementById("collapseAllBtn").addEventListener("click", () => {
  RETIREMENT_SECTIONS.forEach((name) => setSectionFolded(name, true))
  saveSectionFolds()
})

// --- Section switching (the sidebar's Budget/Retirement nav) ---

// Function to switch the visible top-level section -- shared by the click handler below and the
// on-load restoration a bit further down, so clicking a nav item and reloading the page onto a
// previously-chosen section behave identically (including lazily loading Budget's own data either
// way, not just on a real click).
function activateSection(name) {
  // Budget is disabled entirely in file-import mode (issue #35) -- fall back to Retirement rather
  // than land on a section whose data source can't answer its own richer category/transaction
  // needs (see the "companion app north star" comment in app-server.ts: file mode only ever
  // implements Retirement's narrower AccountDataSource surface).
  if (name === "budget" && document.querySelector('.section-item[data-section="budget"]').classList.contains("disabled")) {
    name = "retirement"
  }
  document.querySelectorAll(".section-item[data-section]").forEach((i) => i.classList.toggle("active", i.dataset.section === name))
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name))
  if (name === "budget") {
    if (!PICKER.table) loadPickerTable()
  }
  // Mirrors the budget branch above: only fires when Retirement is actually the section being
  // landed on, never unconditionally at boot (which would cost a real network call on every load
  // regardless of which section a person actually opens). No tab to gate on any more -- Current
  // numbers/Stale sit above the fold entirely, and Analysis is just a card on this page now, folded
  // or not.
  if (name === "retirement" && !retirementChecked) {
    retirementChecked = true
    runCheck()
  }
}
// Set the moment runCheck is actually called for the page's own boot-time landing, not on every
// later re-entry into the Retirement section within the same page view -- Refresh (or a real edit
// that re-runs it) covers those; activateSection itself must not re-fetch just because someone
// clicked away to Budget and back.
let retirementChecked = false

document.querySelectorAll(".section-item[data-section]").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.classList.contains("disabled")) return
    activateSection(item.dataset.section)
    try {
      setCookie("activeSection", item.dataset.section)
    } catch {
      // Cookies disabled -- the switch still works for this page view, it just won't be remembered.
    }
  })
})


// --- Budget section ---

// Honoured by the roll itself rather than by a CSS override, since the movement is a scripted
// scroll: someone who asked for less motion gets the new months outright, with no journey.
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function currentMonthValue() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

// The one action that reads rather than writes. It shares the picker with the set-values actions
// -- same months, same categories -- but not their Preview/Apply pair: there is nothing to preview
// when nothing is going to be written.
const ANOMALIES_ACTION = "anomalies"

function selectedAction() {
  return document.getElementById("budgetAction").value
}

// Function to point the card at whichever action is selected: the amount box that only a custom
// amount needs, and which buttons are on offer. Results are dropped on the way through -- they
// describe a run of the action that was selected when they were produced, so leaving them up beside
// a different action would misattribute them.
function applySelectedAction() {
  const action = selectedAction()
  const findingAnomalies = action === ANOMALIES_ACTION
  // Disabled in place rather than hidden: taking the field out of the flow moved every button
  // beside it, so the row was laid out differently for one action than for the other six.
  document.getElementById("budgetCustomAmount").disabled = action !== "custom"
  document.getElementById("previewSetValuesBtn").hidden = findingAnomalies
  document.getElementById("applySetValuesBtn").hidden = findingAnomalies
  document.getElementById("findAnomaliesBtn").hidden = !findingAnomalies
  // Shown for the whole of the anomalies action, not just once something is flagged -- it is
  // clearActionOverlays below that leaves it disabled until a run gives it something to tag.
  document.getElementById("tagAnomaliesBtn").hidden = !findingAnomalies
  clearActionOverlays()
  if (PICKER.table) renderPickerTable(PICKER.table)
  updatePickerButtons()
}

document.getElementById("budgetAction").addEventListener("change", applySelectedAction)

// Every Budget action -- setting values, finding anomalies -- runs over the same months and the
// same categories, so there is one picker: a month strip scrolling the visible window (see
// renderMonthStrip) over a grid of budgeted/spent/balance figures with a checkbox per category.
// This was a map of two, one per tab, back when Anomalies was a separate tab carrying its own copy
// of the same grid and its own separate selection to make.
const PICKER = {
  windowStart: null,
  stripStart: null,
  selStart: null,
  selEnd: null,
  anchor: null,
  table: null,
  checked: new Set(),
  preview: new Map(),
  // What a Find anomalies run flagged, keyed the same way the preview is: `categoryId|month` ->
  // direction. Both are overlays describing one run over one selection, and both are dropped by
  // the same events -- see clearActionOverlays.
  flagged: new Map(),
  showHidden: false,
  loadSeq: 0,
  renderedWindowStart: null,
}

// How many month columns a picker shows at once -- must match BUDGET_TABLE_MAX_MONTHS in
// budget-tools.ts, which is what actually trims the response.
const PICKER_VISIBLE_MONTHS = 3
// The Category column's fixed width, shared by the colgroup below and .month-strip-lead in
// style.css (which is what lines the strip's months up with the columns underneath them).
const NAME_COL_WIDTH = 220
// Moving the window rolls the grid sideways through every month in between: jumping from May 2026
// back to November 2025 shows May leave to the right while April arrives from the left, then March,
// then February, and so on until November lands in the first column. Time scales with the distance
// so each month gets its own moment, clamped at both ends -- a single step shouldn't feel abrupt,
// and a twenty-month jump shouldn't be something you sit and wait through.
const ROLL_MS_PER_MONTH = 190
const ROLL_MIN_MS = 460
const ROLL_MAX_MS = 1800
// How many months the strip itself spans -- matches Actual's own budget-page scroller.
const STRIP_MONTHS = 24
const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Function to list the months a picker's action currently covers -- a contiguous span, since the
// table's headers are chosen by click and shift-click. Nothing is selected until you pick it --
// the page always opens with an empty selection rather than restoring one.
function selectedMonths() {
  const picker = PICKER
  return picker.selStart && picker.selEnd ? monthsBetween(picker.selStart, picker.selEnd) : []
}

// Function to record a header click. Shift-click spans anchor..month in either direction. A plain
// click starts a new one-month selection (and becomes the anchor a later shift-click extends from)
// -- except on a month that is already the whole selection, where it clears instead, so the same
// click that picked a column also lets go of it. Clicking one month inside a wider span collapses
// to just that month, matching how selecting in a list normally behaves; a second click then
// clears. The span always stays contiguous, since that's what the action itself takes.
// Function to drop whatever the last run left on screen -- the preview figures, the anomaly flags,
// and the result beside them. They describe one specific run over one specific selection, so any
// change to that selection makes them stale rather than merely out of date.
function clearActionOverlays() {
  PICKER.preview = new Map()
  PICKER.flagged = new Map()
  document.getElementById("actionResult").innerHTML = ""
  // Nothing is flagged any more, so there is nothing to tag -- disabled rather than taken away,
  // so the action's buttons are the same set from the moment it is selected.
  document.getElementById("tagAnomaliesBtn").disabled = true
}

function selectMonth(month, extend) {
  const picker = PICKER
  clearActionOverlays()
  if (extend && picker.anchor) {
    picker.selStart = picker.anchor < month ? picker.anchor : month
    picker.selEnd = picker.anchor < month ? month : picker.anchor
    return
  }
  if (picker.selStart === month && picker.selEnd === month) {
    picker.selStart = null
    picker.selEnd = null
    picker.anchor = null
    return
  }
  picker.anchor = month
  picker.selStart = month
  picker.selEnd = month
}


function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number)
  const shifted = new Date(year, monthNumber - 1 + delta, 1)
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`
}

function monthsBetween(startMonth, endMonth) {
  const months = []
  for (let month = startMonth; month <= endMonth && months.length < 600; month = shiftMonth(month, 1)) {
    months.push(month)
  }
  return months
}

// Function to compute the STRIP_MONTHS-wide span the month strip covers -- Actual's own strip
// shows months on both sides of the selected ones, so this sits the range roughly in the middle
// rather than starting at it (a 3-month range starting at the anchor would leave the strip showing
// nothing but future months). Depends only on the range, so it stays put as the window moves
// across it instead of sliding under the cursor on every click.
function stripMonthsFor() {
  const picker = PICKER
  // Anchored so today sits a third of the way in -- history behind, room to plan ahead -- and then
  // left alone, so the strip stays put as the window moves across it. It only re-anchors (pages)
  // when the window would otherwise walk off an end.
  picker.stripStart ??= shiftMonth(currentMonthValue(), -Math.floor(STRIP_MONTHS / 3))
  const windowStart = picker.windowStart
  if (windowStart) {
    if (windowStart < picker.stripStart) picker.stripStart = windowStart
    const lastStart = shiftMonth(picker.stripStart, STRIP_MONTHS - PICKER_VISIBLE_MONTHS)
    if (windowStart > lastStart) picker.stripStart = shiftMonth(windowStart, -(STRIP_MONTHS - PICKER_VISIBLE_MONTHS))
  }
  return Array.from({ length: STRIP_MONTHS }, (unused, index) => shiftMonth(picker.stripStart, index))
}

// Function to render the month strip above a picker's table -- Actual's own budget-page scroller:
// a Today button, year labels above the months they cover, every month in the selected range
// clickable to jump the visible window there, the visible ones highlighted, and chevrons to step
// one month at a time. Always rendered, even when the range already fits on screen: it's the
// section's month navigation, so having it come and go with the range width just reads as broken.
function renderMonthStrip(stripMonths, visibleMonths) {
  const picker = PICKER
  const strip = document.getElementById("budgetMonthStrip")
  const chosen = selectedMonths()

  const yearCells = []
  for (let index = 0; index < stripMonths.length; ) {
    const year = stripMonths[index].slice(0, 4)
    let span = 0
    while (index + span < stripMonths.length && stripMonths[index + span].startsWith(year)) span++
    yearCells.push(`<div class="month-strip-year" style="grid-column:${index + 1}/span ${span}">${escapeHtml(year)}</div>`)
    index += span
  }
  // The window on screen is drawn as a bracket spanning its months rather than a fill behind each
  // one -- it reads as "this span" instead of "these three separate buttons are selected."
  const firstVisible = stripMonths.indexOf(visibleMonths[0])
  const bracketCell =
    firstVisible === -1
      ? ""
      : `<div class="month-strip-bracket" style="grid-column:${firstVisible + 1}/span ${Math.min(visibleMonths.length, stripMonths.length - firstVisible)}"></div>`

  const monthCells = stripMonths.map((month, index) => {
    const label = MONTH_ABBREVIATIONS[Number(month.slice(5, 7)) - 1]
    // Every month here scrolls the table's view. "in-range" marks the ones actually chosen for the
    // action (clicked in the table's headers), which is a separate thing from what's on screen.
    const inRange = chosen.includes(month)
    const classes = `month-strip-month${visibleMonths.includes(month) ? " is-visible" : ""}${inRange ? " in-range" : ""}`
    const scope = inRange ? "selected for this action" : "not selected"
    return `<button type="button" class="${classes}" style="grid-column:${index + 1}" data-month="${month}" title="${escapeHtml(month)} — ${scope}">${label}</button>`
  })

  strip.hidden = false
  strip.innerHTML = `
    <div class="month-strip-lead">
      <button type="button" class="month-strip-today" data-today aria-label="Jump to the current month" title="Jump to the current month">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>
        </svg>
      </button>
      <button type="button" class="month-strip-arrow" data-step="-1" aria-label="Earlier months">‹</button>
    </div>
    <div class="month-strip-months" style="grid-template-columns:repeat(${stripMonths.length}, minmax(26px, 1fr))">${yearCells.join("")}${bracketCell}${monthCells.join("")}</div>
    <button type="button" class="month-strip-arrow" data-step="1" aria-label="Later months">›</button>`

  strip.querySelectorAll(".month-strip-month").forEach((button) => {
    button.addEventListener("click", () => {
      picker.windowStart = button.dataset.month
      loadPickerTable()
    })
  })
  strip.querySelectorAll(".month-strip-arrow").forEach((button) => {
    button.addEventListener("click", () => {
      picker.windowStart = shiftMonth(visibleMonths[0], Number(button.dataset.step))
      loadPickerTable()
    })
  })
  // "Today" lands on the current month; loadPickerTable clamps it back into the selected range if
  // the range doesn't actually cover today.
  strip.querySelector("[data-today]").addEventListener("click", () => {
    picker.windowStart = currentMonthValue()
    loadPickerTable()
  })
}

// Function to fetch and render one picker's table for its current window. The window defaults to
// the LATEST months in the selected range (Actual opens on the current month, not the oldest one
// it knows about) and is clamped so it never runs off either end of the range. Any checked
// categories are lost on reload -- reconciling a checked set against a table that may no longer
// list the same months isn't worth the complexity for how rarely the range changes mid-review.
async function loadPickerTable() {
  const picker = PICKER
  const container = document.getElementById("budgetTable")
  // The view opens on this month and the two ahead of it -- budgets get set looking forward -- and
  // then follows the strip. Which months an action covers is a separate thing entirely: that comes
  // from clicking the table's own month headers (see selectMonth), not from what's on screen.
  picker.windowStart ??= currentMonthValue()
  const stripMonths = stripMonthsFor()
  const lastStripStart = stripMonths[stripMonths.length - PICKER_VISIBLE_MONTHS]
  if (picker.windowStart < stripMonths[0]) picker.windowStart = stripMonths[0]
  if (picker.windowStart > lastStripStart) picker.windowStart = lastStripStart
  const windowEnd = shiftMonth(picker.windowStart, PICKER_VISIBLE_MONTHS - 1)

  // Every load takes a sequence number. Clicking again while a roll is still running -- or while
  // its request is still in flight -- has to abandon the first one outright, or two animations and
  // two responses race each other to the same grid. Everything that resumes after an await checks
  // this before touching the DOM.
  const seq = (picker.loadSeq += 1)

  const from = picker.renderedWindowStart
  const rolling = Boolean(from) && from !== picker.windowStart && !prefersReducedMotion()
  // One request spanning the whole journey, not just the destination: each month rolls past showing
  // its own real figures, and the three landed on come out of that same payload rather than costing
  // a second round trip.
  const spanStart = rolling && from < picker.windowStart ? from : picker.windowStart
  const spanEnd = rolling && from > picker.windowStart ? shiftMonth(from, PICKER_VISIBLE_MONTHS - 1) : windowEnd
  picker.renderedWindowStart = picker.windowStart

  // Only blank the grid when there's nothing there yet. Paging months used to clear it to a
  // "Loading…" line first, so every move read as a blink and then a slide -- leaving the current
  // columns up until the new ones are ready makes the movement the only thing that happens.
  if (!picker.table) {
    container.innerHTML = `<div class="empty-note">Loading…</div>`
  }
  try {
    const span = await api("/api/budget/table", { method: "POST", body: JSON.stringify({ startMonth: spanStart, endMonth: spanEnd }) })
    if (picker.loadSeq !== seq) return
    clearError()
    // The strip reflects where we are going from the moment the move starts, so it isn't left
    // pointing at the old months for the length of the roll.
    renderMonthStrip(stripMonths, monthsBetween(picker.windowStart, windowEnd))
    if (rolling) {
      await rollThroughMonths(span, from, picker.windowStart, seq)
      if (picker.loadSeq !== seq) return
    }
    picker.table = windowSlice(span, picker.windowStart)
    container.scrollLeft = 0
    renderPickerTable(picker.table)
    updatePickerButtons()
  } catch (error) {
    showError(error.message)
    container.innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
  }
}

// Function to cut the three months actually on screen out of a wider journey payload, so landing
// after a roll costs nothing extra. Only the months change -- every group and category comes
// through untouched, hidden flags and all.
function windowSlice(table, startMonth) {
  const start = table.months.indexOf(startMonth)
  const months = table.months.slice(start, start + PICKER_VISIBLE_MONTHS)
  return {
    months,
    groups: table.groups.map((group) => ({
      ...group,
      categories: group.categories.map((category) => ({
        ...category,
        months: Object.fromEntries(months.map((month) => [month, category.months[month]])),
      })),
    })),
  }
}

// Function to roll the grid from one month window to another, showing every month in between on the
// way past. The whole journey is rendered as one over-wide table inside the wrapper's own
// scrollport and then genuinely scrolled: a transform of the destination block (what this used to
// do) can only ever slide the months being landed on into place, since the months in between were
// never rendered at all. Scrolling is also what lets the Category column hold still via
// position:sticky while the figures travel past it.
async function rollThroughMonths(journey, fromMonth, toMonth, seq) {
  const picker = PICKER
  const container = document.getElementById("budgetTable")
  const from = journey.months.indexOf(fromMonth)
  const to = journey.months.indexOf(toMonth)
  // A month the payload doesn't cover (a span the server capped, say) just lands with no journey,
  // rather than rolling from the wrong place.
  if (from === -1 || to === -1) return
  renderPickerTable(journey, { filmstrip: true })
  if (picker.loadSeq !== seq) return
  const monthWidth = (container.clientWidth - NAME_COL_WIDTH) / PICKER_VISIBLE_MONTHS
  container.scrollLeft = from * monthWidth
  const duration = Math.min(ROLL_MAX_MS, Math.max(ROLL_MIN_MS, Math.abs(to - from) * ROLL_MS_PER_MONTH))
  await tweenScrollLeft(container, to * monthWidth, duration, () => picker.loadSeq !== seq)
}

// Function to scroll an element to a target offset over a set duration. Eased in and out so the
// months at either end of the journey are readable and the ones in the middle travel at a steady
// clip -- a plain ease-out would spend the whole journey decelerating and make the months in
// between a blur. Resolves when it arrives, or as soon as `abandoned()` goes true.
function tweenScrollLeft(element, target, duration, abandoned) {
  return new Promise((resolve) => {
    const start = element.scrollLeft
    const startedAt = performance.now()
    const step = (now) => {
      if (abandoned()) {
        resolve()
        return
      }
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (2 - 2 * progress) ** 2 / 2
      element.scrollLeft = start + (target - start) * eased
      if (progress < 1) {
        requestAnimationFrame(step)
      } else {
        resolve()
      }
    }
    requestAnimationFrame(step)
  })
}


// Function to render one picker's grouped, foldable, checkbox-driven grid from
// POST /api/budget/table's response. Each group gets its own "select all in this group" checkbox,
// a fold toggle to its LEFT (matching Actual's own placement), and -- also matching Actual's own
// budget page -- a per-month Budgeted/Spent/Balance total summed across every category inside it.
// Category rows carry a plain checkbox plus one such cell per month, in the same order the API
// returned them (already trimmed to the window, see BUDGET_TABLE_MAX_MONTHS in budget-tools.ts).
function renderPickerTable(table, options = {}) {
  // A filmstrip render is the transient one the roll scrolls across: the same grid, but every month
  // of the journey wide enough that exactly PICKER_VISIBLE_MONTHS of them fill the wrapper, so the
  // table overflows its own scrollport instead of squeezing to fit.
  const filmstrip = options.filmstrip === true
  const picker = PICKER
  const container = document.getElementById("budgetTable")
  // Actual's own hidden categories stay out of the grid until the header menu asks for them --
  // they're hidden in Actual precisely because they aren't part of day-to-day budgeting. A group
  // is dropped once nothing inside it is left to show.
  const groups = picker.showHidden
    ? table.groups
    : table.groups
        .filter((group) => !group.hidden)
        .map((group) => ({ ...group, categories: group.categories.filter((category) => !category.hidden) }))
        .filter((group) => group.categories.length > 0)
  if (groups.every((group) => group.categories.length === 0)) {
    container.innerHTML = `<div class="empty-note">No categories found.</div>`
    return
  }

  const monthLabel = (month) => {
    const [year, monthNum] = month.split("-").map(Number)
    return new Date(year, monthNum - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" })
  }
  const sumCells = (categories, month) =>
    categories.reduce(
      (totals, category) => {
        const m = category.months[month] ?? { budgeted: 0, spent: 0, balance: 0 }
        const change = previewedBudget(category.id, month)
        return { budgeted: totals.budgeted + (change ? change.newBudgeted : m.budgeted), spent: totals.spent + m.spent, balance: totals.balance + m.balance }
      },
      { budgeted: 0, spent: 0, balance: 0 },
    )
  // bt-month-start marks the first column of each month's triplet, so the heavier "new month"
  // rule in style.css can key off a class instead of nth-child arithmetic (which the Category
  // header's rowspan would otherwise throw off by one on the sub-header row).
  const preview = PICKER.preview
  const previewedBudget = (categoryId, month) => preview.get(`${categoryId}|${month}`)
  // A flag lands on the SPENT figure, not the budgeted one: an anomaly is a statement about what
  // was spent that month, where a preview is a statement about what would be budgeted.
  const flagged = PICKER.flagged
  const flaggedAt = (categoryId, month) => flagged.get(`${categoryId}|${month}`) ?? null
  const categoryFlag = (categoryId, month) => {
    const found = flaggedAt(categoryId, month)
    return found ? { direction: found.direction, title: `Typical: ${usd(found.typicalCents)}` } : null
  }
  // A zero that has been flagged keeps its full weight -- "spent $0.00 where -$210.00 is typical"
  // is precisely the kind of finding worth looking at, so bt-zero must not dim it away.
  // `flag` is null, or { direction, title } -- the title is what the cell says on hover, which is
  // the whole of the detail the findings list used to carry in writing.
  const numCell = (cents, first, picked, changed, flag) =>
    `<td class="bt-num${first ? " bt-month-start" : ""}${picked}${changed ? " bt-changed" : ""}${flag ? ` bt-flagged bt-flagged-${flag.direction}` : ""}${cents === 0 && !changed && !flag ? " bt-zero" : ""}"${flag ? ` title="${escapeHtml(flag.title)}"` : ""}>${flag && flag.direction !== "mixed" ? `<span class="bt-flag-mark">${flag.direction === "high" ? "\u25b2" : "\u25bc"}</span> ` : ""}${usd(cents)}</td>`
  const numCells = (m, month, change, flag) =>
    `${numCell(change ? change.newBudgeted : m.budgeted, true, pick(month), Boolean(change), null)}${numCell(m.spent, false, pick(month), false, flag)}${numCell(m.balance, false, pick(month), false, null)}`

  // A month's whole column shades when it's picked, and its header is the control that picks it --
  // click for one month, shift-click for a span.
  const chosen = selectedMonths()
  const pick = (month) => (chosen.includes(month) ? " is-picked" : "")
  const monthHeaderCells = table.months
    .map(
      (month) =>
        `<th class="bt-month-start bt-month-head${pick(month)}" colspan="3" data-pick-month="${month}" title="${chosen.includes(month) ? `Click to unselect ${escapeHtml(month)}` : `Click to select ${escapeHtml(month)}`}; shift-click to extend the span">${escapeHtml(monthLabel(month))}</th>`,
    )
    .join("")
  const subHeaderCells = table.months
    .map((month) => `<th class="bt-sub bt-month-start${pick(month)}">Budgeted</th><th class="bt-sub${pick(month)}">Spent</th><th class="bt-sub${pick(month)}">Balance</th>`)
    .join("")

  // Actual dims its own hidden categories rather than dropping them from the page; the same read
  // here, since a row that is only on screen because the header menu asked for it shouldn't look
  // like part of the everyday budget. The eye-off glyph is the privacy toggle's own icon (see
  // index.html), permanently slashed. It marks whichever thing actually carries the hidden flag --
  // the group header for a hidden group, the row for a hidden category -- so a hidden group doesn't
  // repeat the same glyph down every one of its rows; the dimming is what carries down.
  const hiddenMark = `<span class="bt-hidden-mark" title="Hidden in Actual" aria-label="Hidden in Actual"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12C4.5 7 8 4.5 12 4.5S19.5 7 22 12c-2.5 5-6 7.5-10 7.5S4.5 17 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></span>`

  const groupsHtml = groups
    .map((group, groupIndex) => {
      const groupClass = `bt-group-${groupIndex}`
      const groupTotalsChanged = (month) => group.categories.some((category) => previewedBudget(category.id, month))
      // So a flag is still visible on a folded group. Only claims a direction when every flagged
      // category inside agrees on one -- otherwise the total is marked without an arrow, since
      // "some high, some low" is not a direction the summed figure actually has.
      const groupFlag = (month) => {
        const flags = group.categories.map((category) => flaggedAt(category.id, month)).filter(Boolean)
        if (flags.length === 0) return null
        const directions = [...new Set(flags.map((flag) => flag.direction))]
        return {
          direction: directions.length === 1 ? directions[0] : "mixed",
          title: `${flags.length} ${flags.length === 1 ? "category" : "categories"} flagged this month`,
        }
      }
      const groupTotalCells = table.months
        .map((month) => numCells(sumCells(group.categories, month), month, groupTotalsChanged(month) ? { newBudgeted: sumCells(group.categories, month).budgeted } : null, groupFlag(month)))
        .join("")
      const rows = group.categories
        .map(
          (category, categoryIndex) => `<tr class="bt-row ${groupClass} ${categoryIndex % 2 === 1 ? "bt-row-alt" : ""}${category.hidden || group.hidden ? " bt-hidden" : ""}">
            <td class="bt-name"><label><input type="checkbox" class="bt-category-check" data-category-id="${category.id}" data-group="${groupClass}">${category.hidden ? hiddenMark : ""} ${escapeHtml(category.name)}</label></td>
            ${table.months.map((month) => numCells(category.months[month] ?? { budgeted: 0, spent: 0, balance: 0 }, month, previewedBudget(category.id, month), categoryFlag(category.id, month))).join("")}
          </tr>`,
        )
        .join("")
      return `
        <tr class="bt-group-header${group.hidden ? " bt-hidden" : ""}">
          <td class="bt-name">
            <div class="bt-group-name">
              <button type="button" class="bt-fold-toggle" data-fold-target="${groupClass}" aria-expanded="true">▼</button>
              <label class="bt-group-check-label"><input type="checkbox" class="bt-group-check" data-group="${groupClass}">${group.hidden ? hiddenMark : ""} ${escapeHtml(group.name)}</label>
            </div>
          </td>
          ${groupTotalCells}
        </tr>
        ${rows}`
    })
    .join("")

  // Settled view: only the Category column gets a width, and every month sub-column is left unsized
  // so the fixed-layout, full-width table splits whatever is left evenly among exactly 3*N columns.
  // That both fills the panel's horizontal space and keeps the count whole -- there is no natural
  // overflow to clip a trailing sliver from.
  // Rolling view: each month is pinned to the width it will have once it lands, measured from the
  // wrapper, so the journey scrolls past at exactly the scale it arrives at and every month steps by
  // the same distance. Widths have to be explicit here -- left unsized, a fixed-layout table would
  // divide the panel among all N months at once and shrink the columns to slivers instead of
  // overflowing.
  const monthWidth = (container.clientWidth - NAME_COL_WIDTH) / PICKER_VISIBLE_MONTHS
  const colgroup = filmstrip
    ? `<colgroup><col style="width:${NAME_COL_WIDTH}px">${table.months.map(() => `<col style="width:${monthWidth / 3}px"><col style="width:${monthWidth / 3}px"><col style="width:${monthWidth / 3}px">`).join("")}</colgroup>`
    : `<colgroup><col style="width:${NAME_COL_WIDTH}px">${table.months.map(() => "<col><col><col>").join("")}</colgroup>`
  const tableWidth = filmstrip ? ` style="width:${NAME_COL_WIDTH + table.months.length * monthWidth}px"` : ""

  container.innerHTML = `
    <table class="budget-table-el${filmstrip ? " bt-filmstrip" : ""}"${tableWidth}>
      ${colgroup}
      <thead>
        <tr>
          <th class="bt-name-head" rowspan="2">
            <input type="checkbox" class="bt-all-check" id="btAllCheck" aria-label="Select all categories">
            <span>Category</span>
            <button type="button" class="bt-head-menu" data-menu-toggle aria-haspopup="menu" aria-expanded="false" aria-label="Category options">⋮</button>
          </th>
          ${monthHeaderCells}
        </tr>
        <tr>${subHeaderCells}</tr>
      </thead>
      <tbody>${groupsHtml}</tbody>
    </table>`

  container.querySelectorAll(".bt-fold-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => setGroupFolded(container, toggle, toggle.getAttribute("aria-expanded") === "true"))
  })

  container.querySelectorAll(".bt-category-check").forEach((checkbox) => {
    checkbox.checked = picker.checked.has(checkbox.dataset.categoryId)
  })
  syncGroupCheckboxes()

  container.querySelectorAll("[data-pick-month]").forEach((header) => {
    header.addEventListener("click", (event) => {
      selectMonth(header.dataset.pickMonth, event.shiftKey)
      // Re-rendered from the response already in hand -- picking months changes what's shaded and
      // what the action will cover, never which months are on screen, so there's nothing to refetch.
      renderPickerTable(table)
      renderMonthStrip(stripMonthsFor(), table.months)
      updatePickerButtons()
    })
  })

  // Only the opener is re-wired per render (the button is part of the table's own header); what the
  // menu does is bound once, at the bottom of this file, to an element that outlives the table.
  const menu = document.getElementById("budgetMenu")
  const menuToggle = container.querySelector("[data-menu-toggle]")
  menuToggle.addEventListener("click", (event) => {
    event.stopPropagation()
    const wasOpen = !menu.hidden
    closeBudgetMenus()
    menuToggle.setAttribute("aria-expanded", String(!wasOpen))
    if (wasOpen) return
    // Unhidden BEFORE it is measured, not after: [hidden] is display:none, and a display:none
    // element has no offsetParent at all -- reading one threw, which killed the whole handler and
    // left the menu permanently unopenable. Both happen in the same synchronous block, so nothing
    // paints at the pre-positioned spot in between.
    menu.hidden = false
    // Parked under the button it belongs to, measured rather than guessed -- the menu is a
    // sibling of the table wrapper now, not a child of the header cell it drops from.
    const button = menuToggle.getBoundingClientRect()
    const base = menu.offsetParent.getBoundingClientRect()
    menu.style.top = `${button.bottom - base.top + 4}px`
    menu.style.left = `${Math.max(4, Math.min(button.left - base.left - 40, base.width - 180))}px`
  })

  const allCheckbox = container.querySelector(".bt-all-check")
  allCheckbox.addEventListener("change", () => {
    container.querySelectorAll(".bt-category-check").forEach((categoryCheckbox) => {
      categoryCheckbox.checked = allCheckbox.checked
    })
  })

  container.querySelectorAll(".bt-group-check").forEach((groupCheckbox) => {
    groupCheckbox.addEventListener("change", () => {
      container.querySelectorAll(`.bt-category-check[data-group="${groupCheckbox.dataset.group}"]`).forEach((categoryCheckbox) => {
        categoryCheckbox.checked = groupCheckbox.checked
      })
    })
  })
}

// Function to fold or unfold one group, shared by its own caret and the header menu's
// Expand/Collapse all so both always leave the caret, aria state, and rows in step.
function setGroupFolded(container, toggle, folded) {
  toggle.setAttribute("aria-expanded", String(!folded))
  toggle.textContent = folded ? "\u25b6" : "\u25bc"
  container.querySelectorAll(`.${toggle.dataset.foldTarget}`).forEach((row) => {
    row.hidden = folded
  })
}

// The header menu's own behaviour, bound to markup that outlives every re-render -- the toggle
// rebuilds the very table it was clicked from, so anything wired inside that table would be
// destroyed mid-click.
document.getElementById("budgetMenu").addEventListener("click", (event) => {
  const item = event.target.closest("[data-menu-item]")
  if (!item) return
  const container = document.getElementById("budgetTable")
  closeBudgetMenus()
  if (item.dataset.menuItem === "toggle-hidden") {
    PICKER.showHidden = !PICKER.showHidden
    if (!PICKER.showHidden) {
      // Dropping them from view drops them from the selection too -- acting on a category you
      // can no longer see is exactly the kind of surprise this table exists to avoid.
      PICKER.table.groups.forEach((group) => {
        group.categories.filter((category) => category.hidden || group.hidden).forEach((category) => PICKER.checked.delete(category.id))
      })
    }
    renderPickerTable(PICKER.table)
    updatePickerButtons()
    return
  }
  const folded = item.dataset.menuItem === "collapse"
  container.querySelectorAll(".bt-fold-toggle").forEach((toggle) => setGroupFolded(container, toggle, folded))
})

function closeBudgetMenus() {
  document.querySelectorAll(".bt-menu").forEach((menu) => {
    menu.hidden = true
  })
  document.querySelectorAll("[data-menu-toggle]").forEach((toggle) => toggle.setAttribute("aria-expanded", "false"))
}
document.addEventListener("click", closeBudgetMenus)

// Read from the picker's own remembered set rather than the DOM: the table re-renders whenever the
// month window moves or the section is re-entered, and a selection that survived one of those but
// not the other would be its own kind of surprise.
function checkedCategoryIds() {
  return [...PICKER.checked]
}

// Function to sync the picker's remembered set from whatever the table currently shows -- called on
// every checkbox change, including the group "select all in here" boxes, which tick their own
// children before this runs.
// Function to derive every group checkbox from the categories under it: ticked when they all are,
// indeterminate on a partial selection, clear when none are. A group box holds no state of its own
// -- it was only ever a shortcut for its children -- so recomputing it here keeps it honest no
// matter how the underlying selection changed: a child unticked by hand, the table re-rendered
// after scrolling months, hidden categories toggled, or the group box itself clicked.
function syncGroupCheckboxes() {
  const container = document.getElementById("budgetTable")
  container.querySelectorAll(".bt-group-check").forEach((groupBox) => {
    const children = [...container.querySelectorAll(`.bt-category-check[data-group="${groupBox.dataset.group}"]`)]
    setTriState(groupBox, children)
  })
  // The header's own box stands in the same relation to every category in the grid that a group's
  // box stands in to the categories under it, so it is kept in step the same way -- including the
  // indeterminate middle state, which is the only honest thing to show for a partial selection.
  const allBox = container.querySelector(".bt-all-check")
  if (allBox) {
    setTriState(allBox, [...container.querySelectorAll(".bt-category-check")])
  }
}

// Function to put one checkbox into checked / indeterminate / unchecked from the boxes it covers.
function setTriState(box, children) {
  const checkedCount = children.filter((child) => child.checked).length
  box.checked = children.length > 0 && checkedCount === children.length
  box.indeterminate = checkedCount > 0 && checkedCount < children.length
}

function syncCheckedCategories() {
  const picker = PICKER
  // Same reasoning as selectMonth: a different set of categories is a different run.
  clearActionOverlays()
  document.querySelectorAll("#budgetTable .bt-category-check").forEach((checkbox) => {
    if (checkbox.checked) {
      picker.checked.add(checkbox.dataset.categoryId)
    } else {
      picker.checked.delete(checkbox.dataset.categoryId)
    }
  })
}

// Function to run (preview or apply) a set-values request -- the same request either way, just
// dryRun flipped; a fresh Preview is required before Apply becomes clickable (see the button's
// default `disabled` in index.html), so a real write is never the very first thing a click does.
async function runSetValues(dryRun) {
  const picker = PICKER
  if (!picker.selStart) {
    showError("Click a month header to pick which months to update.")
    return
  }
  const action = document.getElementById("budgetAction").value === "custom" ? document.getElementById("budgetCustomAmount").value : document.getElementById("budgetAction").value
  const body = {
    action,
    startMonth: picker.selStart,
    endMonth: picker.selEnd,
    categories: checkedCategoryIds(),
    dryRun,
  }
  try {
    const res = await api("/api/budget/set-values", { method: "POST", body: JSON.stringify(body) })
    clearError()
    applySetValuesPreview(res.months)
    if (dryRun) {
      // Nothing on the server moved, so the figures already in hand are still current -- just
      // redraw them with the overlay on top.
      renderPickerTable(picker.table)
    } else {
      // The real values changed underneath us; refetch so the cells show what Actual now holds,
      // with the same cells still marked as the ones this run touched.
      await loadPickerTable()
    }
    document.getElementById("applySetValuesBtn").disabled = false
  } catch (error) {
    showError(error.message)
  }
}

// Function to turn a set-values response into the overlay the table draws: one entry per line that
// would actually change, keyed by category and month. Rendering it in the grid itself (new figure
// in the Budgeted cell, cell highlighted) says the same thing a list of "old -> new" sentences did,
// in the place you were already looking. Lines that change nothing are deliberately absent -- an
// unchanged cell should look exactly like every other unchanged cell.
function applySetValuesPreview(months) {
  const picker = PICKER
  picker.preview = new Map()
  months
    .flatMap((month) => month.lines)
    .filter((line) => line.status === "would-update" || line.status === "updated")
    .forEach((line) => {
      picker.preview.set(`${line.categoryId}|${line.month}`, { newBudgeted: line.newBudgeted, status: line.status })
    })

  const note = document.getElementById("actionResult")
  note.innerHTML = picker.preview.size === 0 ? `<div class="empty-note">Nothing to change in the selected months.</div>` : ""
}

// Function to keep the action's buttons in step with the table's checkboxes. Every action needs
// the same two things -- some months and some categories -- so one readiness check covers them all.
// There is no "check nothing to mean everything" shortcut: with a real checkbox per category, an
// empty selection is far more likely to be "I haven't picked yet" than "sweep all of them", so no
// action is available until something is checked. Apply additionally stays disabled until a Preview
// has run (runSetValues enables it), and drops back out if the selection is cleared afterwards.
function updatePickerButtons() {
  const ready = checkedCategoryIds().length > 0 && selectedMonths().length > 0
  document.getElementById("previewSetValuesBtn").disabled = !ready
  document.getElementById("findAnomaliesBtn").disabled = !ready
  if (!ready) {
    document.getElementById("applySetValuesBtn").disabled = true
  }
}
// Delegated to the container, which survives every re-render of the table inside it.
document.getElementById("budgetTable").addEventListener("change", () => {
  syncCheckedCategories()
  syncGroupCheckboxes()
  updatePickerButtons()
})

document.getElementById("previewSetValuesBtn").addEventListener("click", () => runExclusive(() => runSetValues(true)))
document.getElementById("applySetValuesBtn").addEventListener("click", () => runExclusive(() => runSetValues(false)))

// Function to run "Find anomalies" -- always read-only, so no dryRun concept here at all; only
// the tag step (below) writes anything.
async function runFindAnomalies() {
  const picker = PICKER
  const categories = checkedCategoryIds()
  if (!picker.selStart) {
    showError("Click a month header to pick which months to check.")
    return
  }
  if (categories.length === 0) {
    showError("Pick at least one category to check.")
    return
  }
  const startMonth = picker.selStart
  const endMonth = picker.selEnd
  try {
    const res = await api("/api/budget/anomalies", { method: "POST", body: JSON.stringify({ categories, startMonth, endMonth }) })
    clearError()
    renderAnomalyFindings(res.findings)
    // Same treatment a preview gets: put the result in the grid you were already reading, not only
    // in the list above it. Months outside the visible window keep their flag in the map and light
    // up when the window rolls back over them.
    picker.flagged = new Map(res.findings.map((finding) => [`${finding.category.id}|${finding.month}`, { direction: finding.direction, typicalCents: finding.typicalCents }]))
    renderPickerTable(picker.table)
    lastAnomalyQuery = { categories, startMonth, endMonth }
    // Tagging becomes available once there is something to tag.
    document.getElementById("tagAnomaliesBtn").disabled = res.findings.length === 0
  } catch (error) {
    showError(error.message)
  }
}

// Function to say what a run found, in one line. The findings themselves are drawn into the grid
// (see the flagged overlay in renderPickerTable), so repeating them here as a list would be the
// same report twice -- once where you have to match names and months back against the table by eye,
// and once already in it. What a line is still needed for is the case the grid cannot show: a run
// that found nothing looks exactly like a run that never happened.
function renderAnomalyFindings(findings) {
  const container = document.getElementById("actionResult")
  // Counted distinctly on both axes: a finding is one category in one month, so the same category
  // flagged in three months is one category, not three.
  const categories = new Set(findings.map((finding) => finding.category.id)).size
  const months = new Set(findings.map((finding) => finding.month)).size
  container.innerHTML =
    findings.length === 0
      ? `<div class="empty-note">No anomalies found.</div>`
      : `<div class="empty-note">Flagged ${categories} ${categories === 1 ? "category" : "categories"} across ${months} ${months === 1 ? "month" : "months"} — highlighted below.</div>`
}

// Function to tag (or, dry-run, preview tagging) the transaction(s) behind the last "Find
// anomalies" run -- re-runs that exact same query server-side rather than round-tripping the
// findings themselves back up, see lastAnomalyQuery's own doc comment.
async function runTagAnomalies() {
  if (!lastAnomalyQuery) {
    return
  }
  try {
    // dryRun is explicitly false: the route treats a missing flag as a dry run (parseDryRun in
    // app-server.ts), so leaving it off would quietly turn every tag run into a preview.
    const res = await api("/api/budget/anomalies/tag", { method: "POST", body: JSON.stringify({ ...lastAnomalyQuery, dryRun: false }) })
    clearError()
    renderTagResults(res.tagResults)
  } catch (error) {
    showError(error.message)
  }
}

function renderTagResults(results) {
  const container = document.getElementById("actionResult")
  if (results.length === 0) {
    container.innerHTML = `<div class="empty-note">Nothing to tag.</div>`
    return
  }
  container.innerHTML = results
    .map((result) => {
      if (result.status === "no-transactions") {
        return `<div class="finding"><span class="chip info">none</span><div><div class="title">${escapeHtml(result.month)} — ${escapeHtml(result.categoryName)}</div><div class="detail">No transactions found to tag.</div></div></div>`
      }
      const chip = result.status === "tagged" ? "ok" : result.status === "would-tag" ? "warn" : "info"
      const label = result.status === "would-tag" ? "would tag" : result.status === "already-tagged" ? "already tagged" : "tagged"
      return `<div class="finding"><span class="chip ${chip}">${escapeHtml(label)}</span><div><div class="title">${escapeHtml(result.date)} — ${escapeHtml(result.payee)}</div><div class="detail">${moneySpan(result.amount)} · ${escapeHtml(result.categoryName)}, ${escapeHtml(result.month)}</div></div></div>`
    })
    .join("")
}

document.getElementById("findAnomaliesBtn").addEventListener("click", () => runExclusive(runFindAnomalies))
document.getElementById("tagAnomaliesBtn").addEventListener("click", () => runExclusive(runTagAnomalies))

// Small per-browser preferences (privacy mode, fold state, etc.) are persisted via a cookie, not
// localStorage -- this app's own port changes on every
// restart (the CLI's own default is an OS-assigned ephemeral port, see app.ts), and localStorage is
// scoped to the full origin (scheme+host+port), so it would reset every time the server restarts on
// a new port even though nothing about the browser or the preference itself changed. A cookie's
// scope omits the port (RFC 6265 -- unrelated services on different ports of the same host share
// cookies), so the same "localhost" preference survives a restart. Still never sent anywhere else --
// this server is the only thing reading it, and only to decide the initial state on this same page.
function getCookie(name) {
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith(`${name}=`))
      ?.split("=")[1] ?? null
  )
}
function setCookie(name, value) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`
}

// Privacy mode -- an Actual-style eye toggle that blurs dollar figures (anything wrapped in
// moneySpan) and a handful of other identifying fields (birth date, pension/Social Security
// timing, ...) called out individually in style.css's own privacy rules.
function applyPrivacyMode(active) {
  document.body.classList.toggle("privacy", active)
  const btn = document.getElementById("privacyToggle")
  if (btn) btn.setAttribute("aria-pressed", String(active))
  // Chart axis/marker/depletes-at text is mask-swapped at render time (see moneyMaskText), not
  // CSS-blurred, so an already-drawn chart needs an actual re-render to pick up the new privacy
  // state -- unlike the CSS-blur figures elsewhere on the page, which react to body.privacy on
  // their own. Only re-render if a check has actually completed; runCheck's own first render
  // already reads the current privacy state.
  if (lastCheckResult) renderCheckResult(lastCheckResult)
}
document.getElementById("privacyToggle").addEventListener("click", () => {
  const active = !document.body.classList.contains("privacy")
  applyPrivacyMode(active)
  try {
    setCookie("privacyMode", active ? "1" : "0")
  } catch {
    // Cookies disabled -- the toggle still works for this page view, it just won't be remembered.
  }
})
try {
  applyPrivacyMode(getCookie("privacyMode") === "1")
} catch {
  applyPrivacyMode(false)
}

// Whether the Bridge chart currently shows as a table instead of its line (issue #25) -- Monte
// Carlo is unaffected. Persisted the same getCookie/setCookie way fold state is (see that
// function's own doc comment for why a cookie over localStorage).
function isBridgeTableView() {
  return getCookie("bridgeTableView") === "table"
}
// The button's own icon shows what clicking it will switch TO, not the current view -- a table
// icon while looking at the chart, a chart icon while looking at the table -- matching
// title/aria-label, which already say "View as X" for the same reason.
const BRIDGE_VIEW_TABLE_ICON = `<rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="10" x2="9" y2="20"/>`
const BRIDGE_VIEW_CHART_ICON = `<path d="M4 4v15a1 1 0 0 0 1 1h16"/><path d="M7 15l4-5 3 3 5-7"/>`
function applyBridgeTableView(isTable) {
  const btn = document.getElementById("bridgeViewToggle")
  const label = isTable ? "View as chart" : "View as table"
  btn.setAttribute("aria-pressed", String(isTable))
  btn.title = label
  btn.setAttribute("aria-label", label)
  btn.querySelector("svg").innerHTML = isTable ? BRIDGE_VIEW_CHART_ICON : BRIDGE_VIEW_TABLE_ICON
  // Same reasoning as applyPrivacyMode's own re-render -- only if a check has actually completed;
  // runCheck's own first render already reads isBridgeTableView() fresh.
  if (lastCheckResult) renderCheckResult(lastCheckResult)
}
document.getElementById("bridgeViewToggle").addEventListener("click", () => {
  const isTable = !isBridgeTableView()
  try {
    setCookie("bridgeTableView", isTable ? "table" : "chart")
  } catch {
    // Cookies disabled -- the toggle still works for this page view, it just won't be remembered.
  }
  applyBridgeTableView(isTable)
})
applyBridgeTableView(isBridgeTableView())

// .retirement-live-sticky's own top/height (see style.css) has to leave exactly enough room for
// .retirement-toolbar above it, but that panel's height isn't a constant the way the topbar's is --
// its tile row grows once a check result adds Spend/Rule-of-55/debt-payoff tiles. A ResizeObserver
// keeps --retirement-toolbar-height in sync with whatever the panel actually renders at, on every
// cause (a check result landing, a window resize, a font swap), rather than this file having to
// know every call site that might change that height and re-measure after each one by hand.
const retirementToolbarEl = document.getElementById("retirementToolbar")
if (retirementToolbarEl) {
  new ResizeObserver((entries) => {
    const height = entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height
    document.documentElement.style.setProperty("--retirement-toolbar-height", `${Math.ceil(height)}px`)
  }).observe(retirementToolbarEl)
}

// --- Login/logout ---
//
// Both the Retirement and Budget pages need a data source connected before their own first fetch,
// so this gate runs once at startup, ahead of either page's own bootstrap, rather than each page
// checking for itself. Two mutually exclusive data sources (issue #22/#35): syncing live with
// Actual (the original behavior, via /api/session), or importing a CSV/TSV file's name,balance
// rows instead (via /api/data-source, see file-account-data-source.ts) -- picked with the
// dataSourceMode radios in #loginBackdrop. Neither /api/session nor /api/data-source's GET ever
// echoes the Actual API key back, so the login form always starts blank -- there's no "already
// filled in" state for it to restore (the file path is the one exception; see
// prefillFileFieldsFromSession below).
let ACTIVE_DATA_SOURCE_MODE = "actual"

// Function to reflect which data source is active into the parts of the page that care: the
// Budget tab (disabled entirely in file mode -- it only ever implements Retirement's narrower
// AccountDataSource needs, see the "companion app north star" comment in app-server.ts) and the
// logout/disconnect icon's own title (so it always describes what it's actually about to do).
function applyDataSourceMode(mode) {
  ACTIVE_DATA_SOURCE_MODE = mode
  const budgetTab = document.querySelector('.section-item[data-section="budget"]')
  budgetTab.classList.toggle("disabled", mode === "file")
  budgetTab.title = mode === "file" ? "Not available while importing from a file" : ""
  const logoutBtn = document.getElementById("logoutBtn")
  const label = mode === "file" ? "Disconnect file" : "Log out of Actual"
  logoutBtn.title = label
  logoutBtn.setAttribute("aria-label", label)
}

// Function to poll the file-import health probe and update the topbar's own warn chip -- issue
// #35's "warn chip if the remembered file becomes unavailable" and "last successful load's
// timestamp is preserved and shown" acceptance criteria. A no-op, chip left hidden, in Actual mode.
// Deliberately never throws/interrupts the page -- see GET /api/data-source's own doc comment in
// app-server.ts, this just mirrors whatever it reports.
async function refreshDataSourceChip() {
  const chip = document.getElementById("dataSourceChip")
  if (ACTIVE_DATA_SOURCE_MODE !== "file") {
    chip.hidden = true
    return
  }
  try {
    const status = await api("/api/data-source")
    if (status.mode !== "file") {
      chip.hidden = true
      return
    }
    const loadedAt = status.lastLoadedAt ? new Date(status.lastLoadedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "never"
    chip.hidden = false
    chip.classList.toggle("warn", !status.available)
    chip.classList.toggle("info", status.available)
    chip.title = status.available ? `Importing from ${status.filePath}` : `File unavailable: ${status.error}`
    chip.textContent = status.available ? `File · loaded ${loadedAt}` : `File unavailable · last loaded ${loadedAt}`
  } catch {
    // The probe request itself failed (server unreachable, etc.) -- leave the chip as it was
    // rather than flashing a misleading state; the next refresh (or the retry-banner path
    // elsewhere on the page) will pick it back up.
  }
}

// Restores whichever section was last chosen (per-browser cookie, same restart-survives-a-port-
// change rationale as every other small preference here -- see getCookie/setCookie's own doc
// comment), falling back to Budget (activateSection itself redirects that to Retirement when
// Budget is disabled). Applying it rather than trusting the HTML's default markup is also what
// makes Budget's data load on a restored section, not just on a manual click. Same reasoning for
// the action: applied rather than trusted from the markup, so the heading, the amount box and the
// button pair can never disagree with whichever option the page happens to open on. All of this
// waits for startApp (i.e. a confirmed data source) rather than running unconditionally at script
// load, since activateSection's own Budget/Retirement branches immediately fetch real data
// (loadPickerTable/runCheck) -- before that this fetch can only fail.
function startApp() {
  loadState()
  loadExpenseCategoryOptions()
  applySelectedAction()
  applySectionFolds()
  refreshDataSourceChip()
  try {
    const savedSection = getCookie("activeSection")
    const knownSections = [...document.querySelectorAll(".section-item[data-section]")].map((i) => i.dataset.section)
    activateSection(knownSections.includes(savedSection) ? savedSection : "budget")
  } catch {
    activateSection("budget")
  }
}
// Same show/hide dance as openChartZoom/closeChartZoom -- .modal-backdrop starts at opacity:0 even
// once un-hidden, and needs a forced layout read between clearing `hidden` and adding `.open` so
// the two changes don't land in the same paint (which would skip the fade-in transition entirely).
function showLoginModal() {
  const backdrop = document.getElementById("loginBackdrop")
  backdrop.hidden = false
  void backdrop.offsetHeight
  backdrop.classList.add("open")
}
function hideLoginModal() {
  document.getElementById("loginBackdrop").classList.remove("open")
  document.getElementById("loginBackdrop").hidden = true
}
async function checkSession() {
  try {
    const [sessionStatus, dataSourceStatus] = await Promise.all([api("/api/session"), api("/api/data-source")])
    if (dataSourceStatus.mode === "file") {
      applyDataSourceMode("file")
      startApp()
    } else if (sessionStatus.loggedIn) {
      applyDataSourceMode("actual")
      startApp()
    } else {
      showLoginModal()
    }
  } catch (error) {
    // The session check itself failed (server unreachable, etc.) -- same retry-banner fallback the
    // rest of the page uses for a failed fetch, rather than a blank screen with no way forward.
    showError(error.message, () => checkSession())
  }
}

// Toggles the field group shown below the radios, and the submit button's own label, so neither
// can ever disagree with whichever mode is actually selected.
function applyLoginFormMode(mode) {
  document.getElementById("actualFields").hidden = mode === "file"
  document.getElementById("fileFields").hidden = mode !== "file"
  document.getElementById("loginSubmitBtn").textContent = mode === "file" ? "Import file" : "Log in"
}
document.getElementById("dataSourceModeActual").addEventListener("change", () => applyLoginFormMode("actual"))
document.getElementById("dataSourceModeFile").addEventListener("change", () => applyLoginFormMode("file"))
// Best-effort convenience only -- browsers never expose a picked file's real filesystem path to a
// page (sandboxed by design), just its bare name, so this can prefill a starting point but can't
// fill in the directory the server would actually need. The path field stays a plain text input
// the person is expected to check/complete themselves; see the note in #fileFields' own copy.
document.getElementById("importFilePicker").addEventListener("change", (e) => {
  const file = e.target.files[0]
  if (!file) return
  const pathField = document.getElementById("importFilePath")
  if (!pathField.value.trim()) {
    pathField.value = file.name
  }
})

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault()
  const errorEl = document.getElementById("loginError")
  errorEl.hidden = true
  const submitBtn = document.getElementById("loginSubmitBtn")
  const mode = document.getElementById("dataSourceModeFile").checked ? "file" : "actual"
  submitBtn.disabled = true
  submitBtn.textContent = mode === "file" ? "Importing…" : "Logging in…"
  try {
    if (mode === "file") {
      const filePath = document.getElementById("importFilePath").value.trim()
      if (!filePath) throw new Error("Enter the file's path on the server.")
      await api("/api/data-source", { method: "POST", body: JSON.stringify({ filePath }) })
    } else {
      const baseUrl = document.getElementById("loginBaseUrl").value.trim()
      const budgetId = document.getElementById("loginBudgetId").value.trim()
      const apiKey = document.getElementById("loginApiKey").value.trim()
      if (!baseUrl || !budgetId || !apiKey) throw new Error("Fill in all three fields.")
      await api("/api/session", { method: "POST", body: JSON.stringify({ baseUrl, budgetId, apiKey }) })
    }
    applyDataSourceMode(mode)
    hideLoginModal()
    startApp()
  } catch (error) {
    errorEl.textContent = error.message
    errorEl.hidden = false
  } finally {
    submitBtn.disabled = false
    submitBtn.textContent = mode === "file" ? "Import file" : "Log in"
  }
})
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api(ACTIVE_DATA_SOURCE_MODE === "file" ? "/api/data-source" : "/api/session", { method: "DELETE" })
  } catch {
    // Nothing sensible to show here -- reload regardless, which re-checks the session and lands on
    // the login modal either way (logged out for real, or the DELETE itself failed and a stale
    // session is still on disk, in which case the next real request surfaces whatever's actually
    // wrong).
  }
  location.reload()
})

checkSession()

// Hot-reload: poll the server's per-process build id (see startAppServer in app-server.ts) and
// reload the page the moment it changes -- static files (app.js/style.css/index.html) are already
// re-read from disk on every request, so no restart is needed for those, but a server-code change
// (app-server.ts, fire-*.ts) needs a new process, and this catches exactly that: a tab left open
// across a restart refreshes itself instead of showing stale, disconnected UI. The first
// successful poll only records a baseline (a page load's own request already reflects the running
// process, so there's nothing to reload yet); a failed poll (mid-restart, briefly unreachable) is
// silently skipped rather than treated as a change, and gets caught up once the new process answers.
let hotReloadBuildId = null
setInterval(async () => {
  let body
  try {
    body = await api("/api/dev/build-id")
  } catch {
    return
  }
  if (hotReloadBuildId === null) {
    hotReloadBuildId = body.buildId
  } else if (body.buildId !== hotReloadBuildId) {
    location.reload()
  }
}, 1500)
