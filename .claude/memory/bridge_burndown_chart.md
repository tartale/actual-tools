---
name: bridge-burndown-chart
description: "Design/status of the bridge burndown chart on ./actual app's Retirement -> Analyze tab -- why it isn't (and can't be) an Actual dashboard widget, the domain-windowing fix for a real scale-distortion bug, and the dataviz-skill decisions behind it"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-10T20:06:07.282Z
  originSessionId: e2895bd5-4b33-4a55-8b6d-f01dc8ec722d
---

`./actual app`'s Retirement -> Analyze tab now draws the Bridge finding as a
chart, not just prose: one line per selected retirement age, the accessible
balance declining from retirement toward zero (or the end of the plan), with
the still-locked balance as a dashed companion in the same color. See
[[fire-dashboard]] for the Bridge analysis itself (`simulateBridge`,
`bridgeFinding`) that this sits on top of.

**Checked against upstream, not guessed: no real Actual dashboard widget can
render this.** Every one of Actual's 13 widget types (`net-worth`,
`cash-flow`, `spending`, `budget-analysis`, `custom-report`, `crossover`,
`markdown`, `monte-carlo`, `age-of-money`, `summary`, `calendar`, `formula`,
`sankey` -- read from upstream `packages/loot-core/src/types/models/
dashboard.ts`) is a query over the live ledger; `CustomReportEntity` in
particular is *purely* a query spec (`groupBy`/`interval`/`balanceType`/
`graphType`/conditions, no data payload field anywhere) and `formula-card`
computes one number. Neither can carry an arbitrary projected series. So this
chart lives only on the Analyze tab -- there was no dead end to work around,
just a real ceiling on what Actual's dashboard can be asked to show.

**`simulateBridge` (fire-analysis.ts) now emits a `timeline: BridgeYear[]`**
(`{age, accessibleBalance, lockedBalance}`), one point per simulated year from
`retirementAge` onward -- not a reinterpretation, just what the existing walk
already computes at each step, exposed. Ends at `depletionAge` (whatever is
left the moment a full year can't be funded) when the scenario depletes, or at
`planToAge` when it doesn't; never continues past either, so the timeline can
never show a year the simulation didn't actually run. `fire-generate.ts`'s
`checkDashboard` keeps the full `BridgeResult[]` it was already computing
(previously discarded right after `bridgeFinding` read it) and exposes it as
`CheckResult.bridgeResults`, sent over the wire as-is by `/api/retirement/
check` -- `bridgeFindings` is prose derived from these same results, not a
second computation, so the two can never disagree.

**A real bug found only by rendering the real thing and looking at it** (per
the dataviz skill's step 7, not skippable): the first version charted every
scenario all the way to its own natural end, and a scenario whose growth rate
outpaces its spending compounds to genuinely enormous nominal figures over a
40+ year horizon (true, not a bug in the math) -- against the user's real
budget this stretched the Y-axis to $100M while the scenario that actually
depletes (the whole reason this feature exists) sat as an invisible sliver
near $0. **Fix: `BRIDGE_WINDOW_YEARS = 20`** caps how far past retirement a
*non-depleting* scenario is drawn (never a depleting one -- its own line
already stops naturally at the age it runs out, which is the point). A
windowed ("trimmed") line gets no end-dot at all: a plain dot there would
assert "ends here" at an age that isn't actually where the plan ends, and a
label near a mark it doesn't truthfully describe is exactly the anti-pattern
the skill warns about. The reader still gets the real number from the legend,
the tooltip, and the unaffected prose finding below the chart -- the trim
only affects what's drawn, never what's computed or stated in text.

**A shared, neutral reference line** marks a depleted scenario's
`nextUnlockAfterDepletion` (dashed, `--ink-faint`, deliberately not a
categorical or status color -- it names an account fact, not a series),
deduplicated by age so two scenarios sharing the same locked account's access
age don't draw it twice. This is the single highest-value mark on the chart:
it's what turns "the line stops" into "the line stops N years before this
other thing happens," which is the entire bridge-gap story in one glance.

**Palette**: the dataviz skill's reference dark-mode categorical eight
(`references/palette.md`), re-validated with `scripts/validate_palette.js`
against this app's own `--surface` (#141520) rather than trusted from the
skill's own reference surface (#1a1a19) -- all 8 slots passed lightness,
chroma, adjacent CVD (worst 8.4), adjacent normal-vision (worst 19.3), and
contrast. Lives as a plain JS array (`BRIDGE_SERIES_COLORS` in app.js), not
CSS custom properties -- this app is dark-only with no theme toggle, so the
usual rationale for CSS vars (swapping light/dark in one place) doesn't apply
here. Assigned to scenarios by **position** in the retirement-age list, never
by value, so a given age keeps its color for as long as it stays selected.

**Y-axis ticks are generated at a clean step (1/2/2.5/5 x 10^k), not by
dividing a rounded ceiling into N equal parts** -- the more obvious approach
was tried first and produces ugly sub-values (a $5M ceiling / 4 = $1.25M,
which rounds to a not-actually-clean "$1.3M"). `niceAxisTicks(maxCents,
targetCount)` picks the step directly instead.

**Testing**: `fire-analysis.test.ts` gained three timeline-specific cases
(exact year-by-year values for a depleting scenario, length/bounds for a
non-depleting one, the locked-to-accessible handoff at the exact unlock age)
-- mutation-checked by moving the timeline push after the withdrawal instead
of before; all three failed as expected. `src/browser-tests/bridge-chart.test.ts`
drives the real chart in a real browser (critical marker + unlock line for a
depleting scenario, a plain unmarked windowed line for a funded one, a
two-scenario comparison with a legend and a working tooltip, and the
no-chart-when-nothing-to-plot case) -- also mutation-checked (removing the
critical-marker distinction and disabling the window both fail the matching
tests). One real flake found and fixed along the way: `page.mouse.move`'s
OS-level cursor synthesis does not reliably deliver `pointermove` to an SVG
element in headless Firefox -- the fix is dispatching a real `PointerEvent`
directly at the target coordinates instead of relying on simulated hardware
input, which is both more reliable and still exercises the real listener on
the real DOM.

**Why**: the domain-windowing decision in particular looks like an arbitrary
constant (20 years) if re-derived from the code alone -- it exists because a
shared, unbounded time axis across scenarios of very different lifespans
actively defeats the chart's own purpose, confirmed by rendering the broken
version against real data before fixing it.

**How to apply**: `BRIDGE_WINDOW_YEARS`, `BRIDGE_SERIES_COLORS`, and
`niceAxisTicks` all live in `src/app-ui/app.js`, right before `renderFinding`.
See [[fire-dashboard]] for the Bridge/Check analysis this chart visualizes,
and [[app-budget-section]] for the browser-test harness pattern this reuses
(no stub Actual server needed -- `startAppServer` runs inside the test
process, stubbed the same way `app-server.test.ts` stubs it).
