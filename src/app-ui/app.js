// Vanilla JS, no framework, no build step -- this is a config form, not a heavy client app. All
// state lives on the server (config.json); this file's only job is to render what GET
// /api/retirement/state returns and PATCH/POST the endpoints when something changes.

let STATE = null
// The last-fetched GET /api/retirement/live-settings response, cached here so render() (called
// after every STATE-changing action, including the initial page load) can always re-render the
// "Configured in the Actual Dashboard" panel from it -- fixes a real load-order race where that
// panel's pinned-field highlighting depends on STATE.dashboard, but loadState() and
// loadLiveSettings() fire concurrently on startup with no guaranteed order (see the bottom of this
// file), so the first render could land before STATE existed and show nothing as pinned until a
// manual refresh re-ran loadLiveSettings after STATE was already populated.
let LIVE_SETTINGS = null
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

// Wraps a read-only dollar figure so privacy mode (see the eye toggle) can blur it without
// touching the ones still being edited (plain <input> values are never wrapped in this).
function moneySpan(cents) {
  return `<span class="num money">${usd(cents)}</span>`
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
// typing isn't fighting inserted commas), reformatted with commas the moment it's not.
function attachMoneyFormatting(input) {
  if (!input) return
  input.addEventListener("focus", () => {
    const cents = parseMoneyInputCents(input.value)
    input.value = cents == null ? "" : (cents / 100).toString()
  })
  input.addEventListener("blur", () => {
    input.value = formatMoneyInputValue(parseMoneyInputCents(input.value))
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
  } catch (error) {
    showError(error.message)
  }
}

async function patchAccount(id, partial) {
  try {
    STATE = await api(`/api/retirement/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(partial) })
    clearError()
    render()
  } catch (error) {
    showError(error.message)
  }
}

async function reorderAccounts(orderedIds) {
  try {
    STATE = await api("/api/retirement/accounts/order", { method: "PATCH", body: JSON.stringify({ orderedIds }) })
    clearError()
    render()
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
  renderPlan()
  renderIncome()
  renderSimSettings()
  renderAccounts()
  // Re-renders from the cached response rather than refetching -- also keeps pinned-field
  // highlighting current after a Simulation setting is pinned/unpinned, not just at load.
  if (LIVE_SETTINGS) renderLiveSettings(LIVE_SETTINGS)
}

function renderSummary() {
  const portfolioTotal = STATE.accounts.filter((a) => a.isPortfolio).reduce((sum, a) => sum + a.balance, 0)
  document.getElementById("sumPortfolio").innerHTML = moneySpan(portfolioTotal)
  document.getElementById("sumAge").textContent = STATE.currentAge ?? "—"
  document.getElementById("sumAges").textContent = STATE.dashboard.retirementAges.length ? STATE.dashboard.retirementAges.join(", ") : "—"
  document.getElementById("sumPlanToAge").textContent = STATE.dashboard.planToAge
  document.getElementById("accountCountHint").textContent = `${STATE.accounts.length} open accounts`
}

function renderPlan() {
  const birthInput = document.getElementById("birthDate")
  const agesInput = document.getElementById("retireAges")
  const planInput = document.getElementById("planToAge")
  // Only overwrite a field the user isn't actively editing -- avoids clobbering keystrokes if a
  // response from one field's PATCH arrives while another is still focused.
  if (document.activeElement !== birthInput) birthInput.value = STATE.dashboard.birthDate ?? ""
  if (document.activeElement !== agesInput) agesInput.value = STATE.dashboard.retirementAges.join(", ")
  if (document.activeElement !== planInput) planInput.value = STATE.dashboard.planToAge
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
}

// Plain-language labels matching Actual's own Monte Carlo/Crossover config UI copy verbatim
// (MonteCarloConfiguration.tsx, MonteCarloWithdrawalRuleConfiguration.tsx,
// MonteCarloTaxConfiguration.tsx, Crossover.tsx) -- used both for the Simulation settings
// dropdown option text (see index.html) and for the read-only values shown in "Configured in the
// Actual Dashboard" below, so the same setting always reads the same way in both places.
const WITHDRAWAL_STRATEGY_LABELS = {
  proportional: "Split proportionally across pots",
  sequential: "Drain pots in order",
  "best-performer": "Spend from the best performer first",
  "target-mix": "Keep pots at their target mix",
}
const RETURN_MODEL_LABELS = {
  normal: "Random (normal distribution)",
  "historical-bootstrap": "Historical returns, shuffled",
  "historical-sequence": "Historical sequences (replay)",
}
const WITHDRAWAL_RULE_LABELS = {
  none: "None (fixed withdrawals)",
  guardrails: "Guardrails (Guyton-Klinger)",
  ratcheting: "Ratcheting (Kitces)",
  "floor-ceiling": "Floor & ceiling (Bengen)",
  boundaries: "Boundaries",
}
const TAX_MODEL_LABELS = { flat: "Flat rate per pot", bands: "Tax bands (progressive)" }
const PROJECTION_TYPE_LABELS = { hampel: "Hampel Filtered Median", median: "Median", mean: "Mean" }

// Maps a pinned DashboardConfig field to the Simulation settings input that actually sets it, so
// hovering the pinned value below can highlight where to go change it -- see renderLiveSettings.
const PINNED_FIELD_TO_INPUT_ID = {
  monteCarloWithdrawalStrategy: "mcWithdrawalStrategy",
  monteCarloReturnModel: "mcReturnModel",
  monteCarloTaxModel: "mcTaxModel",
  monteCarloInflationMean: "mcInflationMean",
  monteCarloInflationStdDev: "mcInflationStdDev",
  monteCarloMinimumWithdrawal: "mcMinimumWithdrawal",
  monteCarloSimulationCount: "mcSimulationCount",
}

// Shows the "Getting started" walkthrough while there's nothing imported into Actual yet to show
// under "Configured in the Actual Dashboard" -- driven off the same live-settings fetch that panel
// already uses, so it appears/disappears in step with reality rather than tracking its own separate
// state. Suppressed once the user dismisses it (a cookie, see getCookie/setCookie's own doc
// comment), even if they haven't imported anything -- someone who already knows the flow shouldn't
// have to keep re-dismissing it on every load.
function updateWalkthrough(hasLiveDashboard) {
  const el = document.getElementById("walkthrough")
  let dismissed = false
  try {
    dismissed = getCookie("walkthroughDismissed") === "1"
  } catch {
    // Cookies disabled -- fall back to always showing it until a live dashboard appears.
  }
  el.hidden = hasLiveDashboard || dismissed
}

// Renders the read-only "Configured in the Actual Dashboard" panel from GET /api/retirement/live-settings
// -- fetched separately from the main state (see loadLiveSettings) since it's its own live ActualQL
// read and isn't needed on every keystroke the way account balances are. Split into Crossover and
// Simulation sections since several field names/values (minimum withdrawal, return-ish figures)
// could otherwise read as belonging to either widget.
function renderLiveSettings(settings) {
  const container = document.getElementById("liveSettings")
  const hasLiveDashboard = Boolean(settings && (settings.crossover || settings.monteCarlo))
  updateWalkthrough(hasLiveDashboard)
  if (!hasLiveDashboard) {
    container.innerHTML = `<div class="empty-note">No live FIRE dashboard found yet — generate and import one first.</div>`
    return
  }
  const pinned = STATE ? STATE.dashboard : {}
  const row = (label, value, pinnedField, isMoney) => {
    const isPinned = pinnedField && pinned[pinnedField] != null
    const valueHtml = isMoney ? moneySpan(value) : escapeHtml(String(value))
    const target = isPinned ? PINNED_FIELD_TO_INPUT_ID[pinnedField] : null
    return `<div class="kv"><span class="k">${escapeHtml(label)}</span><span class="v${isPinned ? " pinned" : ""}"${target ? ` data-highlight-target="${target}" title="Set in Simulation settings"` : ""}>${valueHtml}</span></div>`
  }
  const sections = []
  if (settings.crossover) {
    const c = settings.crossover
    sections.push({
      label: "Crossover",
      rows: [
        row("Safe withdrawal rate", `${Math.round(c.safeWithdrawalRate * 1000) / 10}%`),
        row("Estimated return", c.estimatedReturn == null ? "auto" : `${Math.round(c.estimatedReturn * 1000) / 10}%`),
        row("Projection type", PROJECTION_TYPE_LABELS[c.projectionType] ?? c.projectionType),
        row("Expense adjustment", `${Math.round(c.expenseAdjustmentFactor * 100)}%`),
      ],
    })
  }
  if (settings.monteCarlo) {
    const m = settings.monteCarlo
    sections.push({
      label: "Simulation",
      rows: [
        row("Withdrawal strategy", (m.withdrawalStrategy && WITHDRAWAL_STRATEGY_LABELS[m.withdrawalStrategy]) ?? m.withdrawalStrategy ?? "—", "monteCarloWithdrawalStrategy"),
        row("Return model", (m.returnModel && RETURN_MODEL_LABELS[m.returnModel]) ?? m.returnModel ?? "—", "monteCarloReturnModel"),
        row("Withdrawal rule", WITHDRAWAL_RULE_LABELS[m.withdrawalRuleType] ?? m.withdrawalRuleType),
        row("Tax model", TAX_MODEL_LABELS[m.taxModel] ?? m.taxModel, "monteCarloTaxModel"),
        row("Inflation (mean)", `${Math.round((m.inflationMean ?? 0) * 1000) / 10}%`, "monteCarloInflationMean"),
        row("Inflation (std dev)", `${Math.round(m.inflationStdDev * 1000) / 10}%`, "monteCarloInflationStdDev"),
        row("Minimum withdrawal", usd(m.minimumWithdrawal), "monteCarloMinimumWithdrawal"),
        row("Simulation count", m.simulationCount.toLocaleString(), "monteCarloSimulationCount"),
      ],
    })
  }
  container.innerHTML = sections
    .map((section) => `<div class="income-label">${escapeHtml(section.label)}</div><div class="kv-grid">${section.rows.join("")}</div>`)
    .join("")
  container.querySelectorAll("[data-highlight-target]").forEach((el) => {
    const target = document.getElementById(el.dataset.highlightTarget)
    if (!target) return
    el.addEventListener("mouseenter", () => target.classList.add("sim-field-highlight"))
    el.addEventListener("mouseleave", () => target.classList.remove("sim-field-highlight"))
  })
}

async function loadLiveSettings() {
  const btn = document.getElementById("refreshLiveSettingsBtn")
  btn.disabled = true
  try {
    LIVE_SETTINGS = await api("/api/retirement/live-settings")
    renderLiveSettings(LIVE_SETTINGS)
  } catch (error) {
    document.getElementById("liveSettings").innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
  } finally {
    btn.disabled = false
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

  // Pot drain order (see fire-dashboard.ts's buildMonteCarloWidget) only matters for "sequential"
  // -- every other withdrawal strategy ignores it, so reordering is only offered while that's the
  // plan's chosen strategy, rather than a control that's live but silently does nothing.
  const reorderEnabled = STATE.dashboard.monteCarloWithdrawalStrategy === "sequential"
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

    const accessNote = account.accessAge === null
      ? account.type === "inherited-ira"
        ? "No age restriction (IRC §72(t)(2)(A)(iv))"
        : "Always accessible"
      : `Accessible at ${account.accessAge}`
    const ruleOf55Note = account.ruleOf55SeparationAge ? ` — Rule of 55 at <span class="money">${account.ruleOf55SeparationAge}</span>` : ""

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

    row.innerHTML = `
      <div class="acct-id">
        ${reorderEnabled ? `<div class="drag-handle" title="Drag to change withdrawal order">⠿</div>` : ""}
        <div class="acct-id-text">
          <div class="name">${escapeHtml(account.name)}</div>
          <div class="balance">${moneySpan(account.balance)}</div>
          <div class="cat-note">${accessNote}${ruleOf55Note}</div>
        </div>
      </div>
      <div class="acct-fields">
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
          <div class="derived">Defaults to the ${escapeHtml(allocationLabel)} preset — override just this account if its real return differs</div>
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
        ${payoffNote}` : ""}
        ${!typeInfo.isPortfolio ? `<div class="no-fields-note">Not part of the investable portfolio — no allocation or contribution to set.</div>` : ""}
        ${!typeInfo.isPortfolio ? "" : account.limitLines.length ? `<div class="limit-lines">${account.limitLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : (showContribution ? `<div class="limit-lines"><span class="empty">No IRS contribution limit applies to this account type.</span></div>` : "")}
      </div>
    `

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
      contribInput.addEventListener("change", (e) => {
        runExclusive(() => patchAccount(account.id, { monthlyContribution: parseMoneyInputCents(e.target.value) }))
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
      salaryInput.addEventListener("change", (e) => {
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
      rothBasisInput.addEventListener("change", (e) => {
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
      mortgagePaymentInput.addEventListener("change", (e) => {
        runExclusive(() => patchAccount(account.id, { mortgageMonthlyPayment: parseMoneyInputCents(e.target.value) }))
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
      mortgageBalanceInput.addEventListener("change", (e) => {
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

// Server-built sentences (findings, boost/payoff lines) embed dollar amounts as plain text
// (formatUsd's own "$1,234.56"/"-$1,234.56" shape) alongside ages/percentages that privacy mode
// should leave readable -- this wraps just the dollar substrings in a .money span after escaping,
// so the eye toggle can blur them without needing the server to mark them up itself.
function moneyify(text) {
  return escapeHtml(text).replace(/-?\$[\d,]+\.\d{2}/g, (match) => `<span class="money">${match}</span>`)
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

async function runCheck() {
  const container = document.getElementById("checkResult")
  const refreshBtn = document.getElementById("refreshAnalysisBtn")
  refreshBtn.disabled = true
  container.innerHTML = `<div class="empty-note">Analyzing…</div>`
  try {
    const result = await api("/api/retirement/check")
    container.innerHTML = ""
    if (result.driftFindings.length === 0 && result.bridgeFindings.length === 0) {
      container.innerHTML = `<div class="empty-note">No findings.</div>`
      return
    }
    if (result.driftFindings.length > 0) {
      const group = document.createElement("div")
      group.className = "findings-group"
      group.innerHTML = `<div class="group-label">Drift</div>`
      result.driftFindings.forEach((f) => group.appendChild(renderFinding(f)))
      container.appendChild(group)
    }
    if (result.bridgeFindings.length > 0) {
      const group = document.createElement("div")
      group.className = "findings-group"
      group.innerHTML = `<div class="group-label">Bridge · mean returns, ${Math.round(result.inflationMean * 1000) / 10}% inflation, withdrawals taxed</div>`
      result.bridgeFindings.forEach((f) => group.appendChild(renderFinding(f)))
      container.appendChild(group)
    }
  } catch (error) {
    container.innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`
  } finally {
    refreshBtn.disabled = false
  }
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

async function runGenerate() {
  const btn = document.getElementById("generateBtn")
  const result = document.getElementById("genResult")
  btn.disabled = true
  try {
    const r = await api("/api/retirement/generate", { method: "POST" })
    const filename = r.outputPath.split("/").pop()
    downloadFile(filename, r.dashboardJson, "application/json")
    const boostLines = r.ruleOf55Boosts
      .map((b) => `<div class="line boost">Rule of 55 applied: ${escapeHtml(b.accountName)} accessible from age ${b.to} (was ${b.from ?? "none"}).</div>`)
      .join("")
    const debtPayoffLines = r.debtPayoffs
      .map((d) => `<div class="line boost">Spending reduced by ${moneySpan(d.monthlyAmount)}/mo once ${escapeHtml(d.accountName)} is paid off at age ${d.payoffAge}.</div>`)
      .join("")
    result.innerHTML = `
      <div class="line">Portfolio accounts (${r.portfolioAccountCount}): current total ${moneySpan(r.portfolioTotal)}</div>
      <div class="line">Expense categories (${r.expenseCategoryCount}): spend ${moneySpan(r.annualSpend)}/yr${r.spendBasis ? ` (from your crossover widget's own selection: ${escapeHtml(r.spendBasis)})` : " (trailing 12 months, every category — no live crossover selection to narrow it yet)"}</div>
      ${boostLines}
      ${debtPayoffLines}
      <div class="line">Downloaded <span class="num">${escapeHtml(filename)}</span>.${r.mergeSource === "live" ? " Preserved the settings currently on your imported FIRE dashboard." : r.mergeSource === "local" ? " Preserved customizations from the last file you downloaded." : ""}</div>
      <div class="import-steps">
        Import it into Actual:
        <ol>
          <li>Reports → new dashboard page (e.g. "FIRE")</li>
          <li>On that page, "…" menu → Import → pick the file you just downloaded</li>
        </ol>
      </div>`
    result.hidden = false
  } catch (error) {
    result.innerHTML = `<div class="line">${escapeHtml(error.message)}</div>`
    result.hidden = false
  } finally {
    btn.disabled = false
  }
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

document.getElementById("pensionStartAge").addEventListener("change", (e) => {
  const age = e.target.value === "" ? null : parseFloat(e.target.value)
  runExclusive(() => patchPlan({ pensionStartAge: age === null || age <= 0 ? null : age }, "savedIncome"))
})
const pensionAmountInput = document.getElementById("pensionMonthlyAmount")
attachMoneyFormatting(pensionAmountInput)
pensionAmountInput.addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ pensionMonthlyAmount: parseMoneyInputCents(e.target.value) }, "savedIncome"))
})
;[
  ["ss62", "socialSecurityMonthlyAt62"],
  ["ss67", "socialSecurityMonthlyAt67"],
  ["ss70", "socialSecurityMonthlyAt70"],
].forEach(([id, field]) => {
  const input = document.getElementById(id)
  attachMoneyFormatting(input)
  input.addEventListener("change", (e) => {
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
mcMinWithdrawalInput.addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloMinimumWithdrawal: parseMoneyInputCents(e.target.value) }, "savedSimSettings"))
})
document.getElementById("mcSimulationCount").addEventListener("change", (e) => {
  const count = e.target.value === "" ? null : parseInt(e.target.value, 10)
  runExclusive(() => patchPlan({ monteCarloSimulationCount: count === null || count <= 0 ? null : count }, "savedSimSettings"))
})
document.getElementById("refreshLiveSettingsBtn").addEventListener("click", loadLiveSettings)

document.getElementById("generateBtn").addEventListener("click", runGenerate)
document.getElementById("refreshAnalysisBtn").addEventListener("click", runCheck)

// Keyed off [data-tab] and scoped to this section's own panels, NOT a bare .tab/.panel sweep:
// Budget's tabs share the .tab class for styling but carry data-budget-tab instead, so a bare .tab
// selector matched them too and built getElementById("panel-undefined") -- null, which threw. The
// throw landed halfway through, after .active had already been stripped from every .panel on the
// page including this section's, leaving Retirement blank once you switched back to it.
document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((t) => t.classList.remove("active"))
    document.querySelectorAll("#page-retirement .panel").forEach((p) => p.classList.remove("active"))
    tab.classList.add("active")
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active")
    if (tab.dataset.tab === "analyze") runCheck()
  })
})

// --- Section switching (the sidebar's Budget/Retirement nav) ---

// Function to switch the visible top-level section -- shared by the click handler below and the
// on-load restoration a bit further down, so clicking a nav item and reloading the page onto a
// previously-chosen section behave identically (including lazily loading Budget's own data either
// way, not just on a real click).
function activateSection(name) {
  document.querySelectorAll(".section-item[data-section]").forEach((i) => i.classList.toggle("active", i.dataset.section === name))
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name))
  if (name === "budget") {
    if (!PICKER.table) loadPickerTable()
  }
}

document.querySelectorAll(".section-item[data-section]").forEach((item) => {
  item.addEventListener("click", () => {
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

// Small per-browser preferences (privacy mode, whether the getting-started walkthrough has been
// dismissed) are persisted via a cookie, not localStorage -- this app's own port changes on every
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
// moneySpan) without touching labels, ages, or percentages.
function applyPrivacyMode(active) {
  document.body.classList.toggle("privacy", active)
  const btn = document.getElementById("privacyToggle")
  if (btn) btn.setAttribute("aria-pressed", String(active))
}
document.getElementById("walkthroughDismiss").addEventListener("click", () => {
  document.getElementById("walkthrough").hidden = true
  try {
    setCookie("walkthroughDismissed", "1")
  } catch {
    // Cookies disabled -- stays dismissed for this page view only, reappears on the next load.
  }
})

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

loadState()
loadLiveSettings()

// Restores whichever section was last chosen (per-browser cookie, same restart-survives-a-port-
// change rationale as every other small preference here -- see getCookie/setCookie's own doc
// comment), falling back to Budget. Runs down here, after every const the section's own loaders
// touch is initialized -- calling it up beside the nav wiring would hit PICKER while it
// was still in its temporal dead zone. Applying it rather than trusting the HTML's default markup
// is also what makes Budget's data load on a restored section, not just on a manual click.
// Same reasoning for the action: applied rather than trusted from the markup, so the heading,
// the amount box and the button pair can never disagree with whichever option the page happens to
// open on.
applySelectedAction()

try {
  const savedSection = getCookie("activeSection")
  const knownSections = [...document.querySelectorAll(".section-item[data-section]")].map((i) => i.dataset.section)
  activateSection(knownSections.includes(savedSection) ? savedSection : "budget")
} catch {
  activateSection("budget")
}

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
