// Vanilla JS, no framework, no build step -- this is a config form, not a heavy client app. All
// state lives on the server (config.json); this file's only job is to render what GET
// /api/retirement/state returns and PATCH/POST the endpoints when something changes.

let STATE = null

function usd(cents) {
  const sign = cents < 0 ? "-" : ""
  return sign + "$" + (Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  renderAccounts()
}

function renderSummary() {
  const portfolioTotal = STATE.accounts.filter((a) => a.isPortfolio).reduce((sum, a) => sum + a.balance, 0)
  document.getElementById("sumPortfolio").textContent = usd(portfolioTotal)
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
      ? typeInfo.ruleOf55Eligible || account.type === "inherited-ira"
        ? account.type === "inherited-ira"
          ? "No age restriction (IRC §72(t)(2)(A)(iv))"
          : "Always accessible"
        : "Always accessible"
      : `Accessible at ${account.accessAge}`
    const ruleOf55Note = account.ruleOf55SeparationAge ? ` — Rule of 55 at ${account.ruleOf55SeparationAge}` : ""

    const showContribution = typeInfo.contributionAllowed
    const contributionValue = account.monthlyContribution != null ? (account.monthlyContribution / 100).toString() : ""
    const maxCaption = account.monthlyContributionIsMax
      ? `<div class="derived">≈ ${usd(account.monthlyContribution ?? 0)}/mo — remainder of the ${typeInfo.limitGroup} limit after other accounts</div>`
      : ""

    row.innerHTML = `
      <div class="acct-id">
        <div class="name">${escapeHtml(account.name)}</div>
        <div class="balance num">${usd(account.balance)}</div>
        <div class="cat-note">${accessNote}${ruleOf55Note}</div>
      </div>
      <div class="acct-fields">
        <div class="field full">
          <label>Account type</label>
          <select data-field="type">${typeOptions}</select>
        </div>
        <div class="field ${typeInfo.isPortfolio ? "" : "hidden"}">
          <label>Allocation</label>
          <select data-field="allocationPreset">${allocOptions}</select>
        </div>
        <div class="field ${showContribution ? "" : "hidden"}">
          <label>Monthly contribution</label>
          <div class="contrib-row">
            <input type="number" min="0" step="0.01" data-field="monthlyContribution" value="${contributionValue}" placeholder="0" ${account.monthlyContributionIsMax ? "disabled" : ""}>
            ${typeInfo.limitGroup ? `<button type="button" class="toggle ${account.monthlyContributionIsMax ? "on" : ""}" data-toggle-max><span class="dot"></span>Max</button>` : ""}
          </div>
          ${maxCaption}
        </div>
        ${typeInfo.ruleOf55Eligible ? `
        <div class="field">
          <label>Separate from this employer at age</label>
          <input type="number" min="0" data-field="ruleOf55SeparationAge" value="${account.ruleOf55SeparationAge ?? ""}" placeholder="0 if not applicable">
        </div>` : ""}
        ${!typeInfo.isPortfolio ? `<div class="no-fields-note">Not part of the investable portfolio — no allocation or contribution to set.</div>` : ""}
        ${!typeInfo.isPortfolio ? "" : account.limitLines.length ? `<div class="limit-lines">${account.limitLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : (showContribution ? `<div class="limit-lines"><span class="empty">No IRS contribution limit applies to this account type.</span></div>` : "")}
      </div>
    `

    row.querySelector("select[data-field='type']").addEventListener("change", (e) => patchAccount(account.id, { type: e.target.value }))
    const allocSelect = row.querySelector("select[data-field='allocationPreset']")
    if (allocSelect) allocSelect.addEventListener("change", (e) => patchAccount(account.id, { allocationPreset: e.target.value }))
    const contribInput = row.querySelector("input[data-field='monthlyContribution']")
    if (contribInput) {
      contribInput.addEventListener("change", (e) => {
        const dollars = e.target.value === "" ? null : parseFloat(e.target.value)
        patchAccount(account.id, { monthlyContribution: dollars === null ? null : Math.round(dollars * 100) })
      })
    }
    const ruleInput = row.querySelector("input[data-field='ruleOf55SeparationAge']")
    if (ruleInput) {
      ruleInput.addEventListener("change", (e) => {
        const age = e.target.value === "" ? null : parseFloat(e.target.value)
        patchAccount(account.id, { ruleOf55SeparationAge: age === null || age <= 0 ? null : age })
      })
    }
    const maxToggle = row.querySelector("[data-toggle-max]")
    if (maxToggle) {
      maxToggle.addEventListener("click", () => {
        if (account.monthlyContributionIsMax) {
          patchAccount(account.id, { monthlyContribution: null })
          return
        }
        // At most one "max" per limit group -- clear any sibling in the same group first.
        const group = typeInfo.limitGroup
        const siblings = STATE.accounts.filter((a) => a.id !== account.id && a.monthlyContributionIsMax && STATE.accountTypes[a.type].limitGroup === group)
        Promise.all(siblings.map((sibling) => patchAccount(sibling.id, { monthlyContribution: null }))).then(() =>
          patchAccount(account.id, { monthlyContribution: "max" }),
        )
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

function renderFinding(finding) {
  const div = document.createElement("div")
  div.className = "finding"
  div.innerHTML = `<span class="chip ${finding.level}">${finding.level}</span>
    <div>
      <div class="title">${escapeHtml(finding.title)}</div>
      ${finding.detail.map((line) => `<div class="detail">${escapeHtml(line)}</div>`).join("")}
    </div>`
  return div
}

async function runCheck() {
  const container = document.getElementById("checkResult")
  container.innerHTML = `<div class="empty-note">Checking…</div>`
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
  }
}

async function runGenerate() {
  const btn = document.getElementById("generateBtn")
  const result = document.getElementById("genResult")
  btn.disabled = true
  try {
    const r = await api("/api/retirement/generate", { method: "POST" })
    const boostLines = r.ruleOf55Boosts
      .map((b) => `<div class="line boost">Rule of 55 applied: ${escapeHtml(b.accountName)} accessible from age ${b.to} (was ${b.from ?? "none"}).</div>`)
      .join("")
    result.innerHTML = `
      <div class="line">Portfolio accounts (${r.portfolioAccountCount}): current total <span class="num">${usd(r.portfolioTotal)}</span></div>
      <div class="line">Expense categories (${r.expenseCategoryCount}): trailing 12-month spend <span class="num">${usd(r.annualSpend)}</span>/yr</div>
      ${boostLines}
      <div class="line">Wrote <span class="num">${escapeHtml(r.outputPath)}</span> (${r.widgetTypes.length} widgets: ${r.widgetTypes.join(", ")}).${r.preservedExisting ? " Preserved customizations from the existing file." : ""}</div>
      <div class="import-steps">
        Import it into Actual:
        <ol>
          <li>Reports → new dashboard page (e.g. "FIRE")</li>
          <li>On that page, "…" menu → Import → pick <code class="num">${escapeHtml(r.outputPath)}</code></li>
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

document.getElementById("birthDate").addEventListener("change", (e) => patchPlan({ birthDate: e.target.value || null }, "savedBirth"))
document.getElementById("retireAges").addEventListener("change", (e) => {
  try {
    patchPlan({ retirementAges: parseRetirementAges(e.target.value) }, "savedRetire")
  } catch (error) {
    showError(error.message)
  }
})
document.getElementById("planToAge").addEventListener("change", (e) => patchPlan({ planToAge: parseFloat(e.target.value) }, "savedPlan"))
document.getElementById("generateBtn").addEventListener("click", runGenerate)

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"))
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"))
    tab.classList.add("active")
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active")
    if (tab.dataset.tab === "analyze") runCheck()
  })
})

loadState()
