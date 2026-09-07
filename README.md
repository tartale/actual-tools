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

Sets category budgets for a month, or an inclusive range of months. Also
available as a web form with a live preview — see `./actual app`'s
**Budget** section below.

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
category's own trailing 12-month history. Also available as a web form —
see `./actual app`'s **Budget** section below.

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

A local **companion app** for a self-hosted Actual Budget instance — one
small web page, run alongside Actual, for the things a terminal interview
or a one-shot CLI command does badly: bulk budget edits and spending
analysis with a live preview (**Budget**, below — the web equivalent of
`./actual budget set-values`/`anomalies`, which stay available too for
scripting/automation), and retirement/FIRE configuration and dashboard
health (**Retirement**, further below — replaces the old
`./actual configure`/`./actual reports fire` entirely). **Transactions**
is a placeholder for now.

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
- `-p`, `--port N` — run on this port (default: `4247`, a fixed port
  rather than an OS-assigned one — see "hot-reload" below for why). Pass
  `0` to go back to an OS-assigned ephemeral port instead.
- `--no-open` — don't try to open the page in a browser automatically, just
  print the URL. Useful over SSH or in a container with no browser to open.

Running it starts a local server (plain `node:http`, no new dependency),
bound to every network interface rather than just loopback, and prints
its URL:

```
Runway is running at http://localhost:4247/
Also reachable from another device on your network at:
  http://192.168.1.23:4247/
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

If Actual's own server is still starting up (loading/syncing the budget
file) right when the page loads, its API can briefly return an
uninformative "Unknown error" for any request — every read this app makes
retries automatically a few times over ~2.5s before giving up, so this
usually resolves on its own; the accounts list shows "Loading accounts…"
while that's happening. If it does ultimately fail, the error banner gets
a clearer message plus a **Retry** button, rather than requiring a full
page reload.

`./actual app` also hot-reloads end to end, with no manual stop/restart
needed for a source change: `./actual`'s dispatcher runs it under node's
own `--watch` flag, which restarts the process automatically the moment
any file it imports changes (`app-server.ts`, any `fire-*.ts` module —
`app.js`/`style.css`/`index.html` are re-read from disk on every request
already, so those never even need a restart). The page itself polls a
per-process id (`GET /api/dev/build-id`) every 1.5s and reloads itself the
moment that id changes, which is what a restart produces — so a tab left
open picks up the change on its own within a couple of seconds of saving
a file, without you doing anything in the browser or the terminal.
**This is exactly why the default port is now fixed** (`4247`, not an
OS-assigned one): the restarted process has to land back on the same
port for the open tab to find it again. Passing `-p 0` for the old
ephemeral behavior means a restart moves to an unpredictable new port,
which breaks this — the tab has no way to discover it and just goes
quiet until you reload it by hand.

`--watch` is skipped automatically for `-h`/`--help` (it would otherwise
keep the process alive waiting for a file change even after printing the
help text and "exiting").

### Budget

The web equivalent of `./actual budget set-values`/`anomalies` — same
underlying logic (`src/budget-tools.ts`, shared with both CLIs so there's
one implementation, not two drifting apart), with a live preview and a
category picker instead of `-c NAME` flags and a positional action
argument. Both tabs share one category multi-select control per action,
built from every non-income category group (income is never a valid
target for either tool, exactly as the CLI has always enforced) — leave
nothing selected to mean "every category" on **Set Values** (matching the
CLI's own unfiltered-sweep default), but **Anomalies requires picking at
least one**, since checking literally every category by default would be
noisy rather than useful.

**Set Values**: pick an **action** (the same five as the CLI --
`balance`/`spent`/`spent-3`/`spent-12`/`previous` -- or **Custom amount**
for a flat dollar figure), a month range, and categories, then
**Preview** — always a dry run, computing what every matching category's
new budgeted amount would be without writing anything. **Apply changes**
(disabled until a Preview has run at least once) re-runs the identical
request for real. Every line shows its status (unchanged/would
update/updated) and the old → new amounts, grouped by month.

**Anomalies**: pick a month range and at least one category, then **Find
anomalies** — always read-only, using the same robust (median-based)
outlier test as the CLI (`src/anomaly-detect.ts`) against each category's
own trailing 12-month history. Any month flagged this way unlocks a second
card, **Tag flagged transactions**: prepends a `#anomaly-high`/
`#anomaly-low` tag to the note of whichever transaction(s) in that month
are themselves responsible (or, if none stands out individually, the
single largest transaction that month) — defaults to **dry run** (a
checkbox, checked by default) so the first click always previews which
transactions would be tagged before a second, unchecked click actually
writes the notes.

### Retirement — Configure tab

The first time you open the page with nothing imported into Actual yet, a
**"Getting started"** banner walks through four steps end to end: fill in
Plan/Accounts here → Analyze tab → Download dashboard → import it into
Actual via Reports → new page → "…" menu → Import → **open the crossover
widget on that page and narrow its account/category checklist down to
what should actually count** (it starts out covering everything
non-income, which is rarely right — and matters beyond just that one
widget, since the Monte Carlo widget's own spend figure is read back from
that same selection on every future regenerate, not recalculated
separately; see "Regenerating preserves customizations" below). The
banner appears automatically whenever no live FIRE dashboard is found (the
same check "Configured in the Actual Dashboard" below already makes) and
disappears on its own the moment one is — or dismiss it with the × any
time before that; the dismissal is a per-browser cookie, so it stays
dismissed across restarts without needing a live dashboard to hide it
permanently.

**Plan**: birth date, one or more retirement ages to compare (space- or
comma-separated), and the age to assume the plan needs to last to (a
conservative default, not a lifespan estimate).

**Retirement income** (optional): a pension (start age + monthly amount)
and Social Security (the three SSA-statement reference figures — at 62, at
67/full retirement age, and at 70 — plus which of those ages you actually
plan to claim at). Both are guaranteed income sources, not portfolio pots,
so they don't get an allocation or an access age; instead, each reduces
how much the Monte Carlo simulation needs to draw from the portfolio once
it starts, via extra spending phases stepping the withdrawal down at the
right age (see `buildSpendingPhases` in `fire-dashboard.ts`). Left blank,
neither has any effect. Entered as today's-dollars figures, same as
trailing spend, so they scale with the same inflation assumption rather
than losing real value every year the plan simulates forward.

Every dollar box on the page (salary, contributions, mortgage figures,
pension/Social Security) shows commas and cents at rest and a plain number
while you're editing it. The eye icon in the top-right blurs every dollar
figure on the page (an Actual-style privacy toggle) — handy before
sharing a screen; it's a per-browser display preference, not saved to
`config.json`.

**Configured in the Actual Dashboard** (below Plan, its own Refresh
button): a read-only snapshot of whatever's actually live on your
imported "FIRE" page right now, split into its own **Crossover** and
**Simulation** sections (safe withdrawal rate/projection type/estimated
return for the former; withdrawal strategy, tax model, withdrawal rule,
inflation, and everything else this app deliberately doesn't let you edit
directly for the latter — see "Regenerating preserves customizations"
below). A field also set in **Simulation settings** shows its value in
purple — hover it to highlight the matching input down in Simulation
settings, so it's obvious where to go change it. If the live value here
doesn't match what you configured, Analyze → Check will flag it as
needing a regenerate/re-import.

**Simulation settings** (optional): withdrawal strategy, return model, tax
model, inflation (mean/std dev), minimum withdrawal, and simulation
count. Unlike every other Monte Carlo assumption, these can be set once
here instead of inside Actual's own per-widget UI — worth doing
specifically because comparing multiple retirement ages generates one
independently-named widget per age, and tuning one inside Actual never
reaches its siblings. A field left blank here keeps today's behavior (preserved
per-widget from whatever's live/local); a field set here is pinned to
that value on every regenerate, overriding whatever each widget
independently drifted to. Withdrawal rule (guardrails, ratcheting, ...)
and the tax bands list themselves stay Actual-UI-only for now — each has
its own multi-field shape that didn't fit this pass; the flat/bands
*choice* is pinnable like everything else here, it's just the band
thresholds/rates you'd still set inside Actual.

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
  one account per limit group can be **Max** at a time. **Expected
  return/Volatility** are shown right below Allocation, pre-filled with
  whatever the chosen preset implies — override either one independently
  to assume a different real return for this specific account without
  losing the preset's own label (two accounts can both be "100% stocks"
  while assuming different actual returns, e.g. a growth fund vs. blue
  chips). There's no separate "Custom" preset — with return/volatility
  editable everywhere, a standalone preset value that only existed to
  unlock the same two fields would just be a second way to do the same
  thing. Actual's own "custom-mix" (a stocks/bonds/cash percentage split
  blended against historical return series) stays unsupported regardless —
  this is a plain numeric override, not a three-way asset-mix editor.
- **Withdrawal tax rate** — every portfolio account also gets its own
  override for the flat effective tax rate applied to its withdrawals,
  shown alongside a placeholder naming the type's own rough default (e.g.
  "auto (22%)" for a tax-deferred account). The defaults
  (`WITHDRAWAL_TAX_RATES` in `fire-dashboard.ts`) are deliberately rough,
  marginal-bracket-style estimates — this lets you replace one with your
  own number, on a specific account, without changing its tax treatment.
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
  apply to one. A checkbox ("Account is active") replaces
  a bare "0 for not applicable" number field: checking it reveals the
  separation-age input (defaulting to 55, the exception's own floor);
  unchecking it clears the age entirely, rather than leaving a stray 0
  meaning the same thing as "never asked." When set, the account's
  effective access age drops to that age (or stays at the normal one if
  that's earlier) — but only in a retirement-age scenario where the
  separation age is at or before the age you're retiring at in that
  scenario. Retiring at 52 while this account's separation age is 55 is a
  contradiction (this app treats "retired" as "no longer working
  anywhere," so you can't still be employed at 55 in a scenario where
  you've already fully retired at 52) — that scenario's own widget simply
  keeps the account's normal access age instead; a later scenario on the
  same plan (retiring at 55 or after) still gets the boost.
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

Whenever **withdrawal strategy** (Simulation settings) is set to "Drain
pots in order," each portfolio account also gets a drag handle (⠿) on the
left of its row — Actual's own simulation engine drains pots in exactly
the order its `pots` array lists them, so this is the one place that
array order matters, and the account list becomes the thing you drag to
set it. Dropping a row persists the whole new order in one write
(`PATCH /api/retirement/accounts/order`) so Generate always produces pots
in the order you last arranged. The handle (and the list's drag behavior)
only appears while "Drain pots in order" is selected — every other
strategy (proportional, best-performer, target-mix) ignores pot order
entirely, so there's nothing to drag for those.

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

**Roth IRA contributed basis** (roth-ira only): under the ordering rule in
IRC §408A(d)(4), a Roth IRA's own contributions (and conversions, not
modeled here) can be withdrawn tax- and penalty-free at any age, before
touching earnings — unlike every other account here, and unlike a Roth
401(k)/403(b) pre-rollover, which has no such rule. Entering your
cumulative contributions splits that amount out as always-accessible for
the Analyze tab's **Bridge** check, clamped to the account's live balance
(a market drop can leave less in the account than you've contributed).
**This only affects Bridge, not the generated Monte Carlo widget** — Actual's
own pot format has no way to give one account two different access ages
without either double-counting its balance or hand-entering a starting
balance that would drift from reality on every regenerate, so Actual's own
simulation still treats the whole account as locked until its normal
access age.

One more real strategy exists but isn't modeled: a **Roth conversion
ladder** (staggered Traditional→Roth conversions, each with its own 5-year
clock) hits the same "one account, one access age" wall as basis
withdrawal above, N times over, plus real open questions about sizing each
rung — a bigger lift than the basis case, not attempted yet.
**SEPP/72(t)** (substantially equal periodic payments) is a fixed
IRS-formula payment schedule, not an age threshold — there's no honest way
to represent it here, so it's left out rather than approximated.

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

**The Monte Carlo widget's spend figure matches whatever the live crossover
widget's own category selection says**, once one exists — not a separate
"every non-income, non-hidden category, trailing 12 months" calculation of
its own. If you've narrowed the crossover's checklist (excluding one-time
trip categories, a dependent's separate expenses, ...), Generate uses that
same narrower selection and date range, so the two widgets' spend figures
stay consistent with each other. The broader "every category, trailing 12
months" figure is only a first-generation fallback, before any crossover
selection exists to read back. A residual difference from the crossover
widget's *own displayed number* can still remain — its projection type
(Hampel/median/mean) applies its own statistical smoothing on top of the
same trailing data, which this app doesn't reproduce.

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
real-data fields always refresh (pot values and contributions, your
current age, retirement-age-driven spending), but anything else you
tweaked afterward survives — an assumption, an extra pot field, a
hand-added contribution or spending phase, the crossover widget's own
category/account checklist (unchecking a category or account in Actual's
crossover config is preserved, not reset back to "everything" on the next
regenerate — falls back to the fresh full list only the first time, or if
the existing selection was left empty), or a widget of a type this tool
never generated. The merge basis is, in order: whatever is
**live in Actual right now** on a dashboard page literally named "FIRE"
(read the same way `Check` does, via ActualQL), so settings you tuned
inside Actual itself are never silently reverted; if no such page exists
or the live lookup isn't reachable, the last file this tool wrote to its
output path; if neither exists, this is treated as a first-time
generation.

**Monte Carlo Analysis is an experimental Actual feature** — enable it
under Settings → Advanced → Experimental features → Monte Carlo Analysis
Report first, or the imported widget won't render.

**Contributions and spending phases are managed for you**, not left at
Actual's plain per-account defaults:

- A contribution stops at that widget's own retirement age (`toAge`) —
  nobody is still funding an account from a paycheck once retired, and a
  scenario already retired at generation time gets no contributions at
  all.
- Spending steps down automatically as guaranteed income and debt payoff
  arrive: a pension/Social Security stream you've entered (see
  "Retirement income" above), and, per debt account with mortgage payoff
  fields filled in, once that loan is projected to be paid off. **This
  assumes the debt payment is counted in your budgeted spend already**
  (the common Actual setup — a "Mortgage" category you fund monthly, not
  a bare account-to-account transfer); if yours is tracked purely as a
  transfer, it was never part of the simulated spend, and this phase would
  overstate the reduction.

**Check** reads the dashboard that is **live in Actual** — not the
generated file — through Actual's own ActualQL `run-query` endpoint (gated
behind your Actual HTTP API's experimental-operations setting; a clear
message appears if it's off), so it sees whatever you've actually been
editing in the app. Two things get checked:

- **Drift** — a widget's stored access ages against what your current
  config would generate, accounts the crossover counts that the
  simulation doesn't model (or vice versa), any **Simulation settings**
  field you've pinned that isn't live on every Monte Carlo widget yet, and
  whether each widget's actual **spending/contribution figures** still
  match what Generate would produce right now for that same retirement
  age — this is what catches a narrowed crossover category selection, a
  new pension/Social Security number, a debt nearing payoff, or a changed
  contribution amount, none of which the checks above cover on their own.
  Any of these usually means the dashboard predates a config change and
  needs re-importing.
- **Bridge** — for each retirement age, whether the accounts you can
  actually reach at that age fund every year until the locked ones open
  up. This projects forward at each allocation's mean return with no
  volatility and grosses withdrawals up for tax, applying the same
  accessible-only funding rule Actual's own Monte Carlo engine uses — a
  *best* case, so a scenario that runs dry here runs dry in essentially
  every simulated run. Also nets out guaranteed income/debt payoff the
  same way Generate does.

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
