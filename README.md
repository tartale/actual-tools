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
| `DRY_RUN`      | `true` to report changes without writing them  |

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                       # install deps if needed, then type-check
./actual lint                        # eslint over TypeScript, shellcheck over shell
./actual test                        # unit tests
./actual budget set-values ARGS      # set category budgets
./actual budget anomalies ARGS       # flag categories with unusual spending
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

Income categories are never updated. A run with no `-c` filter skips them
silently while sweeping every other category; an explicit `-c` that names an
income category or its parent group is an immediate error instead, since
that's a mistake worth surfacing rather than quietly ignoring.

Examples:

```sh
./actual budget set-values balance 2026-08                 # zero every balance
./actual budget set-values -c Groceries previous-3 2026-08 # 3-month average
./actual budget set-values -n -c "Monthly Expenses (Fixed)" previous 2026-08 2026-01
```

This replaces the earlier `balance-to-zero.sh`, whose behaviour is now the
`balance` action.

## `./actual budget anomalies`

Flags categories whose spending in a month deviates sharply from that
category's own trailing 12-month history.

```
./actual budget anomalies -c CATEGORY [-c CATEGORY]... [-t] [-n] yyyy-mm [yyyy-mm]
```

Detection is a modified z-score built on the Median Absolute Deviation (MAD) —
a standard, outlier-resistant technique (Iglewicz & Hoaglin) that isn't thrown
off by a single unusual month elsewhere in the history, unlike a plain
mean/standard-deviation test. A category needs at least 3 months of history to
be judged at all, and the deviation must clear a $50 floor regardless of how
extreme the percentage swing is, so a $2 category jumping to $6 isn't reported
as a 200% anomaly.

Options:

- `-c`, `--category CATEGORY` — category or parent category group to check, by
  name or ID. **Required**, unlike `set-values`; can be used multiple times.
- `-t`, `--tag` — once a category/month is flagged, look at its individual
  transactions and prepend `#anomaly-high` or `#anomaly-low` to the notes of
  whichever one(s) are themselves outliers against that category's own
  historical transaction sizes (the same MAD test, run again at the
  transaction level). If none of them individually clears the bar — the
  excess is spread across several ordinary-looking transactions rather than
  one big one — the single largest transaction in that category/month is
  tagged instead, so a flagged month is never left with nothing tagged.
  Without `-t`, the command only logs what it finds.
- `-n`, `--dry-run` — with `-t`, report what would be tagged without writing
  anything. Also enabled by setting `DRY_RUN=true`.

Income categories are excluded the same way as in `set-values`.

Examples:

```sh
./actual budget anomalies -c Groceries 2026-08                    # a single month
./actual budget anomalies -c Groceries -c Dining 2025-09 2026-08  # a year, two categories
./actual budget anomalies -c Groceries -t -n 2026-08              # preview what -t would tag
```

## `./actual budget match-uncleared`

Finds uncleared transactions that match a cleared one and tags them. Still the
original bash implementation (`match-uncleared.sh`), slated for a TypeScript
port; the dispatcher passes arguments straight through to it.

## Layout

```
actual                   task dispatcher, the entry point for everything
lib/cli-format.sh        shared bash help-text formatting, used by actual and match-uncleared.sh
src/                     TypeScript sources and their tests
  actual-helpers.ts      typed Actual REST client + pure helpers
  anomaly-detect.ts      pure MAD-based outlier detection, no API dependency
  cli-format.ts          shared TypeScript help-text formatting
  set-budget.ts          executable CLI
  anomalies.ts           executable CLI
  *.test.ts              vitest unit tests
match-uncleared.sh       standalone bash tool
eslint.config.js         flat config, type-aware rules via typescript-eslint
```

Every `--help` in this repo (`./actual`, `./actual budget`, and each subcommand)
renders in the same style: a bold `Usage:` line and labelled sections, colour
applied only when the output is a real terminal (never when piped or
redirected). `src/cli-format.ts` does this for the TypeScript CLI via
`node:util`'s built-in `styleText`; `lib/cli-format.sh` does the bash
equivalent for `actual` and `match-uncleared.sh`. Neither needs a dependency.

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
