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

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                             # install deps if needed, then type-check
./actual lint                              # eslint over TypeScript, shellcheck over shell
./actual test                              # unit tests
./actual budget set-values ARGS            # set category budgets
./actual budget anomalies ARGS             # flag categories with unusual spending
./actual transactions match-uncleared ARGS # tag matching uncleared transactions
./actual app ARGS                          # launch the local companion app (see below)
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

## `./actual app`

The start of a local **companion app** for a self-hosted Actual Budget
instance — one small web page, run alongside Actual, for the things a
terminal interview does badly: retirement/FIRE configuration and dashboard
health today; bulk budget edits and spending analysis (currently
`./actual budget set-values`/`anomalies`) in later phases. Replaces the old
`./actual configure` and `./actual reports fire`.

```
./actual app [-f PATH] [-i PATH] [-o PATH] [-p N] [--no-open]
```

- `-f`, `--config PATH` — path to the config file to read from and write
  (default: `config.json`).
- `-i`, `--irs-limits PATH` — path to the IRS contribution limits reference
  file (default: `irs-limits.json`). Missing is fine, just skips that
  context.
- `-o`, `--output PATH` — filename the "Generate dashboard" action's
  browser download suggests, and the server-side copy it also keeps
  (default: `fire-dashboard.json`).
- `-p`, `--port N` — run on this fixed port instead of an OS-assigned one.
- `--no-open` — don't try to open the page in a browser automatically, just
  print the URL. Useful over SSH or in a container with no browser to open.

Running it starts a local server (plain `node:http`, no new dependency),
bound to every network interface rather than just loopback, and prints
its URL:

```
Runway is running at http://localhost:54321/
Also reachable from another device on your network at:
  http://192.168.1.23:54321/
(no login is required -- only share these on a network you trust)
Press Ctrl+C to stop.
```

Binding every interface means the page also works from another device on
the same network — e.g. running this on a home server and pulling it up
on your phone or laptop's browser. **There is no authentication at all**,
so anyone who can reach one of the printed network addresses can read
your accounts and edit `config.json`; fine on a trusted home LAN, not
something to expose past it (e.g. port-forwarded to the internet) without
adding real auth first.

Everything the page does reads and writes `config.json` directly and
autosaves on every change — there's no separate "save" step, and no
question order to work through; edit whatever you want, whenever you want.
Press Ctrl+C in the terminal when you're done; it's a plain foreground
process, not a background daemon.

### Retirement — Configure tab

**Plan**: birth date, one or more retirement ages to compare (space- or
comma-separated), and the age to assume the plan needs to last to (a
conservative default, not a lifespan estimate).

**Accounts**: every open account, each with an **account type** — not just
a coarse category, but a concrete kind (Traditional 401(k)/403(b)/457/TSP,
Roth 401(k)/403(b), Traditional IRA, Roth IRA, Inherited/Beneficiary IRA,
HSA, taxable brokerage, high-yield savings/money market, debt, cash,
other). A high-yield savings account or money market is its own type,
distinct from a plain brokerage: taxable like one, but with no age-based
withdrawal restriction and a stable, cash-like balance rather than market
exposure, so it defaults to a cash allocation instead of stocks. The type
drives everything else about the account, and which fields even show up:

- **Allocation** and **monthly contribution** — shown for every portfolio
  type (retirement/HSA/taxable). A contribution can be a plain number, or
  toggled to **Max**, which resolves live to the remainder of that type's
  shared IRS limit after every other account's explicit contribution in
  the same limit group (401(k)/403(b) share one limit; Traditional and
  Roth IRA share another) — recomputed from your current age and
  `irs-limits.json` on every read, so it never goes stale as limits update
  each tax year or as you cross the 50 and 60–63 catch-up tiers. At most
  one account per limit group can be **Max** at a time.
- **IRS contribution limit(s)** — shown inline once the type is known, with
  every age tier as its own line, e.g.:
  ```
  Roth IRA: $7500.00/yr [$625.00/mo]
  Roth IRA age 50+: $8600.00/yr [$716.67/mo]
  ```
  An inherited/beneficiary IRA has no contribution limit at all — you
  can't add new money to one, so neither the contribution field nor an
  allocation-adjacent limit line appears for that type.
- **Rule of 55** (IRC §72(t)(2)(A)(v)) — shown only for the two
  401(k)-family types, never for an IRA, since the exception can never
  apply to one. A checkbox ("Active account with this employer") replaces
  a bare "0 for not applicable" number field: checking it reveals the
  separation-age input (defaulting to 55, the exception's own floor);
  unchecking it clears the age entirely, rather than leaving a stray 0
  meaning the same thing as "never asked." When set, the account's
  effective access age in the Monte Carlo widget drops to that age (or
  stays at the normal one if that's earlier).
- **Employer match** — also 401(k)-family only: annual salary, match rate,
  and the pay percentage it's capped at (e.g. 100% up to 4% of pay).
  Deliberately a flat two-number formula, not a tiered one (e.g. "100% on
  the first 3%, 50% on the next 2%") — covers the common case without
  needing more inputs. Once entered, the page shows the estimated employer
  contribution and checks it against the combined IRC §415(c) "annual
  additions" limit (employee elective deferrals + employer money
  together) — a separate, much larger ceiling than the elective-deferral
  limit above, which mostly only binds for a large employer match or
  profit-sharing plan (e.g. a solo 401(k)'s "employer" contribution).
- **HSA coverage** — self-only or family, since the two have different IRS
  limits; the contribution-limit lines and a **Max** contribution both use
  whichever is selected.

An **inherited/beneficiary IRA** also gets a real correctness fix: it has
no early-withdrawal-penalty age restriction at all (IRC §72(t)(2)(A)(iv)),
unlike every other IRA/401(k) type here — so its access age is always
unrestricted, not the usual 59.

**Mortgage/loan payoff** (debt accounts): interest rate, monthly payment,
and a balance as of a given date — independent of Actual's own ledger
balance for the account, since a real servicer's payoff balance often
isn't what a synced or manually-tracked Actual account reflects. From
those four numbers the page computes and shows an estimated payoff date
using standard loan amortization, or a clear message if the payment
doesn't even cover the interest accruing each month (the balance would
grow, not shrink).

Two real strategies exist but aren't modeled: a **Roth conversion ladder**
(staggered Traditional→Roth conversions, each with its own 5-year clock)
isn't expressible with Actual's single access age per pot without a much
bigger approximation, and **SEPP/72(t)** (substantially equal periodic
payments) is a fixed IRS-formula payment schedule, not an age threshold —
there's no honest way to represent it here, so it's left out rather than
approximated.

**Migrating an older `config.json`**: an account with no type yet (from
before this existed) gets one guessed from its old category and real name
— reviewable, not authoritative. The two cases most likely worth a second
look are a Traditional/Roth IRA vs. its 401(k)-family counterpart, and an
inherited IRA (matched by "BDA"/"beneficiary"/"inherited" in the name).
Editing any field on a migrated account writes the current shape, dropping
the old category field for that account.

### Retirement — Analyze tab

**Generate dashboard** builds the same widgets `./actual reports fire`
used to (a full-width net-worth widget, a safe-withdrawal-rate "crossover"
projection, and a Monte Carlo retirement simulation, using Actual's own
built-in dashboard widgets rather than reimplementing FIRE math) from your
real account and spending data, and **downloads it to your browser** —
useful since the server and the browser viewing it aren't always the same
machine (e.g. running this on a home server, viewed from a laptop). It
also keeps its own server-side copy at the output path, for continuity if
you're running it locally. Refuses to run without a birth date, at least
one retirement age, and at least one account classified into the
portfolio.

**This does not talk to Actual's dashboard feature directly for writing**
— there's no API for that (confirmed against both `@actual-app/api` and
this repo's REST wrapper). Instead it writes a JSON file in Actual's own
dashboard-export format, which you import yourself, once:

1. Open your budget in Actual and go to the Reports/Dashboard tab.
2. Create a **new, empty** dashboard page (e.g. name it "FIRE").
3. On that page, open the **"..."** menu → **Import**, and pick the file.

**Import replaces every widget already on the target page** — always
import onto a page you're fine wiping, never your main dashboard.
Regenerating and re-importing onto that same page is the normal way to
refresh it. **Regenerating preserves customizations you've already made**:
real-data fields always refresh (account/category ids, pot values and
contributions, your current age, retirement-age-driven spending), but
anything else you tweaked afterward — an assumption, an extra pot field, a
hand-added contribution or spending phase, or a widget of a type this tool
never generated — survives. The merge basis is, in order: whatever is
**live in Actual right now** on a dashboard page literally named "FIRE"
(read the same way `Check` does, via ActualQL), so settings you tuned
inside Actual itself are never silently reverted; if no such page exists
or the live lookup isn't reachable, the last file this tool wrote to its
output path; if neither exists, this is treated as a first-time
generation.

**Monte Carlo Analysis is an experimental Actual feature** — enable it
under Settings → Advanced → Experimental features → Monte Carlo Analysis
Report first, or the imported widget won't render.

**Check** reads the dashboard that is **live in Actual** — not the
generated file — through Actual's own ActualQL `run-query` endpoint (gated
behind your Actual HTTP API's experimental-operations setting; a clear
message appears if it's off), so it sees whatever you've actually been
editing in the app. Two things get checked:

- **Drift** — a widget's stored access ages against what your current
  config would generate, and accounts the crossover counts that the
  simulation doesn't model (or vice versa). Either usually means the
  dashboard predates a config change and needs re-importing.
- **Bridge** — for each retirement age, whether the accounts you can
  actually reach at that age fund every year until the locked ones open
  up. This projects forward at each allocation's mean return with no
  volatility and grosses withdrawals up for tax, applying the same
  accessible-only funding rule Actual's own Monte Carlo engine uses — a
  *best* case, so a scenario that runs dry here runs dry in essentially
  every simulated run.

Retirement spend for both actions comes from the live crossover widget's
own category selection and date range once one exists (so narrowing either
in Actual feeds this directly, rather than being overwritten by a fixed
trailing-12-months-over-every-category default).

### `config.json`

```json
{
  "version": 1,
  "accounts": [
    { "match": "<account id>", "type": "traditional-401k", "allocationPreset": "equity-80", "monthlyContribution": 150000 }
  ],
  "dashboard": { "birthDate": "1976-07-31", "retirementAges": [55, 60], "planToAge": 100 }
}
```

`match` is an account id or exact name. Every crossover/Monte Carlo
assumption Actual itself exposes (safe withdrawal rate, tax model,
inflation, withdrawal strategy, ...) lives only in the dashboard file
you've imported — not here — since `Generate dashboard`'s own merge
behavior already preserves whatever you tune there.

### IRS contribution limits

`irs-limits.json`, git-committed (not personal data, unlike `config.json`)
and hand-updated:

```json
{
  "taxYear": 2026,
  "source": "https://www.irs.gov/...",
  "employerPlan": { "standard": 2450000, "catchUp50": 800000, "catchUp60to63": 1125000, "annualAdditions": 7200000 },
  "ira": { "standard": 750000, "catchUp50": 110000 },
  "hsa": { "selfOnly": 440000, "family": 875000, "catchUp55": 100000 }
}
```

All dollar amounts in cents. `employerPlan.annualAdditions` is the IRC
§415(c) combined employee+employer limit (see the employer-match note
above) — a real, separate figure, not derived from `standard`; its
catch-up amounts happen to equal the elective-deferral ones above (verified
via a real web search, not assumed), but the base figure is its own. There's
no IRS API for any of this (only annual news releases and Revenue Procedure
PDFs) — ask a future session to re-verify it via a real web search once a
new tax year's limits are announced, usually in the preceding fall.
## Layout

```
actual                   task dispatcher, the entry point for everything
lib/cli-format.sh        shared bash help-text formatting, used by actual
src/                     TypeScript sources and their tests
  actual-helpers.ts      typed Actual REST client + pure helpers, incl. the ActualQL run-query client
  anomaly-detect.ts      pure MAD-based outlier detection, no API dependency
  cli-format.ts          shared TypeScript help-text formatting
  fire-accounts.ts       account types/classification (heuristics + config.json overrides) and the FireConfig schema
  fire-dashboard.ts      builds Actual-native dashboard widget JSON (vendored widget types) + generated/existing-file merge
  fire-analysis.ts       pure bridge-projection and drift/mismatch-finding logic behind the Analyze tab's Check
  fire-generate.ts       generateDashboard/checkDashboard -- the non-CLI logic behind the Analyze tab
  irs-limits.ts          loads irs-limits.json, the IRS contribution limits reference file
  app-server.ts          the companion app's node:http server, routes namespaced under /api/retirement/
  app-ui/                the companion app's static page (plain HTML/CSS/vanilla JS, no build step)
  app.ts                 executable CLI: thin bootstrap for app-server.ts
  set-budget.ts          executable CLI
  anomalies.ts           executable CLI
  match-uncleared.ts     executable CLI
  *.test.ts              vitest unit tests
eslint.config.js         flat config, type-aware rules via typescript-eslint (app-ui/*.js excluded -- plain browser JS, not part of the Node project)
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
