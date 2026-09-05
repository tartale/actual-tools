# actual-tools

Command-line tools for a self-hosted [Actual Budget](https://actualbudget.org)
instance, talking to its REST API wrapper.

## Configuration

All tools read the same environment variables:

| Variable         | Description                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `AB_BASE_URL`    | API base URL, e.g. `http://host:5007/v1`                        |
| `AB_BUDGET_ID`   | Budget (sync) ID                                                |
| `AB_API_KEY`     | API key, sent as the `x-api-key` header                        |
| `DRY_RUN`        | `true` to report changes without writing them                  |
| `AB_BIRTH_DATE`  | Your birth date (`YYYY-MM-DD`), used only by `reports fire`     |

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                             # install deps if needed, then type-check
./actual lint                              # eslint over TypeScript, shellcheck over shell
./actual test                              # unit tests
./actual budget set-values ARGS            # set category budgets
./actual budget anomalies ARGS             # flag categories with unusual spending
./actual transactions match-uncleared ARGS # tag matching uncleared transactions
./actual accounts classify ARGS            # interactively classify accounts for FIRE reporting
./actual reports fire ARGS                 # build a FIRE dashboard for import into Actual
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
| `spent`       | the previous month's actual spending                              |
| `spent-3`     | the average actual spending of the previous 3 months              |
| `spent-12`    | the average actual spending of the previous 12 months             |
| `previous`    | the same amount **budgeted** the previous month                   |
| a number      | exactly that dollar amount, e.g. `500` or `249.99`                 |

The `spent*` actions use actual **spending**, not what was previously
budgeted, and count months with no activity as $0 rather than shrinking the
divisor. `previous` is the odd one out — it copies last month's *budgeted*
figure forward, not its spending.

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
./actual budget set-values -c Groceries spent-3 2026-08    # 3-month average
./actual budget set-values -c Rent previous 2026-08        # copy July's budgeted amount
./actual budget set-values -c "Gym Membership" 49.99 2026-08 # set an exact amount
./actual budget set-values -n -c "Monthly Expenses (Fixed)" spent 2026-08 2026-01
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

## `./actual transactions match-uncleared`

An imported bank transaction sometimes appears twice: once as a pending,
uncleared row, then again as a separate cleared row once it posts, instead of
the same row being updated in place. This finds those pairs — same account, a
similar payee and amount, within 5 days — and tags the uncleared row with
`#cleared` so it reads as already accounted for.

```
./actual transactions match-uncleared [-s YYYY-MM-DD] [-n]
```

- `-s`, `--since YYYY-MM-DD` — only look at transactions on or after this date
  (default: 14 days ago).
- `-n`, `--dry-run` — report what would be tagged without writing anything.
  Also enabled by setting `DRY_RUN=true`.

The match is by *magnitude* only, not direction — a $500 refund can match a
$500 charge — since a pending authorization is sometimes replaced by a
posted amount on the opposite side of a small adjustment. In practice this is
rare enough not to matter for the tool's actual purpose (catching an
early-imported, never-updated row), but it means an occasional false match
between two otherwise-unrelated transactions is possible; review the printed
pairs, especially with `-n` first, before trusting a large `--since` window.

## `./actual accounts classify`

Actual's account API has no account-type field, so this repo can't know on
its own which accounts are retirement, taxable investment, HSA, or debt.
This command interactively asks, once per open account, what kind of
account it is, and writes the result to `accounts.json`. It feeds
`./actual reports fire`, which refuses to run without it.

```
./actual accounts classify [-f PATH]
```

- `-f`, `--config PATH` — path to the classification file to read defaults
  from and write (default: `accounts.json` in the repo root).

For each account you get a numbered choice:

```
Fidelity F5 401k -- current balance $543147.48
  1) retirement-tax-deferred
  2) retirement-roth
  3) hsa
  4) investment-taxable
  5) debt
  6) cash
  7) other
What kind of account is this? [1: retirement-tax-deferred]:
```

The bracketed default is whichever answer wins: an existing entry in
`accounts.json` first, otherwise a guess from the account's name (`401k`,
`Roth`, `HSA`, `Mortgage`, `Brokerage`, and similar patterns). Press Enter to
accept it. **Accounts with no existing entry and no name-based guess show no
default** — you have to type a number; there's no way to skip one.

For accounts classified as retirement, HSA, or taxable investment, there's a
second question — a stock/bond allocation, used by the Monte Carlo widget
(see below):

```
  1) equity-100 (100% stocks)
  2) equity-80 (80% stocks / 20% bonds)
  3) equity-60 (60% stocks / 40% bonds)
  4) equity-40 (40% stocks / 60% bonds)
  5) cash (100% cash)
What's an estimate of the stock/bond mix for this account? [2: equity-80]:
```

Every run rewrites `accounts.json` from scratch, covering every
currently-open account — running it again is the normal way to fix a wrong
answer or pick up a newly-added account, not something to avoid. As long as
an account keeps the same category between runs, any hand-customized
`taxTreatment`, `accessAge`, or `allocationPreset` in the existing file is
carried over as the default rather than being reset — only changing an
account's category resets those to the new category's plain defaults. The
file is written after every account is classified, not just once at the
end, so quitting partway through (ctrl-c or otherwise) keeps everything
answered so far.

### `accounts.json`

A gitignored JSON file (it names your real accounts) mapping an account —
by id — to a category, tax treatment, access age, and (for portfolio
accounts) an allocation preset:

```json
{
  "version": 1,
  "accounts": [
    { "match": "691a0cae-4eed-4cfb-a42d-5878c7bdba88", "category": "investment-taxable", "taxTreatment": "taxable", "accessAge": null, "allocationPreset": "equity-80" }
  ]
}
```

Valid `category` values: `retirement-tax-deferred`, `retirement-roth`, `hsa`,
`investment-taxable`, `debt`, `cash`, `other`. Valid `allocationPreset`
values: `equity-100`, `equity-80`, `equity-60`, `equity-40`, `cash`, or
`null` for non-portfolio categories. This is structured per-account data,
not a scalar, so it's a separate file rather than another `AB_*` environment
variable. You won't normally hand-edit it — `./actual accounts classify`
both reads and writes it.

## `./actual reports fire`

Builds an Actual-native FIRE (Financial Independence, Retire Early)
dashboard from real account and spending data: a net-worth widget, a
trailing-12-month spending widget, a safe-withdrawal-rate "crossover"
projection, and a Monte Carlo retirement simulation — using Actual's own
built-in dashboard widgets rather than reimplementing FIRE math.

```
./actual reports fire -r N [-b YYYY-MM-DD] [-p N] [-o PATH] [-f PATH] [-n]
```

- `-r`, `--retirement-age N` — the age you plan to retire (start drawing
  down your portfolio) at. Required, can be passed multiple times to
  compare retirement ages side by side (see below).
- `-b`, `--birth-date YYYY-MM-DD` — your birth date, used to compute your
  current age. Overrides `AB_BIRTH_DATE` (see below). One of the two is
  required — since a birth date doesn't change, set the env var once and
  skip typing it every run.
- `-p`, `--plan-to-age N` — assume the plan needs to last to this age
  (default: `100`). This exists so you don't have to estimate your own
  lifespan: 100 is a deliberately conservative "the money should outlast
  you" assumption, not a life-expectancy guess. Only override it if you
  want a different assumption.
- `-o`, `--output PATH` — where to write the dashboard JSON (default:
  `fire-dashboard.json`).
- `-f`, `--config PATH` — path to `accounts.json` (default: repo root).
- `-n`, `--dry-run` — print the plan and the JSON without writing the file.
  Also enabled by setting `DRY_RUN=true`.

`AB_BIRTH_DATE` (`YYYY-MM-DD`) is a config env var alongside `AB_BASE_URL`/
`AB_BUDGET_ID`/`AB_API_KEY` — it's personal, not per-run data, so it belongs
in the environment rather than typed on every invocation.

The Monte Carlo widget gets one pot per portfolio account (linked to its
live balance, using the allocation you picked in `accounts classify`) and a
flat 22%/15%/0% tax-deferred/taxable/tax-free withdrawal tax rate. Spending
is split around your retirement age: $0/yr before it (assumes you're living
off other income while still working), then the real trailing-12-month
spend from it onward. If `--retirement-age` is today or in the past, that
collapses to a single always-on phase at the real spend. Everything else
(return model, withdrawal rules, contributions, simulation count) is left
for you to set in Actual's own UI once the widget is open — this only sets
what Actual can't infer on its own.

**Comparing multiple retirement ages**: pass `-r`/`--retirement-age` more
than once (e.g. `-r 55 -r 60 -r 65`) to get one Monte Carlo widget per age,
stacked vertically on the dashboard
page and each labeled with its age (e.g. "Monte Carlo — Retire at 60"). This
isn't a single overlaid chart — Actual's dashboard has no way to compare
multiple Monte Carlo configs on one chart, each widget holds exactly one —
but stacking them on the same page is the closest real comparison the
widget model supports.

**Monte Carlo Analysis is an experimental Actual feature** — enable it under
Settings → Advanced → Experimental features → Monte Carlo Analysis Report,
or the imported widget won't render. It's also a newer feature than the
other three widgets, so its shape could still change.

**Refuses to run without an `accounts.json`** — run `./actual accounts
classify` first. It also refuses to run if no account classifies as
retirement/HSA/investment-taxable, since that almost always means the
classification needs attention, not that the answer is "no portfolio."

**This does not talk to Actual's dashboard feature directly** — there is no
API for that today (confirmed against both `@actual-app/api` and this
repo's REST wrapper). Instead it writes a JSON file in Actual's own
dashboard-export format, which you import yourself:

1. Open your budget in Actual and go to the Reports/Dashboard tab.
2. Create a **new, empty** dashboard page (e.g. name it "FIRE").
3. On that page, open the **"..."** menu → **Import**, and pick the file.

**Import replaces every widget already on the target page** — there's no
merge mode. Always import onto a page you're fine wiping (Actual's own
undo/ctrl-z covers a bad import), never your main dashboard. Re-running
`reports fire` and re-importing onto that same page is the normal way to
refresh it, not a mistake to avoid.

```sh
./actual reports fire -r 60                # AB_BIRTH_DATE set in the environment
./actual reports fire -r 55 -r 60 -r 65    # compare three retirement ages
./actual reports fire -r 60 -n             # preview without writing
```

## Layout

```
actual                   task dispatcher, the entry point for everything
lib/cli-format.sh        shared bash help-text formatting, used by actual
src/                     TypeScript sources and their tests
  actual-helpers.ts      typed Actual REST client + pure helpers
  anomaly-detect.ts      pure MAD-based outlier detection, no API dependency
  cli-format.ts          shared TypeScript help-text formatting
  fire-accounts.ts       account classification: heuristics + accounts.json overrides
  fire-dashboard.ts      builds Actual-native dashboard widget JSON (vendored widget types)
  set-budget.ts          executable CLI
  anomalies.ts           executable CLI
  match-uncleared.ts     executable CLI
  accounts-classify.ts   executable CLI
  reports-fire.ts        executable CLI
  *.test.ts              vitest unit tests
eslint.config.js         flat config, type-aware rules via typescript-eslint
```

Every `--help` in this repo (`./actual`, `./actual budget`, and each subcommand)
renders in the same style: a bold `Usage:` line and labelled sections, colour
applied only when the output is a real terminal (never when piped or
redirected). `src/cli-format.ts` does this for the TypeScript CLI via
`node:util`'s built-in `styleText`; `lib/cli-format.sh` does the bash
equivalent for `actual`'s own help. Neither needs a dependency.

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
