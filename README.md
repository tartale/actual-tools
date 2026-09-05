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
| `AB_BIRTH_DATE`  | Your birth date (`YYYY-MM-DD`); overrides `config.json`'s, used only by `reports fire` |

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                             # install deps if needed, then type-check
./actual lint                              # eslint over TypeScript, shellcheck over shell
./actual test                              # unit tests
./actual budget set-values ARGS            # set category budgets
./actual budget anomalies ARGS             # flag categories with unusual spending
./actual transactions match-uncleared ARGS # tag matching uncleared transactions
./actual configure ARGS                    # interactively configure everything reports fire needs
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

## `./actual configure`

Interactively configures everything `./actual reports fire` needs, in one
session, and writes it to `config.json`. Replaces the old
`./actual accounts classify` (account classification is now step one of a
longer flow, not the whole thing).

```
./actual configure [-f PATH] [-d PATH]
```

- `-f`, `--config PATH` — path to the config file to read defaults from and
  write (default: `config.json` in the repo root).
- `-d`, `--dashboard PATH` — path to a previously generated dashboard JSON
  (default: `fire-dashboard.json`) — see "Picking up dashboard changes"
  below.

### Account classification

Actual's account API has no account-type field, so this repo can't know on
its own which accounts are retirement, taxable investment, HSA, or debt.
For each open account you get a numbered choice:

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
`config.json` first, otherwise a guess from the account's name (`401k`,
`Roth`, `HSA`, `Mortgage`, `Brokerage`, and similar patterns). Press Enter to
accept it. **Accounts with no existing entry and no name-based guess show no
default** — you have to type a number; there's no way to skip one.

For accounts classified as retirement, HSA, or taxable investment, there are
two more questions — a stock/bond allocation and a monthly contribution,
both used by the Monte Carlo widget:

```
  1) equity-100 (100% stocks)
  2) equity-80 (80% stocks / 20% bonds)
  3) equity-60 (60% stocks / 40% bonds)
  4) equity-40 (40% stocks / 60% bonds)
  5) cash (100% cash)
What's an estimate of the stock/bond mix for this account? [2: equity-80]:
Monthly contribution to this account, in dollars (0 for none) [0]:
```

Every run rewrites the account list from scratch, covering every
currently-open account — running it again is the normal way to fix a wrong
answer or pick up a newly-added account, not something to avoid. As long as
an account keeps the same category between runs, any hand-customized
`taxTreatment`, `accessAge`, `allocationPreset`, or `monthlyContribution` in
the existing file is carried over as the default rather than being reset —
only changing an account's category resets those to the new category's
plain defaults.

### Personal and plan-wide questions

After every account: your birth date, one or more retirement ages to
compare (see `reports fire` below), and the age to assume the plan needs to
last to (a conservative default, not a lifespan estimate to guess).

### Crossover and Monte Carlo assumptions

Every remaining question covers a field the crossover or Monte Carlo widget
exposes: safe withdrawal rate, estimated return, expense projection method
and adjustment factor, whether to show hidden categories; withdrawal
strategy, return model, a dynamic withdrawal rule (guardrails/ratcheting/
floor-ceiling/boundaries — picking a type only then asks that type's own
sub-questions, skipped entirely for the default, "none"), minimum
withdrawal, inflation mean/volatility, tax model (progressive tax bands only
asked if you pick "bands" over the default "flat"), and simulation count.
Each account's monthly contribution (above) is summed into the crossover
widget's single contribution figure and threaded individually into the
Monte Carlo widget's per-account contributions — asked once, per account,
feeding both.

Every step writes `config.json` immediately, not just at the very end, so
quitting partway through (ctrl-c or otherwise) keeps everything answered so
far.

### Picking up dashboard changes

If `fire-dashboard.json` (or the path given via `-d`) exists and looks newer
than `config.json`, `configure` offers to import its crossover/Monte Carlo
assumptions, contributions, and retirement ages into `config.json` first —
so a change made post-import in Actual's own Monte Carlo configuration UI
(copied back into the file) isn't silently overwritten by the questions that
follow.

### `config.json`

A gitignored JSON file (it names your real accounts) holding everything
`configure` asked about:

```json
{
  "version": 1,
  "birthDate": "1985-03-22",
  "retirementAges": [60],
  "planToAge": 100,
  "accounts": [
    { "match": "691a0cae-4eed-4cfb-a42d-5878c7bdba88", "category": "investment-taxable", "taxTreatment": "taxable", "accessAge": null, "allocationPreset": "equity-80", "monthlyContribution": 50000 }
  ],
  "crossover": {
    "safeWithdrawalRate": 0.04,
    "estimatedReturn": null,
    "projectionType": "hampel",
    "expenseAdjustmentFactor": 1,
    "showHiddenCategories": false
  },
  "monteCarlo": {
    "withdrawalStrategy": "proportional",
    "returnModel": "normal",
    "withdrawalRule": { "type": "none" },
    "minimumWithdrawal": 0,
    "inflationMean": 0.03,
    "inflationStdDev": 0.02,
    "taxModel": "flat",
    "taxBands": [],
    "simulationCount": 5000
  }
}
```

Valid `category` values: `retirement-tax-deferred`, `retirement-roth`, `hsa`,
`investment-taxable`, `debt`, `cash`, `other`. Valid `allocationPreset`
values: `equity-100`, `equity-80`, `equity-60`, `equity-40`, `cash`, or
`null` for non-portfolio categories. `monthlyContribution` is in cents, like
every other dollar amount in this file. An old `accounts.json`-shaped file
(from before this schema grew everything but `accounts`) still loads fine —
the missing sections are just treated as unconfigured and backfilled with
the defaults shown above. This is structured, personal data, so it's a
separate file rather than more `AB_*` environment variables. You won't
normally hand-edit it — `./actual configure` both reads and writes it.

## `./actual reports fire`

Builds an Actual-native FIRE (Financial Independence, Retire Early)
dashboard from real account and spending data: a full-width net-worth
widget, a safe-withdrawal-rate "crossover" projection, and a Monte Carlo
retirement simulation — using Actual's own built-in dashboard widgets
rather than reimplementing FIRE math.

```
./actual reports fire [-r N] [-b YYYY-MM-DD] [-p N] [-o PATH] [-f PATH] [-n]
```

Reads its assumptions from `config.json` (see `./actual configure` above) --
every flag below is an optional **override** for a single run, not a
required input:

- `-r`, `--retirement-age N` — compare this retirement age instead of
  `config.json`'s. Can be passed multiple times; **replaces** the whole
  configured list for this run rather than adding to it (see below).
- `-b`, `--birth-date YYYY-MM-DD` — use this birth date instead of
  `config.json`'s. Also overridable via `AB_BIRTH_DATE`.
- `-p`, `--plan-to-age N` — use this planning horizon instead of
  `config.json`'s.
- `-o`, `--output PATH` — where to write the dashboard JSON (default:
  `fire-dashboard.json`).
- `-f`, `--config PATH` — path to `config.json` (default: repo root).
- `-n`, `--dry-run` — print the plan and the JSON without writing the file.
  Also enabled by setting `DRY_RUN=true`.

The Monte Carlo widget gets one pot per portfolio account (linked to its
live balance, using the allocation and contribution you set in
`./actual configure`) and every assumption from `config.json`'s
`monteCarlo` section. Spending is split around your retirement age: $0/yr
before it (assumes you're living off other income while still working),
then the real trailing-12-month spend from it onward. If the retirement age
is today or in the past, that collapses to a single always-on phase at the
real spend.

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

**Refuses to run without a `config.json`** — run `./actual configure`
first. It also refuses to run if no account classifies as
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

**Regenerating preserves customizations to the existing output file.** If
`-o`/`--output` already exists, its widgets are merged with the freshly
generated ones rather than being overwritten wholesale:

- Real-data fields always refresh: account/category ids, each pot's values
  and contributions from `config.json`, your current age, and the
  retirement-age-driven spending amounts.
- Everything else on a still-generated widget is preserved if you changed
  it — a tweaked assumption (`safeWithdrawalRate`, `returnModel`,
  `withdrawalRule`, ...), an extra pot field (a fee), an extra hand-added
  contribution, or an extra hand-added spending phase.
- A Monte Carlo widget for a retirement age you stop passing is dropped
  (regeneration reflects exactly what you ask for that run).
- A widget of a type this tool has never generated (something you added by
  hand) is left completely untouched.

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
  fire-accounts.ts       account classification (heuristics + config.json overrides) and the FireConfig schema
  fire-dashboard.ts      builds Actual-native dashboard widget JSON (vendored widget types) + two-way config/dashboard merge
  set-budget.ts          executable CLI
  anomalies.ts           executable CLI
  match-uncleared.ts     executable CLI
  configure.ts           executable CLI
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
