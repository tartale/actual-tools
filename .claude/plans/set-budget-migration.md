> **Status: implemented on 2026-09-04.** Kept as the record of the design
> decisions; see `.claude/memory/set_budget_migration.md` for what changed
> during implementation (notably the added `--dry-run` flag).

# Replace balance-to-zero.sh with set-budget.ts (TypeScript)

## Context

`balance-to-zero.sh` zeroes out a category's balance for a month range by
setting `budgeted = budgeted - balance`. The user wants a more general
`set-budget` tool with four actions (`balance`, `previous`, `previous-3`,
`previous-12`), sharing logic through a helper module, with tests.

Before implementing, we evaluated language choice. The user raised a second,
forward-looking factor: a possible future FIRE (early-retirement) forecasting
add-on for Actual Budget — either a custom report or a standalone service —
which would almost certainly be built in TypeScript/Node regardless (that's
Actual's own ecosystem and the `@actual-app/api` packages are JS/TS). That
tips the balance: writing `set-budget` in TypeScript now produces a small,
typed Actual REST client (auth, category/month fetch, month math, currency
formatting) that a later FIRE tool could import directly, rather than a
throwaway bash tool that would need to be re-derived in TS later anyway.

Confirmed during exploration: **Node 26 (installed) runs `.ts` files
natively** — direct shebang execution (`#!/usr/bin/env node` on a `.ts`
file), relative imports with explicit `.ts` extensions, interfaces/types
fully erased at runtime. This means:
- No `tsx`/`ts-node`/build step needed to *run* the scripts.
- No `jq`/`curl`/`gdate` system dependencies either — `fetch` and `Date` are
  built in, so `checkDependencies()` from the bash version goes away
  entirely.
- `typescript` and `vitest` are only needed as devDependencies for
  `npm run typecheck` / `npm test`, not for running `set-budget.ts` itself.

This was verified live in `/private/tmp/.../scratchpad`: a `.ts` file with
an interface, a relative `./helper.ts` import, and a `#!/usr/bin/env node`
shebang all ran correctly with no npm install.

**Confirmed semantics** (via user Q&A):
- `previous` sets the budget to a single prior month's actual spending
  (distinct from `previous-3`, not a typo-duplicate of it).
- `previous`/`previous-3`/`previous-12` are based on **actual spending**
  (`spent`, sign-flipped positive) in the prior N months, not on what was
  previously *budgeted*. This mirrors how `balance` already treats spend as
  the source of truth.
- `previous-3`/`previous-12` average N months; missing/nonexistent prior
  months count as $0 spent (rather than shrinking the divisor), same
  approach for all three history actions parameterized by N (1, 3, 12).

**Live API shape** (from `${BASE_URL}` = a self-hosted "actualbudget-api"
REST wrapper, same one `match-uncleared.sh` uses):
- `GET /budgets/{id}/categorygroups` → `{ data: [{ id, name, is_income,
  hidden, categories: [...] }] }`
- `GET /budgets/{id}/months/{month}/categories` → `{ data: [{ id, name,
  is_income, hidden, group_id, budgeted, spent, balance, carryover }] }`
  (amounts in cents; `spent` negative for outflows)
- `PATCH /budgets/{id}/months/{month}/categories/{id}` with
  `{ category: { budgeted } }`

`match-uncleared.sh` stays untouched (bash) — it's a separate tool and out
of scope.

## Approach

**File layout** (flat at repo root, matching the existing bash scripts'
convention):
- `actual-helpers.ts` — shared module (typed API client + pure helpers)
- `set-budget.ts` — executable CLI (`chmod +x`, `#!/usr/bin/env node`)
- `actual-helpers.test.ts` — vitest unit tests
- `package.json`, `tsconfig.json` — devDependencies only (`typescript`,
  `vitest`, `@types/node`); no runtime dependencies
- **Remove** `balance-to-zero.sh` (`git rm`) — full replacement, no
  backward-compat shim, per user's instruction
- `match-uncleared.sh` — unchanged

Naming note to flag to the user: the request said "called set-budget.sh",
but since we're implementing it in TypeScript, the file is `set-budget.ts`
(directly executable, same as the `.sh` scripts are). Will call this out
explicitly when reporting the work as done.

### `actual-helpers.ts` (already drafted to disk during exploration; will be
reviewed/finalized during implementation, not treated as final)

Exports:
- Types: `Category`, `CategoryGroup`, `CategoryMonth`, `ActualConfig`,
  `Action` (`"balance" | "previous" | "previous-3" | "previous-12"`)
- `loadConfigFromEnv()` — reads `BASE_URL`/`BUDGET_ID`/`API_KEY`, throws if
  missing (replaces bash `checkDependencies`, minus the jq/curl/gdate
  checks which no longer apply)
- `formatUsd(cents)` — `-415295` → `"-$4152.95"`
- `validateMonthFormat`, `addMonths`, `monthRange` — replace `gdate`-based
  month iteration with plain `Date` math
- `groupNameById(groups)`, `shouldUpdateCategory(category, filters,
  groupNames)` — port of the `-c` category/parent-group filter matching
- `computeBalanceBudget(category)` — `budgeted - balance`, the `balance`
  action's formula (see fixed carryover bug from prior session)
- `averageSpent(spentAmounts)` — sign-flips and averages an array of prior
  months' `spent` values; used uniformly for `previous` (N=1),
  `previous-3` (N=3), `previous-12` (N=12) via `HISTORY_MONTHS`
- `computeHistoricalBudget(config, categoryId, month, monthsBack,
  monthCache)` — walks back N months, calling `getCachedMonthCategories`
  per month (cache avoids refetching the same prior month across
  categories/target-months in a range) and feeds `averageSpent`
- `fetchCategoryGroups`, `fetchMonthCategories`, `patchCategoryBudget` —
  thin typed `fetch` wrappers, replacing `curl`, surfacing the API's
  `.error` field on failure (parity with existing bash error handling)
- `getCachedMonthCategories` — cache-or-fetch a month's categories
- `formatCategoryLine(month, status, budgetedCents, balanceCents, name)` —
  the log-style line format iterated on this session (status first
  unlabeled/padded, then `month:`/`budgeted =`/`balance =`/`name:`,
  11-char amount columns sized for values up to `999999.99` with sign)
- `confirmViaTty(promptText)` — opens `/dev/tty` directly (parity with the
  bash version's behavior when stdin is piped), loops on y/n/empty

### `set-budget.ts`

CLI: `set-budget.ts [-c CATEGORY]... [-i] ACTION yyyy-mm [yyyy-mm]`

- Manual arg parsing (mirrors the bash `parseArguments` loop: `-c`/
  `--category` repeatable, `-i`/`--interactive`, `--` terminator, reject
  unknown `-*`, 2–3 positionals: action + 1–2 months)
- Validates `ACTION` via `isAction()`; validates month format via
  `validateMonthFormat`
- Only fetches category groups (`fetchCategoryGroups`) when `-c` filters
  are present (parity with current optimization)
- For each month in `monthRange(start, end)`:
  - Fetch (and cache) that month's categories
  - For each category: apply `shouldUpdateCategory` filter; for `balance`
    action only, skip when `spent === 0 && balance === 0` (nothing to
    zero — this early-skip is `balance`-specific, not applied to the
    `previous*` actions, since those should still set a forward budget
    even when this month currently has no activity)
  - Compute `newBudgeted`: `computeBalanceBudget` for `balance`,
    `computeHistoricalBudget` (via `HISTORY_MONTHS[action]`) otherwise
  - If `newBudgeted === budgeted`: print `"Update not needed"` line, skip
  - If `-i`: prompt via `confirmViaTty`; on decline print `"Update
    skipped"` line, skip
  - Otherwise print `"Update applied"` line and `patchCategoryBudget`
  - Print `"All categories updated for month {month}."` per month,
    `"All months processed."` at the end (parity with bash)
- Top-level `main().catch(...)` prints the error message to stderr and
  exits 1

### `actual-helpers.test.ts` (vitest)

Pure-function coverage (no real network calls):
- `formatUsd`: positive/negative/zero/rounding
- `validateMonthFormat`: valid/invalid
- `addMonths`: forward/backward, year-boundary wraparound
- `monthRange`: forward, backward, single-month
- `shouldUpdateCategory`: empty filters, match by id/name/group id/group
  name, no match
- `computeBalanceBudget`: straightforward and carryover-style cases
  (balance ≠ budgeted+spent)
- `averageSpent`: empty, single value, multiple values w/ sign flip,
  rounding
- `formatCategoryLine`: exact padded output string
- `isAction`: valid/invalid strings

Plus a couple of `fetch`-mocked tests (`vi.stubGlobal("fetch", ...)`) for
`fetchCategoryGroups`/`fetchMonthCategories`/`patchCategoryBudget`: happy
path (correct URL/headers/body) and error path (surfaces the API's
`.error` field), matching the bash version's response-shape error
handling.

### `package.json` / `tsconfig.json`

- `package.json`: `"type": "module"`, `devDependencies: { typescript,
  vitest, @types/node }`, `scripts: { test: "vitest run", typecheck: "tsc
  --noEmit" }`. No runtime dependencies — `set-budget.ts` runs standalone.
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`,
  `module`/`moduleResolution: nodenext`, `noEmit: true`,
  `allowImportingTsExtensions: true` (required for tsc to accept the
  `.ts`-suffixed relative imports Node's native runtime needs), targeting
  the erasable-syntax subset (no enums/parameter-properties/namespaces).

## Verification

- `npm install` (dev tooling only), `npm run typecheck` — no type errors
- `npm test` — vitest suite passes
- `chmod +x set-budget.ts`
- Live smoke tests against the real budget (read-mostly, same pattern used
  earlier this session):
  - `./set-budget.ts balance 2026-08` filtered to a single known-balanced
    category → expect `"Update not needed"` line, correct formatting
  - `./set-budget.ts -c "<some category>" previous 2026-08` → expect a
    computed value matching last month's actual spend (verify by cross-
    checking that category's prior-month `spent` via a direct API call)
  - `./set-budget.ts -c "<some category>" previous-3 2026-08` → verify the
    average against 3 direct API calls
  - Confirm `-i` prompts and `-c` group-name/group-id filtering still work
    as established earlier in this session
- `git status` — confirm `balance-to-zero.sh` removed, new files staged;
  `match-uncleared.sh` untouched
- Do not commit/push without explicit request (matches this session's
  established pattern of confirming before each commit)
