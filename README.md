# actual-tools

Command-line tools for a self-hosted [Actual Budget](https://actualbudget.org)
instance, talking to its REST API wrapper.

## Configuration

All tools read the same environment variables:

| Variable       | Description                                    |
| -------------- | ---------------------------------------------- |
| `AB_BASE_URL`  | API base URL, e.g. `http://host:5007/v1`       |
| `AB_BUDGET_ID` | Budget (sync) ID                               |
| `AB_API_KEY`   | API key, sent as the `x-api-key` header        |
| `AB_DRY_RUN`   | `true` to report changes without writing them  |

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                       # install deps if needed, then type-check
./actual lint                        # eslint over TypeScript, shellcheck over shell
./actual test                        # unit tests
./actual budget set-values ARGS      # set category budgets
./actual budget match-uncleared ARGS # tag matching uncleared transactions
```

## `./actual budget set-values`

Sets category budgets for a month, or an inclusive range of months.

```
./actual budget set-values [-c CATEGORY]... [-i] [-n] ACTION yyyy-mm [yyyy-mm]
```

Actions:

| Action        | Sets each category's budget to…                                  |
| ------------- | ---------------------------------------------------------------- |
| `balance`     | the amount that brings the month's balance to zero                |
| `previous`    | the previous month's actual spending                              |
| `previous-3`  | the average actual spending of the previous 3 months              |
| `previous-12` | the average actual spending of the previous 12 months             |

The `previous*` actions use actual **spending**, not what was previously
budgeted, and count months with no activity as $0 rather than shrinking the
divisor.

Options:

- `-c`, `--category CATEGORY` — only update categories matching this category
  or parent category group, by name or ID. Repeatable.
- `-i`, `--interactive` — ask for confirmation before each update.
- `-n`, `--dry-run` — report what would change without writing anything.

Examples:

```sh
./actual budget set-values balance 2026-08                 # zero every balance
./actual budget set-values -c Groceries previous-3 2026-08 # 3-month average
./actual budget set-values -n -c "Monthly Expenses (Fixed)" previous 2026-08 2026-01
```

This replaces the earlier `balance-to-zero.sh`, whose behaviour is now the
`balance` action.

## `./actual budget match-uncleared`

Finds uncleared transactions that match a cleared one and tags them. Still the
original bash implementation (`match-uncleared.sh`), slated for a TypeScript
port; the dispatcher passes arguments straight through to it.

## Layout

```
actual                   task dispatcher, the entry point for everything
src/                     TypeScript sources and their tests
  actual-helpers.ts      typed Actual REST client + pure helpers
  actual-helpers.test.ts vitest unit tests
  set-budget.ts          executable CLI
match-uncleared.sh       standalone bash tool, no shared code yet
eslint.config.js         flat config, type-aware rules via typescript-eslint
```

## Development

`src/set-budget.ts` runs directly under Node (≥ 22.18) — TypeScript is stripped at
runtime, so there is no build step and no runtime dependencies. The dev
dependencies are only needed for checks:

```sh
./actual build
./actual lint
./actual test
```

TypeScript is held at 5.x because `typescript-eslint` does not yet support the
7.x native port (its peer range caps at `<6.1.0`). The sandbox image is pinned
to the same major via `LANGUAGE_VERSIONS="typescript-5"`.
