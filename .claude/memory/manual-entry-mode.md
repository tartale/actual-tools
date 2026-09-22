---
name: manual-entry-mode
description: "Issue #38's standalone FIRE calculator mode -- a third login option with no data connection at all, entirely client-held state; phase 1 (of 4) shipped 2026-09-22"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T00:00:00.000Z
---

**Phase 1 shipped 2026-09-22** (`feat/manual-mode-phase-1`) -- the "open engineering question" issue
#38 itself flagged as needing its own design pass before any UI work: how does a fully ephemeral
mode (no config.json, no session file, "data lives only in the browser for that session" per the
issue's own explicit design) talk to a server built around accumulated, disk-persisted state
everywhere else?

**The answer: a genuinely stateless route, not a third `let` global mirroring file mode's own
pattern.** The tempting shortcut -- add a `let manualSession = null` module-level variable the same
shape as `fileDataSourceSession`/`actualConfig`, and the ENTIRE existing client (loadState,
renderAccounts, patchPlan, patchAccount, runCheck, the whole Plan/Accounts/Simulation Settings card
set) would work unchanged -- was explicitly rejected: even a never-written-to-disk server-side
variable is still server-held state, shared across every browser tab/user hitting this same
locally-run instance, which breaks "browser-local, ephemeral, per-session" and the issue's own "safe
to deploy somewhere more public later" framing (a server admin, or another concurrent user later,
could see it). Chose the harder-but-correct path instead: `POST /api/retirement/manual/check`
(app-server.ts) accepts the FULL plan + account list in the request body itself, computes, returns
`CheckResult`, and touches disk or any module-level variable NOT AT ALL -- mutation-checked directly
(temporarily added a `writeFireConfig` call to the route, confirmed a dedicated route test catches
it, removed it again).

**Reuses the existing pipeline almost entirely** -- `requirePlan`/`classifyAccounts`/`checkDashboard`
run completely unchanged, just fed a synthetic, in-memory-only `FireConfig` (`{...DEFAULT_DASHBOARD_CONFIG,
...body fields}` for dashboard, `body.accounts.map(a => ({match: a.id, type: a.type}))` for
overrides) instead of one `loadFireConfig` read off disk. New: `manualAccountDataSource`
(manual-account-data-source.ts) -- the third `AccountDataSource` implementation (after Actual's own
live one and file mode's), trivial since there's no external system to wrap at all, just the
request body's own account list echoed back through the interface. `GET /api/account-types` -- a
new, tiny, always-unauthenticated route (plain reference data, `ACCOUNT_TYPE_TRAITS`'s own labels)
manual mode's Add-account type dropdown needs before ANY login has happened, since this mode has no
post-login state fetch to piggyback the type list onto the way Actual/file mode's `GET
/api/retirement/state` already does.

**Client state: two localStorage keys**, `runway.manualMode.active.v1` (a flag `checkSession` reads
on every page load -- the ONLY record of "was I last in manual mode," since there's no server
session to ask instead) and `runway.manualMode.state.v1` (the actual plan fields + account list),
kept separate so exiting the mode drops both together. LocalStorage over sessionStorage/in-memory
was an explicit choice put to the user (AskUserQuestion) rather than assumed -- "may reasonably clear
on refresh, or mirror to localStorage" was the issue's own open framing; chose localStorage. Known,
accepted tradeoff (same one `SKELETON_CACHE_KEY` already lives with elsewhere in this app): this
app's own port changes across a `--dev` restart, and localStorage is origin-scoped including the
port, so this only reliably survives a refresh on the deployed container (fixed port) or an
unrestarted `--dev` session -- not treated as a bug, since the issue itself already called losing
this "reasonable."

**Deliberately minimal UI, not a stub of the real thing to be thrown away later**: a single new
`#page-manual` (index.html) -- one card for birth date/retirement ages/plan-to-age/annual expenses
plus a plain add/remove account list (name, balance, type only -- no allocation/access-age/
contribution editor; every account just takes its type's own defaults, same as any freshly-
classified account with no override elsewhere in the app), one card reusing `renderCheckResult`
(app.js, now takes an optional `containerId` parameter, defaulting to the Retirement page's own
`#checkResult`) completely unchanged for the actual Bridge/Monte Carlo rendering -- the response
shape is identical regardless of which mode produced it, so zero chart code was duplicated. No nav
tab for "manual" -- entered only through the login screen's third radio, landed on via
`activateSection("manual")` directly; both Budget and Retirement nav tabs get `.disabled` in this
mode (neither has anything to show). No suggestions button, no privacy/table-view toggle wiring for
this mode's own chart yet (a known, accepted phase-1 rough edge, low-stakes since manual mode's
numbers are explicitly made-up, not real financial data at risk).

**A real bug caught building this**: `startManualApp` originally called `loadManualAccountTypeLabels()`
(async, un-awaited) then `renderManualAccounts()` synchronously right after -- the account list
rendered before the type-label fetch resolved, showing each account's raw type key ("brokerage")
instead of its real label ("Taxable brokerage / investment account") on a restored (localStorage)
account list, with no later re-render to ever pick the label up. Caught live (Playwright screenshot
comparison before/after), fixed by awaiting the label fetch before the first render.

**Suggested phase breakdown from the issue itself** (2, 3, 4 not yet started): a richer per-account
editor (allocation, access age, custom return, contribution -- phase 2); CSV/TSV upload to seed the
list from #34's existing parser, values then fully detached from the file (phase 3, already scoped
in the issue as "a convenience, not a data source" -- never remembers a path or re-reads); nothing
else specifically deferred to phase 4 beyond what's already live (the issue's phase 4 was "login-
screen wiring," done here as part of phase 1 instead since it was needed for the minimal end-to-end
slice itself to be reachable at all).

**Explicit non-goals, per the issue**: public multi-tenant hosting, shareable scenario links, and
saving/returning to a scenario later (explicitly ephemeral by design) are all out of scope for this
epic entirely, not just deferred to a later phase.
