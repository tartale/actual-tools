---
name: detached-mode
description: "Issue #38's standalone FIRE calculator -- a whole separate server deployment (AB_MODE=detached, its own port), not a runtime login choice; fully client-held state, server-side-enforced isolation"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T00:00:00.000Z
---

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
