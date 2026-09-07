// Vanilla JS, no framework, no build step -- this is a config form, not a heavy client app. All
// state lives on the server (config.json); this file's only job is to render what GET
// /api/retirement/state returns and PATCH/POST the endpoints when something changes.

let STATE = null
// A single in-flight guard for every mutating action -- a "Max" toggle is really two sequential
// requests (clear a sibling, then set this one), and without a lock, an impatient second click
// during that window could interleave a second pair of requests, so the account you clicked isn't
// what ends up as "max" moments later. Ignoring a click while one chain is already running is
// simpler and safer than trying to cancel/merge overlapping requests.
let requestInFlight = false

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

function showError(message) {
  const el = document.getElementById("topError")
  el.textContent = message
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
  try {
    STATE = await api("/api/retirement/state")
    clearError()
    render()
  } catch (error) {
    showError(error.message)
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

// Renders the read-only "Configured in the Actual Dashboard" panel from GET /api/retirement/live-settings
// -- fetched separately from the main state (see loadLiveSettings) since it's its own live ActualQL
// read and isn't needed on every keystroke the way account balances are. Split into Crossover and
// Simulation sections since several field names/values (minimum withdrawal, return-ish figures)
// could otherwise read as belonging to either widget.
function renderLiveSettings(settings) {
  const container = document.getElementById("liveSettings")
  if (!settings || (!settings.crossover && !settings.monteCarlo)) {
    container.innerHTML = `<div class="empty-note">No live FIRE dashboard found yet — generate and import one first.</div>`
    return
  }
  const pinned = STATE ? STATE.dashboard : {}
  const row = (label, value, pinnedField, isMoney) => {
    const isPinned = pinnedField && pinned[pinnedField] != null
    const valueHtml = isMoney ? moneySpan(value) : escapeHtml(String(value))
    return `<div class="kv"><span class="k">${escapeHtml(label)}${isPinned ? " (pinned by you)" : ""}</span><span class="v${isPinned ? " pinned" : ""}">${valueHtml}</span></div>`
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
        row("Tax model", TAX_MODEL_LABELS[m.taxModel] ?? m.taxModel),
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
}

async function loadLiveSettings() {
  const btn = document.getElementById("refreshLiveSettingsBtn")
  btn.disabled = true
  try {
    renderLiveSettings(await api("/api/retirement/live-settings"))
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

  STATE.accounts.forEach((account) => {
    const typeInfo = STATE.accountTypes[account.type]
    const row = document.createElement("div")
    row.className = "account-row"

    const typeOptions = typeKeys
      .map((key) => `<option value="${key}" ${key === account.type ? "selected" : ""}>${STATE.accountTypes[key].label}</option>`)
      .join("")
    const allocOptions = STATE.allocationPresets
      .map((preset) => `<option value="${preset.value}" ${preset.value === account.allocationPreset ? "selected" : ""}>${preset.value} — ${preset.label}</option>`)
      .join("")

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
        <div class="name">${escapeHtml(account.name)}</div>
        <div class="balance">${moneySpan(account.balance)}</div>
        <div class="cat-note">${accessNote}${ruleOf55Note}</div>
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
        <div class="field ${typeInfo.isPortfolio && account.allocationPreset === "custom" ? "" : "hidden"}">
          <label>Expected return</label>
          <div class="input-affix suffix-percent">
            <input type="number" step="0.1" data-field="customReturnMean" value="${account.customReturnMean != null ? account.customReturnMean * 100 : ""}" placeholder="e.g. 6">
          </div>
        </div>
        <div class="field ${typeInfo.isPortfolio && account.allocationPreset === "custom" ? "" : "hidden"}">
          <label>Volatility</label>
          <div class="input-affix suffix-percent">
            <input type="number" min="0" step="0.1" data-field="customReturnStdDev" value="${account.customReturnStdDev != null ? account.customReturnStdDev * 100 : ""}" placeholder="e.g. 12">
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
            <label class="checkbox-label"><input type="checkbox" data-field="ruleOf55Active" ${isRuleOf55Active ? "checked" : ""}> Active account with this employer</label>
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
        <div class="field">
          <label>Coverage</label>
          <div class="radio-row">
            <label><input type="radio" name="hsaCoverage-${account.id}" data-field="hsaCoverage" value="self" ${account.hsaCoverage !== "family" ? "checked" : ""}> Self-only</label>
            <label><input type="radio" name="hsaCoverage-${account.id}" data-field="hsaCoverage" value="family" ${account.hsaCoverage === "family" ? "checked" : ""}> Family</label>
          </div>
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

    list.appendChild(row)
  })
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
      <div class="line">Downloaded <span class="num">${escapeHtml(filename)}</span> (${r.widgetTypes.length} widgets: ${r.widgetTypes.join(", ")}).${r.mergeSource === "live" ? " Preserved the settings currently on your imported FIRE dashboard." : r.mergeSource === "local" ? " Preserved customizations from the last file you downloaded." : ""}</div>
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

document.getElementById("mcWithdrawalStrategy").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloWithdrawalStrategy: e.target.value === "" ? null : e.target.value }, "savedSimSettings"))
})
document.getElementById("mcReturnModel").addEventListener("change", (e) => {
  runExclusive(() => patchPlan({ monteCarloReturnModel: e.target.value === "" ? null : e.target.value }, "savedSimSettings"))
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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"))
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"))
    tab.classList.add("active")
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active")
    if (tab.dataset.tab === "analyze") runCheck()
  })
})

// Privacy mode -- an Actual-style eye toggle that blurs dollar figures (anything wrapped in
// moneySpan) without touching labels, ages, or percentages. Persisted per-browser via a cookie,
// not localStorage -- this app's own port changes on every restart (the CLI's own default is an
// OS-assigned ephemeral port, see app.ts), and localStorage is scoped to the full origin
// (scheme+host+port), so it would reset every time the server restarts on a new port even though
// nothing about the browser or the preference itself changed. A cookie's scope omits the port
// (RFC 6265 -- unrelated services on different ports of the same host share cookies), so the same
// "localhost" preference survives a restart. Still never sent anywhere else -- this server is the
// only thing reading it, and only to decide the initial class on this same page.
function getPrivacyCookie() {
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith("privacyMode="))
      ?.split("=")[1] ?? null
  )
}
function setPrivacyCookie(value) {
  document.cookie = `privacyMode=${value}; path=/; max-age=31536000; samesite=lax`
}
function applyPrivacyMode(active) {
  document.body.classList.toggle("privacy", active)
  const btn = document.getElementById("privacyToggle")
  if (btn) btn.setAttribute("aria-pressed", String(active))
}
document.getElementById("privacyToggle").addEventListener("click", () => {
  const active = !document.body.classList.contains("privacy")
  applyPrivacyMode(active)
  try {
    setPrivacyCookie(active ? "1" : "0")
  } catch {
    // Cookies disabled -- the toggle still works for this page view, it just won't be remembered.
  }
})
try {
  applyPrivacyMode(getPrivacyCookie() === "1")
} catch {
  applyPrivacyMode(false)
}

loadState()
loadLiveSettings()
