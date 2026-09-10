---
name: app-budget-section
description: "Design/status of ./actual app's Budget section -- the category+month picker, its month roll animation, hidden-category handling, and the browser-driven bugs found building it"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-10T04:45:11.261Z
  originSessionId: e2895bd5-4b33-4a55-8b6d-f01dc8ec722d
---

`./actual app` gained a **Budget** section (nav order: Budget / Transactions
"Planned" / Retirement, with Budget the default landing page). It is the web
equivalent of `./actual budget set-values` and `./actual budget anomalies`,
sharing `src/budget-tools.ts` with both CLIs so there is one implementation
rather than two drifting apart.

**One picker, one action list** (2026-09-10). This started as two tabs, Set
Values and Anomalies, each with its own copy of the same category/month grid
and its own separate selection to make. They were merged: finding anomalies is
now just another entry in the Action list, over the same months and categories
as everything else. `BUDGET_PICKERS` (a map keyed `budget`/`anomaly`, threaded
through every picker function as a `key` parameter) collapsed to a single
module-level `PICKER`, and the element ids that used to live on each entry
(`tableId`/`stripId`/`menuId`) are named where they're used -- there is exactly
one of each in the markup now. The buttons follow the selected action:
set-values actions get Preview/Apply, the anomalies action a single Find
button, since a read-only action has nothing to preview. Changing the action
clears any result on screen -- a result describes the run that produced it,
and leaving it up beside a different action would misattribute it.

The card also carries the section's own `<h1>Budget</h1>` in its head and runs
flush to the top of the page: the separate `.page-head` block (title plus a
description) is gone, so the Action list is the first thing on the page rather
than the third. The top gap moved off `main` and onto `.page-head`/`.top-error`
themselves, as *padding* not margin -- a top margin on main's first child would
collapse straight out through main's now-zero top padding. Retirement still has
its own `.page-head` and is unaffected.

**Watch for this when collapsing that kind of indirection**: dropping
`tableId`/`stripId`/`menuId` from the picker object left six
`document.getElementById(picker.tableId)` calls resolving to `undefined` ->
`null`, which threw on first render and left the page stuck on "Loading…".
`app-ui/` is neither typechecked nor linted (it's a static asset, excluded in
eslint.config.js), so nothing caught it but the browser tests -- which failed
exactly as they should have, all six at once.

**The picker is a real budget grid, not a form.** Foldable group rows,
a checkbox per category and per group, and a Budgeted/Spent/Balance triplet
per month, styled after Actual's own budget page. Three months are on screen
(`PICKER_VISIBLE_MONTHS`); a 24-month strip above it (`STRIP_MONTHS`) moves
the window. Which months the *action* covers is deliberately separate from
which months are *on screen*: months are picked by clicking the column
headers (shift-click extends a span), so scrolling around to look at history
never silently changes what a Preview/Apply would touch.

**An empty category selection is refused over the web** (400 from
`/api/budget/set-values`), even though `setBudgetValues` itself still treats
an empty filter as the CLI's documented unfiltered sweep. With a checkbox per
category, nothing checked reads as "I haven't picked yet", not as "sweep the
entire budget". The route rejects it; the CLI is untouched.

**Hidden categories**: `fetchBudgetTable` passes Actual's own `hidden` flag
through on both groups and categories rather than filtering them server-side,
so the header's ⋮ menu can toggle them on without a refetch. They are out of
the grid by default (hidden in Actual precisely because they aren't part of
day-to-day budgeting) and, when shown, are dimmed + italic + carry an eye-off
glyph (the privacy toggle's own icon from index.html, permanently slashed).
Three signals, not just dimming, because dimming alone collides with
`.bt-zero`'s already-dimmed figures -- an all-zero visible category and a
hidden one would otherwise look identical. The glyph marks whichever thing
actually carries the flag (the group header for a hidden group, the row for a
hidden category); a hidden group's categories inherit only the dimming, so
the icon isn't repeated down every row.

## The month roll (2026-09-10)

Moving the window **rolls sideways through every month in between**: going
from May 2026 back to November 2025 shows May leave to the right while April
arrives from the left, then March, then February, until November lands in the
first column. This replaced an earlier animation that only ever offset the
*destination* block and slid it into place -- by construction it could not
show intermediate months, because they were never rendered at all.

Implementation (`rollThroughMonths`/`tweenScrollLeft` in `app.js`):
- One request covers the whole journey (old window start .. new window end),
  so each month passing by shows its own real figures, and the three months
  landed on are sliced client-side out of that same payload (`windowSlice`)
  rather than costing a second round trip.
- The journey renders as one over-wide table (`bt-filmstrip`) inside the
  wrapper's existing scrollport, and is **genuinely scrolled** (`scrollLeft`
  tweened over rAF), not transformed. This is not a stylistic choice:
  `position: sticky` answers to scrolling and not to transforms, and sticky
  is what holds the Category column still while the figures travel past it.
- Eased in-and-out, not ease-out: a plain ease-out spends the whole journey
  decelerating, which blurs the months in the middle.
- Timing is per-month and clamped -- `ROLL_MS_PER_MONTH` 190,
  `ROLL_MIN_MS` 460, `ROLL_MAX_MS` 1800. These are the knobs to tune; the
  user has already had this animation retuned twice for being too subtle.
- Every load carries a sequence number (`picker.loadSeq`); anything resuming
  after an `await` checks it, so rapid clicking abandons the superseded roll
  instead of racing two animations and two responses to the same grid.
- `prefers-reduced-motion` is honoured **in JS**, by landing with no journey
  at all -- the movement is a scripted scroll, so a CSS override can't reach
  it.

`BUDGET_TABLE_MAX_MONTHS` went 3 -> 24 for this: it is now a safety cap, not
the view size, sized to the strip's own span because that is the widest the
UI can ask for (a 21-step jump plus the 3 months landed on).

## Real bugs found here, all by driving a browser rather than by reading code

- **The ⋮ menu could never open.** Its position was measured before it was
  unhidden, and a `display: none` element has no `offsetParent` -- reading
  one threw and killed the handler before `menu.hidden` was ever set. Two
  reported symptoms ("the menu is hidden", "Toggle hidden categories doesn't
  work") were this one bug. Unhide first, then measure, in the same
  synchronous block.
- **Both tab handlers fired on Budget's tabs.** Budget's tabs carry
  `class="tab"` for styling plus `data-budget-tab`; the Retirement handler's
  bare `.tab` selector matched them, built `getElementById("panel-undefined")`
  -> null -> threw -- *after* it had already stripped `.active` from every
  `.panel` on the page, leaving Retirement blank once you switched back.
  Handlers are now keyed off `[data-tab]` and scoped to their own section's
  panels.
- **`display: flex` on a `<td>` breaks `position: sticky` on it.** The cell
  stops generating a table-cell box, lands in an anonymous cell, and sticks
  to that instead of the scrollport -- during a roll the group names scrolled
  away while every category name stayed put. The flex moved to an inner
  `<div>` (`.bt-group-name`).
- **`overflow: hidden` does not stop an over-wide child feeding intrinsic
  sizing.** The filmstrip's 3667px width counted toward the wrapper's
  max-content contribution, which travelled up the grid and stretched
  `<main>` to its own max-width mid-roll, pushing the card's buttons off the
  right edge. Fixed with `contain: inline-size` on `.budget-table`.
- **The app served its UI files with no cache headers at all** -- no
  Cache-Control, no ETag, no Last-Modified -- so a browser could apply
  heuristic freshness and reuse `app.js`/`style.css` without asking. That
  silently defeats the page's own hot-reload (it reloads on a new build id
  and is handed the same stale assets) and lets the two drift apart, since
  they cache independently. Now `no-store`, with a test asserting it.

**Debugging lesson worth keeping**: three plausible-sounding hypotheses for
"the animation isn't working" (reduced motion, stale cache, a Firefox/CSS
incompatibility) were all wrong, and each cost a round trip. What actually
resolved things was driving the real browser and reading `pageerror` --
both of the first two bugs above announced themselves as an uncaught
exception the moment a browser was pointed at the page. **Check page errors
before theorising.** The eventual answer to that particular report was that
the animation ran correctly and was simply too subtle to see; exaggerating it
(a deliberately slow, obviously-wrong debug setting) was what let the user
see what it was actually doing and then specify what they wanted instead.

**Why**: the picker's separation of "months on screen" from "months the
action covers", the refusal of an empty selection, and the roll's use of real
scrolling are all decisions that look arbitrary in the code and are expensive
to rediscover.

**How to apply**: unit tests cover the server side (`hidden` pass-through,
full-span fetches, the empty-selection 400, the `no-store` header --
`budget-tools.test.ts`/`app-server.test.ts`). The client-side behaviour above
is covered by `src/browser-tests/app-ui.test.ts`, which drives a real browser
against a real server: one case per bug listed here. 407 tests total.

**The harness is simpler than it looks, and that is the useful part**: no stub
Actual server is needed, because `startAppServer` runs *inside* the vitest
process, so its outbound calls are stubbed with `vi.stubGlobal("fetch", ...)`
exactly as `app-server.test.ts` already does. Only the browser is
out-of-process. It skips itself with a warning when Playwright's browsers
aren't installed (mirroring `./actual lint`'s missing-shellcheck behaviour),
and it typechecks under its own `src/browser-tests/tsconfig.json` so the DOM
lib those in-browser callbacks need never reaches the Node-only code -- adding
`dom` to the root `lib` would let `document` compile inside `app-server.ts`.

**Every one of those tests was mutation-checked**: each bug was deliberately
reintroduced and the matching test confirmed to fail (and, for the roll, that
disabling the roll entirely fails it rather than passing on the end state
alone). Worth repeating for anything added here -- an end-state-only
assertion would have passed against the very implementation this feature
replaced.

See [[sandbox-toolchain-policy]] for how Playwright is set up here, and
[[fire-dashboard]] for the app's Retirement section.
