---
name: monte-carlo-vendoring
description: Vendored actualbudget/actual's own Monte Carlo simulation engine to run it in-app instead of only configuring Actual's widget -- what's vendored, why, the noUncheckedIndexedAccess friction, and current status
metadata:
  node_type: memory
  type: project
---

The user asked how hard it'd be to add Monte Carlo charts directly to the app, then "can we just
copy from the actual open-source code... assuming we're okay with the code drifting (home project,
not a product)." Checked before answering, not guessed: actualbudget/actual is MIT licensed, and
its simulation engine (`monteCarloSimulation.ts`, ~2070 lines) turned out to have exactly one real
runtime dependency outside itself (a trivial constant) plus a sibling data file (real historical
stocks/bonds/cash/inflation returns, 1928-2025, sourced from Damodaran/NYU and BLS) — no React, no
Redux, no loot-core query calls anywhere in the actual math. Confirmed via `gh api` against the
real repo, not assumed.

**What's vendored** (`src/vendor/monte-carlo/`, commit `353e5dd26aa98503b2e88b9b25004c3ea5eeef7d`):
`monte-carlo-engine.ts` and `monte-carlo-historical-returns.ts`, each with a header naming the exact
upstream path/commit/blob SHA, the MIT license (`LICENSE-ACTUAL.txt` alongside them), and every
change from a verbatim copy. Kept close to verbatim deliberately (including the runDetail/
captureRunDetail drill-in machinery this app doesn't wire up yet) so a future diff against upstream
reflects real upstream changes, not our own edits tangled in.

**The *FromMeta functions were kept, not dropped, once a shortcut was found**: this app's own
`MonteCarloPotMeta`/`MonteCarloSpendingPhaseMeta`/`MonteCarloWithdrawalRuleMeta`/
`MonteCarloTaxBandMeta`/`MonteCarloContributionMeta`/`MonteCarloCardMeta` (fire-dashboard.ts) were
already modeled to mirror Actual's own wire format exactly, for building the exported widget --
which means the vendored `monteCarloConfigFromMeta`/`potFromMeta`/etc. work completely unchanged
against them (their meta parameter types were swapped from `@actual-app/core/types/models` to these
own types, both fed by only-optional fields, no structural gap). So `runRetirementMonteCarlo`
(fire-monte-carlo.ts) doesn't derive pot/contribution/spending-phase data independently -- it calls
the EXISTING `buildMonteCarloWidget` to get a meta object, then feeds that straight into the
vendored engine. The widget this app would export and the config it simulates are the exact same
object: they can never disagree about anything Actual itself would also resolve.
`MonteCarloAllocationPreset` is the one type defined locally in the vendored file instead (with the
full upstream union including 'custom'/'custom-mix') since this app's own narrower version of that
name (fire-accounts.ts) deliberately excludes those two values this app never generates, but the
engine's own internal pot type needs the wider union for its own correctness.

**A real gap found by testing, not anticipated**: `buildMonteCarloWidget` sets a pot's `accountId`
but never a `startingBalance` -- Actual resolves that live from the account's real balance the
moment the widget is actually displayed on a dashboard. This app has no equivalent resolution step
once the widget-export round-trip is skipped, so every pot would have silently simulated on the
vendored engine's own hardcoded default (500,000.00) instead of anyone's real money. Fixed in
`runRetirementMonteCarlo` by filling in `startingBalance` per pot from the same `balances` map
`checkDashboard` already builds for the Bridge simulation. Caught and mutation-checked by a test
that uses zero return volatility specifically to isolate "did the real balance make it through" --
reverting the fix makes it fail on exactly 50,000,000 (the engine's own default), confirming the
test actually proves something.

**noUncheckedIndexedAccess friction, and why a nested tsconfig doesn't solve it here**: this
project's root tsconfig sets that flag; upstream's own doesn't, and the vendored engine's array-
indexed access (pot/year/contribution buffers throughout the simulation loop) produced ~136 "possibly
undefined" errors as a result. Tried the same nested-tsconfig trick `src/browser-tests/tsconfig.json`
uses (its own relaxed config, root excludes the directory) -- reverted once it became clear that
trick only works when the root program never imports FROM the isolated directory. browser-tests are
leaf test files nothing else imports; the vendored engine is something the app's own code needs to
call, so `fire-monte-carlo.ts`'s import pulls it back into the root `tsc -p .` program regardless of
`exclude` (exclude only controls a program's own root file set, not files reached transitively via
import from an included file) -- confirmed empirically, not assumed. TypeScript's real mechanism for
"a subtree needs different compiler options AND is depended on by the stricter tree" is composite
project references, which requires actual `.d.ts` emission -- a bigger structural change than
warranted for a project that deliberately has no build step (Node strips types directly). Resolved
by fixing the vendored file itself instead: ~115 non-null assertions (`arr[i]!`) at every access
site, each one loop-bounded or length-guaranteed by construction (never a genuine possibly-missing
value), no restructuring, no renamed variables. Delegated this mechanical pass to a forked agent
(136 near-identical fixes, verified by re-running `tsc --noEmit` to zero, `./actual lint`,
`./actual build`, and the full suite) rather than grinding through it inline.

**`./actual vendor check`** (new command group, `src/vendor-check.ts`): compares each vendored
file's pinned blob SHA against its current upstream blob SHA via GitHub's public, unauthenticated
contents API (no `gh` CLI dependency, no token -- this repo has zero runtime dependencies) -- no
content fetched or diffed, just whether the two hashes still match. Exits 1 on drift, not because
drift is a failure (it's expected and fine per the user's own framing) but because that's the
point of a check command; a manual, on-demand subcommand rather than part of `./actual test`, since
it needs live network access and this repo's test suite is otherwise fully hermetic. Live-verified
against the real actualbudget/actual repo (both "up to date" and, via a temporary corrupted pinned
SHA, "DRIFTED", then restored) rather than only unit-tested.

**Wired into `/api/retirement/check`**: `checkDashboard` (fire-generate.ts) now runs
`runRetirementMonteCarlo` once per configured retirement age (skipped entirely with zero portfolio
accounts -- see below for why -- and otherwise wrapped in the same `try`/empty-on-throw guard as
the existing widget-drift detection, for the same reason: an incomplete "custom" allocation is
Generate's hard stop, not Check's) and exposes the results as `CheckResult.monteCarloResults:
MonteCarloResultEntry[]`, alongside the existing `bridgeResults`. `MonteCarloSummary`
(fire-monte-carlo.ts) is `MonteCarloResult` minus `endingBalances`/`depletionYearBySimulation`/
`totalWithdrawnBySimulation` (one entry per simulation -- 5,000 by default -- and would serialize to
JSON as a numeric-keyed object rather than a real array, being `Float64Array`/`Int32Array`) and
`runDetail` (never populated here); `MonteCarloResultEntry` tags each summary with the
`retirementAge` it was run for, self-describing the same way `BridgeResult` already carries its
own, so the client never has to zip results back up against a separate retirementAges array.
`monteCarloFinding` (fire-analysis.ts) turns each result into prose the same way `bridgeFinding`
does, exposed as `CheckResult.monteCarloFindings` -- 90%/50% success-rate bands for ok/warn/fail are
a defensible planning convention, not a value derived from anything upstream. `CheckResult` also
gained a plain `currentAge` field so the client never has to trust its own possibly-stale
`STATE.currentAge` copy to convert a percentile band's `year` back into an age -- a real race was
possible (runCheck can fire before loadState's own fetch resolves).

**The fan chart** (`renderMonteCarloChart`/`wireMonteCarloTooltip`, app.js) reuses Bridge's chart
scaffolding directly -- same `.bridge-chart`/`.bridge-grid`/`.bridge-axis-label`/`.bridge-tooltip*`/
`.bridge-legend*` CSS classes, same `niceAxisTicks`/`usdCompact` helpers, same crosshair-snaps-to-
the-nearest-whole-age tooltip pattern, same `BRIDGE_SERIES_COLORS` palette by retirement-age index
(cross-chart color consistency: the same age is the same color in both charts on this page). A
`.mc-chart` marker class (no CSS of its own) distinguishes it from Bridge's own instance purely for
selectors -- two of `bridge-chart.test.ts`'s existing tests had assumed `.bridge-chart`/`.bridge-hit`
were unique on the page and needed scoping to `:not(.mc-chart)` once both charts could render
together. Two bands per retirement age (outer = 10th-90th percentile, inner = 25th-75th, the
classic two-tier fan-chart convention) at the dataviz skill's own ~10%/~22% wash opacity, plus a
solid median (50th) line and a direct "N% success" end-label (collision-avoided the same way
Bridge's own end-labels are, past which small multiples would be the right call per the
series-count ladder).

**A real scale-distortion bug, caught by actually rendering it and looking (dataviz skill step 7,
not skippable)**: the first version scaled the Y-axis off the 90th-percentile band's own peak, and
against the user's real (failing) plan, decades of compounding in the lucky tail reached ~$300M
nominal, squashing the median line -- the one that actually answers "does this plan work" -- into
an invisible sliver at the bottom. Bridge hit an analogous problem (`BRIDGE_WINDOW_YEARS`) and the
fix here is the same shape but a different basis: the axis is scaled off the **median's own peak**
(with ~15% headroom), not any percentile band, precisely because a plan with a real chance of
failure typically has a median that itself trends toward zero -- exactly the line that most needs
to stay legible. The 75th/90th bands are still real, still drawn; past the visible scale they're
simply clipped at the top of the plot (an SVG `<clipPath>` around the band/line paths, unique
`id` per chart instance) rather than resized around -- "windowed, not discarded," same principle as
Bridge, the real numbers staying available in the tooltip and finding text regardless. Where two
failing scenarios both end near $0, their end-labels can collide; fixed with a two-pass layout
(forward pass pushes each down clear of the previous, backward pass shifts the whole stack up if
that pushed the lowest one past the bottom of the plot -- caught by an early version of the fix
that pushed the second label proud of the clip rect entirely, silently cutting it off).

**A second, real rendering bug, also only found by looking at the real chart**: the user reported
both charts' "lines going off the chart borders." Traced to `niceAxisTicks` (app.js, shared by
Bridge and this fan chart) -- its tick loop was `for (value <= maxCents + epsilon; value += step)`,
which stops as soon as `value` exceeds `maxCents` WITHOUT pushing that final value, so whenever the
true max doesn't land exactly on a step multiple the top tick ends up one step short (e.g. step=$1M,
a real max of $3.6M topped out at a $3M tick). Every series scaled off that tick then drew part of
its own line ABOVE the visible plot -- clipped by the raw SVG viewBox rather than the intended axis,
which is what "going off the border" actually was. Confirmed empirically before fixing: pulled the
live `/api/retirement/check` response and the rendered `<path>` d-attributes directly, found a
dashed Bridge line with a literal negative y-coordinate. Fixed with a do-while that keeps pushing
ticks until the last one pushed is >= maxCents, guaranteeing the axis always covers the real data.
This was pre-existing (Bridge had it before this session's Monte Carlo work; the fan chart just
inherited the same helper) and had apparently never been hit by any fixture or prior real check,
only surfaced by this session's live data having a max that didn't land on a clean step.

**How to apply**: see `runRetirementMonteCarlo`'s own doc comment for the exact call shape, and
`renderMonteCarloChart`'s own comments for the scale/clip/label-collision reasoning above. See
[[fire-dashboard]] for `buildMonteCarloWidget`/the meta types this reuses, and [[bridge-burndown-chart]]
for the chart-building precedent (domain-windowing, palette validation, hover/tooltip pattern) this
one was built on top of.

**Still generating the monte-carlo-card widget too**: the user explicitly chose, via a
multiple-choice question, to keep Generate producing that widget for now rather than dropping it in
the same round the in-app chart landed -- revisit once the in-app version has been used for a while.
