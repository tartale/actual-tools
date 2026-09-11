---
name: bridge-burndown-chart
description: "Design/status of the bridge burndown chart on ./actual app's Retirement page -- why it isn't (and can't be) an Actual dashboard widget, the domain-windowing fix for a real scale-distortion bug, the dataviz-skill decisions behind it, the Configure/Analyze tab merge into one foldable-card page, and the Drift->Stale rename"
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

**Follow-up, same day: "withdrawals taxed" removed from the Bridge label, and
a permanent "Current numbers" box added above Generate.** The user asked
directly whether "withdrawals taxed" (the Bridge group's own subtitle) was
correct -- checked against their real config.json: the rate is per-account
(`withdrawalTaxRateFor` in fire-dashboard.ts -- 22% tax-deferred / 15% taxable
/ 0% tax-free-or-none / or a hand-entered override), and their real portfolio
has Roth + HSA accounts at 0%. The blanket phrase overstated it for exactly
that money. Removed outright rather than reworded -- the label now reads just
"Bridge · mean returns, X% inflation"; the per-account rate is still fully
real in the simulation and documented in the README next to the existing
"Withdrawal tax rate" per-account field.

Separately, some of the info Generate's own result shows (portfolio total,
annual spend + its basis, Rule of 55 boosts, debt-payoff spending reductions)
was only ever visible as a side effect of clicking **Download dashboard**,
which also writes a file and triggers a browser download. `checkDashboard`
now computes and exposes all four on `CheckResult` too
(`portfolioAccountCount`/`portfolioTotal`/`ruleOf55Boosts`/`debtPayoffs`) --
every one of them was already a cheap pure function over data `checkDashboard`
had fetched anyway, so this cost nothing extra per Check. A new **Current
numbers** card sits permanently above Generate dashboard, populated by the
same `/api/retirement/check` call `runCheck()` already makes on tab-open and
Refresh -- one network call, one source of truth, no new side effect. The
`.line`/`.line .num`/`.boost` CSS rules had to be un-scoped from `.gen-result`
(they were descendant selectors requiring that ancestor) to work in this new,
separate `.card-body` -- `.boost` also tightened to `.line.boost`, matching
how it's actually applied (both classes on the same element), not a bare
global class.

**Third follow-up, same day: Analyze-tab layout settled, and a real drift-detection gap fixed
along the way.** A run of small, interactive-mode requests (no test/commit between them, per the
user's own instruction, until this batch was checked and committed together):

- Generate dashboard's own result no longer repeats portfolio/spend/boost/debt-payoff lines --
  those live in Current numbers now; Generate's result states only what's actually new (the
  filename, the merge-preserved note, the import steps).
- The Configure/Analyze tab persists across a reload, the same cookie mechanism `activeSection`
  already used (`activeRetirementTab`) -- was previously always resetting to Configure. Restoring
  it also runs `runCheck()` on load when Analyze is the restored tab AND Retirement is the
  restored section (mirroring Budget's own "only lazily load when actually landing on it" guard,
  not an unconditional network call on every page load regardless of where someone ends up).
- Drift findings moved out of Analysis and into their own `#driftResult` box leading the
  **Generate dashboard** card -- regenerating is the fix for every drift finding, so it leads the
  card with the button that does that, instead of sitting next to the unrelated Bridge chart. Empty
  (no placeholder, no "no drift" line -- `container.innerHTML = ""`, and `#driftResult:not(:empty)`
  is what the card's own divider line keys off, so an empty check leaves no stray border either)
  until there's actually something to say.
- The Refresh button moved from Analysis's own card-head to Current numbers' -- it always refreshed
  all three (Current numbers, Drift, Analysis) via one `/api/retirement/check` call, so it belongs
  wherever the button reads most naturally, not necessarily beside the card it happens to share a
  name with.
- Card order is now Current numbers -> Analysis -> Generate dashboard.
- Both loading states (`#analyzeSummary`, `#checkResult`) became a centered spinner + "Loading…"
  (`.panel-loading`/`.spinner`, a `@keyframes spin` respecting `prefers-reduced-motion`) instead of
  left-aligned `.empty-note` text, with `min-height` set on each container (80px / 380px) so the
  loading state doesn't render as a tiny sliver that jumps taller the instant real content arrives.
  `.panel-loading` pulls the same number via `min-height: inherit` rather than repeating it.

**The real bug, reported directly by the user**: added two more retirement ages, and Drift said
nothing, even though the live dashboard still only had the original single Monte Carlo widget.
Traced to two compounding facts, neither of them a slip -- confirmed by reading
`buildMonteCarloWidgets` and both drift checks in full, not guessed:
- `buildMonteCarloWidgets` names a widget bare `"Monte Carlo"` with exactly one configured
  retirement age, and `"Monte Carlo — Retire at N"` once there are two or more -- so adding a
  second age doesn't just need a NEW widget, it changes the ORIGINAL scenario's own expected name
  too. A dashboard generated back when there was one age matches none of the freshly-expected names
  the instant a second is added.
- `detectPotDrift` (access ages) never noticed because it flags an account with NO live pot
  *anywhere*, and the account already has one, from the one original widget -- it has never asked
  "does a widget for this exact SCENARIO exist," only "does this account have a pot somewhere."
  `detectSpendingPhaseDrift`'s own doc comment explicitly said this case was covered by
  `detectPotDrift` instead; it wasn't, and that comment was corrected in the same change (an
  existing test, `"skips a scenario with nothing live yet, rather than flagging it as drift"`,
  already asserted this exact silent-skip as intentional -- correctly so for THAT function's own
  narrow job of comparing spending phases between widgets that both already exist; the actual gap
  was that nothing else was asking the "does the widget exist at all" question).
- Fixed with a new, separate check, `detectMonteCarloWidgetSetDrift` (fire-analysis.ts): compares
  the SET of widget names Generate would produce against the SET actually live, symmetric in both
  directions -- a fresh name with no live match ("warn": you need to regenerate) and a live name
  matching no fresh one ("info": orphaned, remove by hand or let a regenerate replace the page).
  Wired into `checkDashboard` alongside the other drift checks, reusing the same `freshWidgets` the
  existing `detectSpendingPhaseDrift` call already builds.
- Mutation-checked at both layers: removing the `detectMonteCarloWidgetSetDrift` call from
  `checkDashboard` was NOT caught by the existing unit tests (fire-analysis.test.ts) -- they only
  proved the function correct in isolation, not that anything actually called it. Added a
  route-level test (app-server.test.ts) reproducing the user's exact scenario end-to-end (one live
  widget named "Monte Carlo", two configured retirement ages) specifically to close that gap; it
  does fail when the wiring is removed.

**Second follow-up, same day: Target Income % was silently ignored, and it
was live-wrong for the user.** Asked directly whether "Spend" factors in the
crossover widget's own "Target Income %" slider. Checked upstream (not
guessed): that field is `expenseAdjustmentFactor` on the wire, labeled
"Target Income (% of expenses)" in Actual's own `Crossover.tsx`, and Actual's
own `crossover-spreadsheet.ts` multiplies its PROJECTED expense figure by it
(never the raw historical series) to decide its own crossover point. This
app's `spendFromCrossover` (fire-generate.ts) computed a plain trailing
average and never read that field at all -- even though the app already
*displays* it read-only under "Configured in the Actual Dashboard" (`row("Expense
adjustment", ...)` in app.js), so the gap was between showing the number and
using it, not not knowing it existed.

Checked the user's own live settings before calling this hypothetical: their
real Target Income is 90%, not the default 100%, so this had been live-wrong
-- Monte Carlo, Bridge, and the new Current numbers box were all overstating
spend by about 11% (100/90) the whole time. Fixed by multiplying
`monthlyTotal * 12` by `meta.expenseAdjustmentFactor ?? 1` (the `?? 1`
matters: this value came off a live widget fetched as `unknown`, and upstream
itself defaults it the same way -- CrossoverCardMeta's own non-optional type
is a compile-time promise this runtime data was never guaranteed to keep).
`spendBasis` gets a `, × 90% target income` suffix whenever the factor isn't
1, so the adjustment is visible in the same sentence as the number it
changed, not just a silent multiplier. One function fix corrects both callers
(`generateDashboard` and `checkDashboard` both call `spendFromCrossover`),
verified against the user's real budget: $148,812.12/yr (unadjusted) ->
$133,930.91/yr (× 0.9), the exact expected product.

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

**Fourth follow-up, same day: the Configure/Analyze tabs merged into one flat page, then a
round of code-review CRs on the result.** "Sketch it first" (ASCII mockup +
two `AskUserQuestion`s: Drift kept leading Generate dashboard; fold state
persists per-section) preceded implementing it.

- **Tab merge**: the two tabs became 7 foldable `.card[data-section]` sections in one column
  (Plan, Simulation settings, Retirement income, Accounts, Current numbers, Analysis, Generate
  dashboard), each with a `.card-fold-toggle` (▼/▶) + `.card-fold` wrapper, an Expand
  all/Collapse all control where the tab bar used to be, and per-section fold state in a
  `retirementCollapsed` cookie (`RETIREMENT_SECTIONS`/`DEFAULT_COLLAPSED_SECTIONS`/
  `setSectionFolded`/`saveSectionFolds`/`applySectionFolds` in app.js). `activateSection`'s
  `retirementChecked` flag still gates `runCheck()` to once-per-landing, not on every nav away
  and back to Retirement -- folding a section was verified to never re-trigger or gate the data
  inside it.
- **CR round 1** (five items from one "looks great, a couple CRs" message): Current numbers +
  Drift moved to the very top of the page (no longer a foldable card); one Refresh button
  (top, beside Expand/Collapse all) replaced two separate ones (`refreshAnalysisBtn` on Current
  numbers, `refreshLiveSettingsBtn` on "Configured in the Actual Dashboard") via a new
  `refreshAll()` that runs both concurrently; "drift" renamed to "stale" client-side and in
  `CheckResult.staleFindings` (detector function names like `detectPotDrift` were deliberately
  left alone -- internal/technical, not the user-facing label); the card-head hint
  right-alignment bug was `.saved-flag`'s `opacity: 0` base state still reserving ~36px of
  layout width even hidden (fixed: `display: none`/`.show { display: inline }`, trading away the
  fade transition); and a debounced `scheduleRecheck()` (500ms, cleared/reset on each call) added
  inside the three functions every edit funnels through (`patchPlan`/`patchAccount`/
  `reorderAccounts`), plus a `checkRequestId` guard in `runCheck()` so an in-flight response from
  a superseded call can never land after a newer one.
- **CR round 2** (six more items, next message: "good breaking point; let's ship it" came right
  after these landed): `./actual service start` silently absorbed an unknown option into a
  `passthrough` array that only `--dev` mode ever consumed -- outside `--dev` it was collected
  and then never used at all, so a typo'd flag looked accepted and did nothing; fixed by erroring
  with usage when `passthrough` is non-empty and `--dev` wasn't passed (a documented option like
  `--no-open` still reaches `--dev`'s own `node ./src/app.ts` call, which validates it itself).
  Default image tag changed from `actual-tools:latest` to `actual-tools:local`, everywhere it's
  named (`./actual`'s `buildImage`/`buildUsage`/`serviceStart`, `compose.yaml`). Current
  numbers/Stale were pulled out of their own card entirely and merged into the summary tile row:
  Portfolio's own tile absorbed the account count inline ("$999,999 (8 accounts)", computed
  client-side from `STATE.accounts` the same way the tile total always was, not from the network
  round trip); Spend/Rule of 55/debt-payoff became plain label/number tiles
  (`renderSummaryStats`, appended to `#summaryTiles` once `/api/retirement/check` resolves,
  replacing any previous dynamic tiles by class rather than accumulating them) instead of full
  sentences ("...from your own crossover widget's selection..." dropped entirely); the "Current
  numbers" heading disappeared along with its card; "Autosaves on change" removed from Plan's
  card-head. New env vars from the containerization round got the same `AB_` prefix as
  `AB_BASE_URL`/`AB_BUDGET_ID`/`AB_API_KEY`: `ACTUAL_DATA_DIR`/`ACTUAL_HOST_ALIAS`/`ACTUAL_PORT` ->
  `AB_DATA_DIR`/`AB_HOST_ALIAS`/`AB_PORT`, renamed everywhere (dispatcher, compose.yaml, .envrc,
  README, this project's own memory). And the duplicate-input-vs-display pattern the user named
  ("'retirement ages' is in the top, but then editable in 'Plan'") applied to all three
  read-only summary tiles that echoed an editable Plan field verbatim -- Current age, Retirement
  ages, and Plan to age tiles were removed outright (Portfolio wasn't touched: it's computed, not
  entered anywhere, so showing it once at the top isn't a duplicate of anything).
- **Two browser tests were stale from the tab merge** and only surfaced when the full suite
  finally ran (interactive mode had deferred that until "let's ship it"): `app-ui.test.ts`'s
  regression test for a `[data-tab]`-scoped click handler asserted against `panel-configure`/
  `panel-analyze`/`.panel.active`, none of which exist anymore -- rewritten to guard the modern
  equivalent risk instead (folding Plan, navigating to Budget and back, asserting the fold
  survived), and mutation-checked by making `activateSection` force-reset Plan's fold on landing.
  `bridge-chart.test.ts`'s `openAnalyzeTab` helper clicked a `[data-tab="analyze"]` that no
  longer exists (Analysis isn't folded by default, so nothing needs opening) and its one
  assertion read `#analyzeSummary` (also gone) -- renamed to `openRetirementPage`, dropped the
  click, and switched the assertion to reading tile text out of `#summaryTiles`.
