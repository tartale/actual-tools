---
name: detached-mode
description: "Issue #38's standalone FIRE calculator -- a whole separate server deployment (AB_MODE=detached, its own port), not a runtime login choice; fully client-held state, server-side-enforced isolation; unified onto the real Retirement page's own rich editor 2026-09-22"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T00:00:00.000Z
---

**Unified onto the real Retirement page 2026-09-22, same day as the AB_MODE rework above** -- before
starting phase 2 (a richer per-account editor for detached mode), the user asked to maximize code
reuse between linked/file and detached mode first, both logic and UI. An audit found detached mode's
own bespoke `#page-detached` (a ~30-line minimal editor: name/balance/type only) shared ZERO code
with the real Accounts editor (`renderAccounts()`, ~400 lines: allocation, expected return/
volatility, withdrawal tax rate, contribution limits, SEPP, Rule of 55, debt/mortgage payoff,
drag-reorder) or the Plan/Expense Projection/Simulation Settings/Retirement income cards. The user
chose (AskUserQuestion): unify now, and let detached mode gain the full rich editor as a direct
result -- this pass effectively **is** phase 2, not a separate later step.

**Core mechanism**: every mutating linked/file-mode route already re-reads config, applies a change,
and returns a fresh `StateResponse` via `buildState` (the same shape `GET /api/retirement/state`
returns). Split `buildState` into a thin disk-reading wrapper plus an exported
`buildStateFromConfig(dataSource, fireConfig, irsLimits, federalTaxBrackets, irsLifeExpectancy,
balanceMode)` holding the pure computation (mirrors the same `loadFireConfig`/`parseFireConfig`
split in `fire-accounts.ts`). A new stateless `POST /api/retirement/detached/state` route builds a
synthetic `FireConfig` from the request body (via `parseFireConfig`, reusing every validation rule
disk-backed configs already get, for free) and returns `buildStateFromConfig(...)` -- a real
`StateResponse`, byte-for-byte the same shape linked/file mode gets. The client's existing, UNMODIFIED
`STATE`/`render()`/`renderAccounts()`/`renderSimSettings()` machinery then points at this route
instead of disk, so the entire rich editor works in detached mode with no UI code duplicated at all.

**Client-side draft replaces the old minimal `DETACHED_STATE`**: `DETACHED_DRAFT` is a full
FireConfig-shaped `{dashboard, accounts}` object, still purely browser-held (mirrored to
localStorage only, same `runway.detachedMode.draft.v1` convention as before, just a different key
name/shape). `loadState()`/`patchPlan()`/`patchAccount()`/`reorderAccounts()` each gained a
`ACTIVE_DATA_SOURCE_MODE === "detached"` branch that merges the edit into `DETACHED_DRAFT` locally,
saves it, then POSTs the WHOLE draft to `/detached/state` to get a fresh `STATE` and re-render --
same call signature/return shape every existing call site already expects, so none of the ~20
`patchPlan`/`patchAccount` call sites throughout app.js needed to change. `runCheck()` got the same
kind of branch (POST `/detached/check` instead of `GET /api/retirement/check`). Account
add/remove reuse the real Accounts card's own Add-account field (extended to detached mode, not
just file mode); remove is NEW (linked/file mode has no per-account delete UI at all -- an Actual/
file account is only ever closed externally -- but every detached account is client-invented, so
"undo the add" is a real, useful action there that isn't reachable any other way).

**`getBalances` gained a third `"uncached"` mode**: detached-mode account ids are freshly minted per
add (`detached-${Date.now()}-...`) and the balance is already known synchronously from the request
body, so routing them through the shared, NEVER-EVICTED `balanceCache` Map would leak forever on a
long-running server for zero caching benefit. `"uncached"` bypasses that Map entirely (neither reads
nor writes it); confirmed via mutation-check that `"cached"` (the real mistake to guard against)
fails the corresponding test, while `"uncached"` and `"fresh"` are behaviorally identical from a
single HTTP response's own perspective (the cache-Map-growth property itself isn't independently
observable at the route-test level, so that specific property was verified by direct code review
instead).

**Rejected: a server-held `let detachedSession` module variable** (mirroring
`fileDataSourceSession`'s own pattern) -- even a never-disk-persisted server variable is still
server-HELD state shared across every browser/tab/concurrent user hitting the same server, breaking
both "data lives only in the browser for that session" and the "safe to deploy more publicly later"
claim. Every detached-mode request is genuinely stateless instead -- the client resends the whole
draft on every state-changing action.

**`#page-detached` is gone entirely** -- detached mode now boots straight into `#page-retirement`
(`checkSession`'s detached branch: `applyDataSourceMode("detached")` + `loadDetachedDraft()` +
`startApp()`, the exact same `startApp()` linked/file mode already calls -- no bespoke detached boot
function needed at all, since `activateSection`'s existing "Budget disabled → fall back to
Retirement" logic already handles landing on the right page once `applyDataSourceMode("detached")`
marks Budget `.disabled`). The nav is no longer hidden either (the old `nav.sections[hidden]` CSS
rule and its `.sections.hidden = true` call are both gone) -- Budget just shows disabled, same
treatment file mode already got, rather than the whole nav vanishing. `renderCheckResult`'s
`containerId` parameter (only ever needed to target `#detachedCheckResult` separately) is gone too,
now hardcoded to `#checkResult` since every mode renders into the one shared container.

**`fileModeAnnualExpenseField` was pulled out from under `fileModeSpendSourceField`** in index.html
(previously nested inside it) so detached mode can show just the manual dollar figure without also
showing the Manual/Transactions radio group it has no use for (it can never have a transactions
file) -- same "reveal only what applies" pattern `renderSimSettings` already used for file mode.

**`src/browser-tests/detached-mode.test.ts`** was rewritten (not just renamed) to drive real
Retirement-page elements (`#birthDate`, `#accountsList .account-row`, the real Add-account panel,
the account row's own `select[data-field='type']`) instead of the old `#detached*`-prefixed ones.
One non-obvious timing gotcha hit while writing it: after editing an account's type/allocation via
the real row (which triggers `scheduleRecheck`'s 500ms debounce), `waitForSelector("#checkResult
.findings-group")` alone is NOT enough to prove the edit took effect -- a findings-group already
exists from the page's own boot-time check (which ran against the account's ORIGINAL type). Fixed
by polling for the SPECIFIC expected content (`expect.poll(...).toContain("Monte Carlo")`) rather
than mere element existence -- the same "avoid a weak assertion that can pass on stale/transient
state" lesson this session already hit once with `.not.toBe()`, recurring in a new shape.

**Verified live** (Playwright against a freshly restarted `--dev` detached server): added an account
through the real Accounts card, set its type/allocation, confirmed a real Bridge chart + Monte Carlo
fan chart render with correct dollar figures, confirmed the per-account Remove button appears only
in detached mode. **Regression-checked linked mode** (`--dev` linked server, already in file mode
with real accounts.csv/transactions.csv loaded from prior testing) the same session: zero
`[data-remove-account]` buttons leaked into file mode's own account rows, Add/Export account
buttons still show, Budget tab still disabled the same as before -- confirms the shared-gate changes
(`ACTIVE_DATA_SOURCE_MODE === "file" || ACTIVE_DATA_SOURCE_MODE === "detached"`) didn't alter file
mode's own behavior.

**Direction changed 2026-09-22, same day as the first phase shipped** -- phase 1 (below, "Original
design") built this as a THIRD LOGIN RADIO ("Enter manually," alongside Sync with Actual/Import
files), chosen at runtime on a normal "linked" server. The user redirected it into something
architecturally different: **a whole separate SERVER deployment**, selected by the `AB_MODE`
environment variable (`"linked"` | `"detached"`) at process startup, not a per-request/runtime
choice at all. Two independent, always-on deployments now exist side by side: linked (today's app,
unchanged) on its own port, detached (the calculator) on its own port. The login-radio version was
fully removed the same day it changed direction -- see "What changed in the rework" below for the
concrete diff between the two designs, since a lot of phase 1's own code survived, just renamed and
re-wired to a different boot trigger.

**Port scheme (4 fixed ports, one per mode × container/--dev combination)**:
- `4276` -- linked, container (unchanged from before this existed)
- `4277` -- detached, container (new)
- `4278` -- linked, `--dev` (moved from the old single dev port, 4277)
- `4279` -- detached, `--dev` (new)

`./actual`'s own `defaultPort`/`containerNameForMode`/`composeServiceForMode` helper functions are
the one place this 4-way mapping is computed, so `serviceStart`/`serviceStatus`/`serviceStop` can't
drift from each other. `compose.yaml` has two services now (`app` / `app-detached`, container names
`actual-tools` / `actual-tools-detached`), each with its own fixed `AB_MODE` env var baked in (not
user-overridable per environment the way `AB_PORT`/`AB_DATA_DIR` are -- which mode a service runs is
the whole reason it's a separate compose service). `service stop` had to move from `docker compose
down` (whole-project teardown, including the shared network) to `docker compose rm -sf <service>`
(scoped to one service) once a second long-running service existed in the same compose project --
`down` while linked was still running would have taken its network out from under it.

**The server-side MODE gate is the real architectural point, not the login-screen change** -- issue
#38's own "safe to deploy somewhere more public later" claim for detached mode depends on the
SERVER actually refusing every Actual/file/config-backed route, not just the client hiding buttons
for them. Implemented as an ALLOWLIST (not a blocklist) right near the top of `handleRequest`
(app-server.ts): in detached mode, only `/api/retirement/detached/check`, `/api/account-types`,
`/api/mode`, `/api/dev/build-id`, and static file serving are reachable -- everything else 404s. An
allowlist over a blocklist deliberately: a new route added later is unreachable in detached mode BY
DEFAULT unless someone remembers to add it to the allowlist, not exposed by default and only caught
if someone remembers to gate it. Mutation-checked directly (temporarily neutered the gate, confirmed
a dedicated route test catches every one of ~10 blocked routes, restored it).

**What changed in the rework, concretely** (vs. phase 1's original login-radio design):
- `manual-account-data-source.ts`/`.test.ts` → `detached-account-data-source.ts`/`.test.ts`
  (`ManualAccount`/`manualAccountDataSource` → `DetachedAccount`/`detachedAccountDataSource`).
- `POST /api/retirement/manual/check` → `POST /api/retirement/detached/check` (same body shape,
  same stateless design, same reuse of `requirePlan`/`classifyAccounts`/`checkDashboard` unchanged
  -- only the path and the mode-gate wrapping it are new).
- The `#dataSourceModeManual` login radio and `#manualFields` block: deleted outright, not just
  hidden -- `applyLoginFormMode`/the submit handler/`applyDataSourceMode` all reverted to their
  original 2-mode (Actual/file) shape, since detached is no longer reachable through this modal at
  all.
- `MANUAL_MODE_ACTIVE_KEY` (the old "was I last in manual mode" localStorage flag `checkSession`
  used to check first) is GONE entirely -- `GET /api/mode` (new, always-unauthenticated route,
  reads `AppServerOptions.mode`) is now the single source of truth for which mode a page should
  boot into, checked first in `checkSession` before either linked-mode-only round trip. The actual
  plan/account DATA still persists the same way (`MANUAL_STATE_KEY` → `DETACHED_STATE_KEY`,
  unchanged localStorage-mirroring design, same port-scoping caveat as `SKELETON_CACHE_KEY`).
- `#page-manual` → `#page-detached`, every `manual*` id in index.html/app.js renamed to `detached*`
  to match (`manualBirthDate` → `detachedBirthDate`, etc.) -- see git history for the full list
  rather than duplicating it here.
- The nav (`.sections`, Budget/Retirement tabs) is now hidden ENTIRELY in detached mode (a new
  `nav.sections[hidden]{display:none}` CSS override was needed -- another instance of this app's
  own "no global [hidden] rule" gotcha, same class of bug as `.data-source-mode` earlier this same
  session), not just both tabs individually `.disabled` the way phase 1 first tried it -- there's
  nothing else on a detached server for a nav to ever switch to.
- The logout icon becomes **"Clear my data"** in detached mode: resets the local state and
  re-renders `#page-detached` IN PLACE, no `location.reload()` -- there's no other mode/login
  screen to navigate back to on a detached-only server (unlike phase 1's own version, which
  reloaded into a login screen that existed on that same linked server).
- `src/browser-tests/manual-mode.test.ts` → `detached-mode.test.ts`, rewritten (not just renamed)
  since the whole boot mechanism changed: no more login-radio flow to drive, tests now
  `startAppServer({..., mode: "detached"})` directly and assert landing straight on
  `#page-detached.active` with no login modal at all.

**Original design (phase 1, superseded same-day -- kept for history)**: a third "Enter manually"
radio on the normal login modal, entered at runtime; `isManualModeActive()` (a
`runway.manualMode.active.v1` localStorage flag) was what `checkSession` checked first, since
there was no server concept of "detached" at all yet -- the whole server ran in one undifferentiated
mode, and the client alone decided whether to show the calculator. This worked (shipped, merged,
verified live and on the real dev server) but didn't give the strong "safe to deploy this
somewhere more public" guarantee detached mode is meant to have -- the server itself had zero
concept that manual mode should refuse every other route, since nothing distinguished it from
linked mode server-side at all.
