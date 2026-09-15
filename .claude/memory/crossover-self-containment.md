---
name: crossover-self-containment
description: Plan section now owns expense-category selection, the crossover widget's remaining assumptions, and Monte Carlo's withdrawal rule/tax bands locally -- the pinned-fields mechanism (flat scalars and whole objects/arrays alike), and which fields are cosmetic vs. actually feed this app's own simulations
metadata:
  node_type: memory
  type: project
---

The user asked how feasible it'd be to make the app more self-contained, since needing to open
Actual's own crossover/Monte Carlo widget config UI to tune assumptions (then come back to Runway
to see the effect) was exactly the back-and-forth they wanted to move away from. Investigated
before answering: Monte Carlo assumptions were already half self-contained (`monteCarlo*` fields on
`DashboardConfig`, a pinned-fields mechanism that always wins on regenerate over whatever the live
widget says) -- the crossover widget's own assumptions and its expense-category checklist were the
only pieces still requiring Actual's own UI. Scoped as two rounds: category selection first (real
UI work, a picker), then the remaining numeric/enum crossover fields (mechanical, matching the
Monte Carlo precedent already in place).

**Expense-category selection** (`DashboardConfig.crossoverExpenseCategoryIds: string[] | null`,
fire-accounts.ts): null keeps today's implicit default (every non-income, non-hidden category);
set, it takes priority over a live crossover widget's own checklist for BOTH Check's spend
calculation (`spendFromLocalSelection`, fire-generate.ts) and what Generate seeds/pins onto the
exported widget (`mergeWidget`'s crossover-card branch, fire-dashboard.ts) -- same "once set here,
it's authoritative" framing as the Monte Carlo pinned fields, not just a first-run seed. Selected
ids are intersected against the real, currently non-income/non-hidden categories before use (a
stale id from a deleted/hidden category falls out silently rather than erroring the whole run) --
falls back to the live-widget/trailing-12-months path when that intersection is empty, same as null.

UI: a "Use every expense category (default)" checkbox in the Plan section collapses into a
per-category checklist (grouped, from the existing `/api/budget/context` endpoint -- previously
unused by the client, now wired up) when unchecked; toggling any single category autosaves via the
same `patchPlan` round-trip every other Plan field uses. Reuses `.checkbox-label` styling. Real bug
caught building this: this app has no global `[hidden] { display: none }` rule (unlike some
component-library conventions) -- every hideable element needs its own explicit `.foo[hidden]`
rule, and the new `.category-picker-list` was missing one, so unchecking the box didn't visually
reveal the list until that was added.

**The remaining crossover assumptions** (`crossoverSafeWithdrawalRate`/`crossoverEstimatedReturn`/
`crossoverProjectionType`/`crossoverExpenseAdjustmentFactor` on `DashboardConfig`): implemented as
an exact mirror of the Monte Carlo pinned-fields mechanism --
`crossoverAssumptionsWithOverrides`/`pinnedCrossoverFields` (fire-dashboard.ts) parallel
`monteCarloAssumptionsWithOverrides`/`pinnedMonteCarloFields` field-for-field, and `mergeWidget`'s
crossover-card branch applies pinned fields the same way `mergeMonteCarloMeta` already did (a
`for (const field of pinnedFields) meta[field] = generatedMeta[field]` pass after the
existing-vs-generated merge). `CrossoverProjectionType` moved from fire-dashboard.ts into
fire-accounts.ts (alongside the other Monte Carlo enum types) since `DashboardConfig` -- which
lives in fire-accounts.ts -- needed it and fire-accounts.ts cannot import from fire-dashboard.ts
(the dependency only runs the other direction).

**A real asymmetry worth remembering**: three of these four fields (safeWithdrawalRate,
estimatedReturn, projectionType) only affect how Actual's own crossover widget renders --
this app's own Bridge/Monte Carlo math has no "crossover date" concept to feed them into at all.
Pinning them is still worth having (it's what lets Generate seed/repin the exported widget without
ever opening Actual, for anyone who still wants that widget visible there), but don't expect them
to change any number Runway itself displays. `expenseAdjustmentFactor` is the one exception: it
also scales `spendFromLocalSelection`'s own computed spend (Bridge, Monte Carlo, the Current
numbers box all derive from that), the same way it already scaled `spendFromCrossover`'s
live-widget path. `estimatedReturn`'s null already means "auto" to Actual, which happens to
coincide with this app's own "not entered" convention for every override field -- there's no way to
explicitly pin "auto" as distinct from "not pinned," but since auto already is the default, nothing
is lost: pinning only ever adds the ability to force a specific fixed rate.

**How to apply**: see `crossoverAssumptionsWithOverrides`'s own doc comment for the exact
DashboardConfig-field-to-CrossoverCardMeta-field mapping, and `spendFromLocalSelection` (private to
fire-generate.ts) for how the category selection and adjustment factor combine into one spend
figure. See [[bridge-burndown-chart]] for the Bridge/Monte Carlo math these numbers actually feed,
and [[fire-dashboard]] for the wider CrossoverCardMeta/MonteCarloCardMeta shape this extends.

**Still open**: safeWithdrawalRate/estimatedReturn/projectionType still have zero effect unless the
person also keeps re-importing Generate's dashboard.json into Actual -- if Runway's own UI ever
grows a genuine "years to FI crossover" display of its own, revisit whether these three should
start feeding that instead of staying purely cosmetic pass-throughs to Actual's widget.

**Round three -- the withdrawal rule and tax bands, the two fields the original
MonteCarloWithdrawalStrategy doc comment explicitly deferred** ("each withdrawalRule type has its
own multi-field parameter set... and taxBands is an open-ended list -- both stay Actual-UI-only for
now"): closed out on "continue" with no further scoping question, since the shape was already
obvious from the crossover round. Unlike every other pinnable field so far (a flat scalar),
`DashboardConfig.monteCarloWithdrawalRule: MonteCarloWithdrawalRuleMeta | null` and
`monteCarloTaxBands: MonteCarloTaxBandMeta[] | null` are pinned as **whole values** -- a rule's 14
possible parameters only mean anything together with its own `type`, and a tax band is inherently a
list -- but plug into the exact same generic pinning loop
(`for (const field of pinnedFields) meta[field] = generatedMeta[field]`) unchanged, since object/
array values assign through that loop exactly like scalars did. Extended
`PINNABLE_MONTE_CARLO_FIELDS`/`monteCarloAssumptionsWithOverrides` with two more rows rather than
building a second mechanism.

**Real consequence worth remembering, different from every crossover field**: pinning these two
changes numbers Runway itself displays, not just what Generate exports -- `checkDashboard` already
threads `options.monteCarloAssumptions` (the full override-applied object) straight into
`runRetirementMonteCarlo`, so a pinned `withdrawalRule`/`taxBands` reaches the in-app Monte Carlo
fan chart and success-rate findings on Check, the same run that also produces Generate's exported
widget. The crossover fields (safeWithdrawalRate et al.) were cosmetic pass-throughs to Actual's own
widget; these two are the opposite -- genuinely tunable simulation inputs for this app's own chart.

**Type relocation, same reasoning as CrossoverProjectionType**: `MonteCarloWithdrawalRuleType`,
`MonteCarloWithdrawalRuleMeta`, and `MonteCarloTaxBandMeta` moved from fire-dashboard.ts into
fire-accounts.ts (DashboardConfig needs them; the import only runs fire-dashboard.ts ->
fire-accounts.ts, never the reverse). The vendored engine
(`src/vendor/monte-carlo/monte-carlo-engine.ts`) imports these two types directly, so its own import
line had to move too -- a real, if small, edit to a file whose whole philosophy is "verbatim except
documented deviations"; already covered by the existing "meta-type imports swapped to this app's
own types" deviation note in its header, just naming the two additional types now sourced from
fire-accounts.ts instead of fire-dashboard.ts. Vendor-check's own drift detection is unaffected --
it compares upstream's current blob SHA against the pinned one, never this file's local content.

**UI**: one type `<select>` ("not entered"/none/guardrails/ratcheting/floor & ceiling/boundaries)
plus four hidden-by-default parameter blocks (one per rule type, shown/hidden by
`renderWithdrawalRule` based on the selected type -- same reveal-on-selection pattern
`.acct-fields .field.hidden` already used for account-type-conditional fields). Switching type
preserves every other type's already-entered values (verified live: set guardrails' prosperity
trigger, switch to ratcheting, switch back -- the guardrails value was still there) by always
spreading the previous whole object and only touching the one field/the `type` key that changed,
matching the interface's own "kept side by side" comment. Tax bands render as an addable/removable
row list (`from` in cents via the existing money-input formatting, `rate` as a decimal-fraction
percent, both matching every other money/rate field's convention already in this app) with a
plain `band-${Date.now()}-${counter}` id generator -- not `crypto.randomUUID()`, which throws
outside a secure context and this app is deliberately also reachable over plain HTTP from other
LAN devices (see the server's own startup banner).
