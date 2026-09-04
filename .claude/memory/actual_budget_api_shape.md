---
name: actual-budget-api-shape
description: Live REST API shape of the self-hosted Actual Budget wrapper these scripts call
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5809572f-3c7a-469d-b142-d0b41ca0bf68
  modified: 2026-09-04T22:41:00.939Z
---

`AB_BASE_URL`/`AB_BUDGET_ID`/`AB_API_KEY` (from `.env`, not committed) point at a
self-hosted "actualbudget-api"-style REST wrapper (`.../v1`), not the
official `@actual-app/api` package. Both `src/set-budget.ts` (which replaced `balance-to-zero.sh`, see
[[set-budget-migration]]) and `match-uncleared.sh` talk to it with the
`x-api-key` header. The unprefixed `BASE_URL`/`BUDGET_ID`/`API_KEY` names
were retired on 2026-09-04. `DRY_RUN` (unprefixed) was deliberately kept
un-namespaced per the user: they use `DRY_RUN` as a universal convention
across every tool they build, not specific to this project.

Confirmed live shape (all amounts in cents):
- `GET /budgets/{budgetId}/categorygroups` → `{ data: [{ id, name,
  is_income, hidden, categories: [{ id, name, is_income, hidden,
  group_id }] }] }` — category **groups** = "parent categories"; only
  endpoint that returns group names (the months/categories endpoint below
  only has `group_id`, not the name).
- `GET /budgets/{budgetId}/months/{month}/categories` → for a normal
  (non-income) category: `{ id, name, is_income: false, hidden, group_id,
  budgeted, spent, balance, carryover }`. `spent` is negative for outflows.
  `balance` is NOT always `budgeted + spent` — when a category has
  `carryover: true`, `balance` also includes rollover from prior months, so
  "zero the balance" must use `newBudgeted = budgeted - balance`, not
  `newBudgeted = -spent` (the latter silently fails to zero carryover
  categories — this was a real bug found and fixed in `balance-to-zero.sh`
  this session). **An income category (`is_income: true`) has a completely
  different, incompatible shape**: `{ id, name, is_income: true, hidden,
  group_id, received }` — no `budgeted`/`spent`/`balance`/`carryover` at
  all. Any code that reads those fields unconditionally across all
  categories will get `undefined` for income ones (e.g. `computeBalanceBudget`
  → `NaN`). `set-budget.ts` now excludes income categories entirely before
  that math ever runs — see [[set-budget-migration]].
- `PATCH /budgets/{budgetId}/months/{month}/categories/{id}` with body
  `{ category: { budgeted: <cents> } }` to set a category's budgeted
  amount for that month.
- Error responses come back as JSON with an `.error` field when present.

**How to apply**: any future tool against this same Actual instance (the
set-budget rewrite, or the possible future FIRE forecasting tool) can reuse
this shape directly — no need to re-probe the API.
