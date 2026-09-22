---
name: expense-projection-type
description: "'Expense Projection Type' (Mean/Median/Hampel Filtered Median) reintroduced 2026-09-22 as a genuinely load-bearing input, after being cut entirely in an earlier session for being write-only dead weight -- see [[bridge-burndown-chart]]'s own 'Sixth follow-up' for that removal"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T00:00:00.000Z
---

**Reintroduced 2026-09-22**, prompted by the user asking directly whether "Expense Projection Type"
still applied (they remembered it from Actual's own crossover-chart widget). It didn't -- see
[[bridge-burndown-chart]]'s own "Sixth follow-up" entry: this field, alongside
`crossoverSafeWithdrawalRate`/`crossoverEstimatedReturn`, was cut entirely earlier this same overall
session for being write-only dead weight (confirmed by grep: read by nothing in fire-analysis.ts/
fire-monte-carlo.ts, only ever written into the exported widget's own `meta`). That removal was
correct at the time and isn't being reversed -- what changed is the user explicitly asked for it
back AS A REAL INPUT this time (AskUserQuestion: "Yes, make it real (Hampel/Median/Mean)" over
leaving it removed), not restored to its old write-only form.

**The algorithm is ported, not reinvented** -- fetched Actual's own
`packages/desktop-client/src/components/reports/spreadsheets/crossover-spreadsheet.ts` directly
from GitHub (raw.githubusercontent.com, MIT-licensed, same vendoring precedent as
[[monte-carlo-vendoring]]'s simulation engine) to get the exact Hampel-identifier constants (1.4826,
the MAD→stddev scale factor for a normal distribution; 3, the outlier threshold) rather than
approximating them. `median`/`mean`/`hampelFilteredMedian`/`projectMonthlyExpense` now live in
fire-generate.ts, exported and directly unit-tested.

**Wired into BOTH spend-computation paths, not just one** -- this is the main design work beyond the
port itself:
- **File/detached mode** (`annualSpendFromTransactions`): buckets qualifying transaction rows by
  real calendar month (however many distinct months fall in the trailing window, including a
  partial current one) into a `Map`, then applies the chosen statistic to `[...map.values()]`.
  Critically, **"mean" deliberately keeps the ORIGINAL `totalSpent/historyMonths` formula** instead
  of `mean(monthlyBuckets)` -- those two differ whenever the window doesn't divide into whole
  calendar months (a partial current month), and every existing plan's numbers already assume the
  original formula. Mutation-checked directly: switching "mean" to use the bucketed path breaks two
  pre-existing regression tests (`sums outflow rows...`, `excludes rows outside the trailing
  window`), confirming the bit-for-bit backward-compat guarantee actually holds.
- **Actual mode** (`trailingAnnualSpend`, called by `spendFromLocalSelection`): previously summed
  each category's own separate average (`averageSpent(history)` per category, then added). Rewrote
  to build ONE combined per-month series across categories first (`monthlySpendSeries` -- summed PER
  MONTH, not per-category-then-summed), THEN applies the statistic to that combined series. This
  refactor was necessary, not cosmetic: `sum-of-per-category-means` happens to equal
  `mean-of-the-combined-series` (linearity of expectation over an equal-length window), so "mean"
  stayed identical either way -- but median/hampel are non-linear, and only the combined-series
  shape lets them mean the same thing regardless of how many categories are selected. `averageSpent`
  itself is untouched (still used by the unrelated `computeHistoricalBudget`, the CLI's own
  "match average spending" budget action) -- only fire-generate.ts stopped calling it.
- **Detached mode's own `/api/retirement/detached/check`** gets this for free through
  `requirePlan`'s existing `expenseProjectionTypeWithOverride` resolution feeding the same
  `fileModeSpend()` helper file mode uses (see [[detached-mode]]'s own "transactions upload" round)
  -- no separate wiring needed, confirmed by its own dedicated route test.

**New `DashboardConfig.expenseProjectionType: ExpenseProjectionType | null`** (NOT `crossover`-
prefixed, unlike its two now-permanently-removed siblings -- this is a fresh field in this app's own
vocabulary, not a naming holdover from the old widget). `null` means "mean" (`DEFAULT_
EXPENSE_PROJECTION_TYPE` in fire-dashboard.ts) -- the exact computation every plan already had.

**UI**: a `<select>` in the Expense Projection card, first in the `#expenseHistoryFields` grid
(same visibility gate as Overall spend scale/Spend history -- meaningless without real spend history
behind it), options `""` (not entered/mean) / mean / median / hampel, patching
`expenseProjectionType` on change like every other Simulation-settings-style field.

**Verified live**, not just via automated tests: real outlier scenario (4 normal months + 1 $50,000
one-off) through the actual dropdown on both the file-mode and detached-mode dev servers -- Mean
$138,960/yr, Median $24,000/yr, Hampel $23,400/yr, matching hand-calculated expectations exactly on
both server-generated numbers AND the rendered Bridge/Monte Carlo charts.
