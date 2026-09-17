# Reference

Detailed docs for `actual-tools` — the full `./actual` CLI reference, the
companion app's internals, and configuration file formats. Start with the
main [README](../README.md) if you're setting this up for the first time;
come back here once you want the details behind any of it.

## Configuration

The CLI tools below (`budget set-values`, `budget anomalies`,
`transactions match-uncleared`) read the same environment variables:

| Variable         | Description                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `AB_BASE_URL`    | [actual-http-api](https://github.com/jhonderson/actual-http-api) base URL, e.g. `http://host:5007/v1` |
| `AB_BUDGET_ID`   | Budget (sync) ID                                                |
| `AB_API_KEY`     | API key, sent as the `x-api-key` header                        |
| `DRY_RUN`        | `true` to report changes without writing them                  |

`AB_BASE_URL` points at a running
[actual-http-api](https://github.com/jhonderson/actual-http-api) instance
(a separate REST wrapper service), not at Actual Budget's own server
directly -- deploy that first if you don't already have one pointed at
your budget.

The companion app (`./actual service`, aka Runway) doesn't use these --
it logs in through its own UI instead, storing what you enter in
`session.json` alongside `config.json`. See "`./actual service` /
`./actual build image`" below.

## `./actual`

Every task in this repo runs through one dispatcher, from any directory:

```
./actual build                             # install deps if needed, then type-check
./actual lint                              # eslint over TypeScript, shellcheck over shell
./actual test                              # unit tests
./actual budget set-values ARGS            # set category budgets
./actual budget anomalies ARGS             # flag categories with unusual spending
./actual transactions match-uncleared ARGS # tag matching uncleared transactions
./actual service start                     # run the companion app as a container (see below)
./actual build image                       # build the image that service runs
./actual vendor check                      # check vendored third-party files against upstream
```

## `./actual budget set-values`

Sets category budgets for a month, or an inclusive range of months. Also
available as a web form with a live preview — see `./actual service`'s
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
see `./actual service`'s **Budget** section below.

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

## `./actual service` / `./actual build image`

A local **companion app** for a self-hosted Actual Budget instance — one
small web page, run alongside Actual, for the things a terminal interview
or a one-shot CLI command does badly: bulk budget edits and spending
analysis with a live preview (**Budget**, below — the web equivalent of
`./actual budget set-values`/`anomalies`, which stay available too for
scripting/automation), and retirement/FIRE configuration and dashboard
health (**Retirement**, further below — replaces the old
`./actual configure`/`./actual reports fire` entirely). Working with
individual transactions stays a CLI job — see `./actual transactions
match-uncleared` — since it is one-shot, scriptable work rather than
something a page helps with.

```
./actual service start [--dev] [-p N]
./actual service status [-p N]
./actual service stop [-p N]
./actual build image [-t TAG] [--platform P]
```

`service start` runs the app as a container (`docker compose up -d`) from
the image `./actual build image` produces. `--dev` instead runs the sources
directly in the foreground, restarting on every edit — that's the working
loop, and the container is not involved in it. `status` answers by
connecting to the port, since that's the only thing that settles whether
anything is actually serving; a container can be running with a wedged
server inside it. `stop` takes down the container and any `--dev` process
holding the port, so it doesn't matter which way it was started.

Two things about running the container that are worth knowing before they
bite:

- **`AB_DATA_DIR`** — `config.json` lives in a mounted directory
  (`./data`), and a relative path there resolves against the *docker
  daemon's host*, not against wherever compose was run from. Those differ
  whenever the daemon is remote or the repo is reached through a container,
  and the symptom is `Bind mount failed: '…' does not exist`. Set this to
  the host's own absolute path in that case.
- **`AB_HOST_ALIAS`** — a container on the bridge network often can't
  reach the host's LAN address even though it resolves; requests just hang
  and surface as a bare `fetch failed`. Set this to the hostname in the
  server URL you log in with, and compose maps it to `host-gateway`, which
  routes back through the bridge. Not needed if Actual is reachable by
  plain IP.

Both belong in `.envrc`. The image itself installs nothing: this repo has
no runtime dependencies and Node runs the TypeScript directly, so the image
is the base plus `src/`.

The old `./actual app` is gone — `./actual service start --dev` is what it
was.

- `-f`, `--config PATH` — path to the config file to read from and write
  (default: `config.json`).
- `-s`, `--session PATH` — path to store the Actual credentials entered
  through the app's own login form (default: `session.json`). Missing is
  fine — the app just starts logged out.
- `-i`, `--irs-limits PATH` — path to the IRS contribution limits reference
  file (default: `irs-limits.json`). Missing is fine, just skips that
  context.
- `-b`, `--tax-brackets PATH` — path to the federal tax bracket reference
  file (default: `federal-tax-brackets.json`). Missing is fine, just skips
  the MAGI/effective-rate estimate.
- `-l`, `--life-expectancy PATH` — path to the IRS Single Life Expectancy
  reference file (default: `irs-life-expectancy.json`). Missing is fine,
  just skips the 72(t) SEPP amount calculators.
- `-g`, `--poverty-guidelines PATH` — path to the federal poverty
  guidelines reference file (default: `federal-poverty-guidelines.json`).
  Missing is fine, just skips the MAGI finding's %FPL/ACA-subsidy context.
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
(the app itself doesn't require its own login -- only share these on a network you trust)
Press Ctrl+C to stop.
```

The first time you open it (nothing in `session.json` yet), it asks for
your [actual-http-api](https://github.com/jhonderson/actual-http-api)
server's URL, your budget's Sync ID (from Actual's own Settings → Show
advanced settings), and the API key you set for that server (its own
`API_KEY` environment variable, not something Actual generates). It
validates them against that server before saving, so a typo surfaces
immediately rather than on the first real page load. **Log out** (the
icon next to the privacy toggle) clears them again.

Binding every interface means the page also works from another device on
the same network — e.g. running this on a home server and pulling it up
on your phone or laptop's browser. **There is no authentication protecting
the app itself**, so anyone who can reach one of the printed network
addresses can open it, log in with their own Actual credentials (or use
whichever are already saved), and read your accounts/edit `config.json`;
fine on a trusted home LAN, not something to expose past it (e.g.
port-forwarded to the internet) without adding real auth first.

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

`./actual service start --dev` also hot-reloads end to end, with no manual
stop/restart needed for a source change: the dispatcher runs it under
node's own `--watch` flag, which restarts the process automatically the moment
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
one implementation, not two drifting apart), with a live preview instead
of `-c NAME` flags and a positional action argument. Income is never a
valid target for either tool (exactly as the CLI has always enforced), so
the category picker doesn't even offer an income category or group.

Everything here runs over one picker: pick the months and categories once,
then choose what to do with them from the **Action** list. Finding
anomalies is simply one of those actions rather than a separate tab with
its own copy of the same grid and its own separate selection to make. The
buttons follow whichever action is selected, and any result on screen is
cleared when it changes — a result describes the run that produced it, so
leaving it up beside a different action would misattribute it. The card
carries the section's own title and runs to the top of the page, so the
Action list is the first thing on it.

**Setting values**: pick an **action** (the same five as the CLI --
`balance`/`spent`/`spent-3`/`spent-12`/`previous` -- or **Custom amount**
for a flat dollar figure), then choose the months and categories it applies
to in the table below, which is styled after Actual's own budget page: a
foldable row per category group (click the caret to collapse it, or its own
checkbox to select every category inside at once) and a real
Budgeted/Spent/Balance column triplet per month.

The checkbox in the **Category** header takes or clears every category in
the grid at once, and shows the same three states a group's own checkbox
does — empty, a dash for a partial selection, a tick for all of them. It
sits in the same column as the group and category boxes it governs.

Unlike the CLI, **an empty category selection is refused rather than
treated as "every category"**: over the web the picker is a checkbox per
category, where nothing checked reads as "I haven't picked yet", not as a
request to sweep the entire budget.

Three months are on screen at a time. The **month strip** above the table
spans two years: click any month to jump the window there, use the
chevrons to step one month at a time, or the calendar button to return to
today. Moving the window **rolls the grid sideways through every month in
between** — jumping from May 2026 back to November 2025 shows May leave to
the right while April arrives from the left, then March, then February,
until November lands in the first column. The whole journey is fetched in
one request so each month passing by shows its own real figures
(`BUDGET_TABLE_MAX_MONTHS` in `src/budget-tools.ts` caps how wide a single
request can get). Anyone who has asked their system for reduced motion
lands on the new months directly, with no journey.

Which months the action covers is a separate thing from which months are
on screen: click a **month's header** to select it (shift-click to extend
a span), and the selected columns shade to show it.

The **⋮ menu** in the Category header holds **Toggle hidden categories**
(Actual's hidden categories and groups are left out by default — they're
hidden there precisely because they aren't part of day-to-day budgeting;
switching them on marks each one dimmed and italic with an eye-off glyph
so it never reads as an ordinary row) plus **Expand/Collapse all**.

**Preview** — enabled once at least one month and one category are picked
— is always a dry run, computing what every matching category's new
budgeted amount would be without writing anything. **Apply changes**
(disabled until a Preview has run) re-runs the identical request for real.
Every result line shows its status (unchanged/would update/updated) and the
old → new amounts, grouped by month.

**Finding anomalies** (the one read-only action, so it offers a single
**Find anomalies** button rather than the Preview/Apply pair — there is
nothing to preview when nothing will be written) — uses the
same robust (median-based) outlier test as the CLI
(`src/anomaly-detect.ts`) against each category's own trailing 12-month
history. Each finding is also boxed in the grid itself, on that category and
month's **Spent** figure — the same idea as a Preview marking the Budgeted
cells it would change. **The grid is the report**: there is no list of
findings beside it, since that would be the same report twice, once where
you have to match names and months back against the table by eye. Hovering
a flagged cell gives the figure it was judged against ("Typical:
-$210.00"), and a single line above says what the run found, which is the
one thing the grid can't show — a run that finds nothing has to look
different from a run that never happened. Colour and an arrow both carry
the direction
(▲ spent more than usual, ▼ less), a group's own total carries the flag so
a folded group still shows it, and a flagged `$0.00` keeps its full weight
instead of being dimmed as an empty cell — "spent $0.00 where -$210.00 is
typical" is exactly the kind of finding worth looking at. Like a preview,
the flags describe one run over one selection, so changing the action, the
months or the categories drops them.

A **Tag flagged transactions** button stands beside **Find anomalies** for
the whole of this action, disabled until a run has actually flagged
something: it prepends a `#anomaly-high`/`#anomaly-low` tag
to the note of whichever transaction(s) in that month are themselves
responsible (or, if none stands out individually, the single largest
transaction that month), and lists what it tagged. **It writes
immediately** — there is no dry-run checkbox here, unlike the CLI's `-n`.
The preview is the Find run itself: nothing can be tagged until a Find has
flagged it, and what will be tagged is already boxed in the grid.

### Retirement

Not a set of tabs: a two-column split, wide enough viewports only (see
the min-width media query in `style.css` — a single stacked column
below that, same as everything here in either arrangement). The left
column — **Plan**, **Expense Projection**, **Simulation Settings**,
**Retirement income**, **Accounts** — is where you edit; the right
column — **Portfolio**/**Spend**, and **Analysis**'s Bridge
and Monte Carlo charts — is where you watch the result, and it stays
pinned in place (`position: sticky`) as the left column scrolls, so
tweaking a field never means scrolling down to see its effect and back
up to keep editing. Editing a field re-runs the same
`/api/retirement/check` call every card reads from, a beat after you
stop typing, so the right column stays live as you work. Each card is
independently foldable and remembers its own fold state per browser
across a reload, via a cookie, the same way which of Budget/Retirement
was open already was. **Refresh** (re-runs that same check on demand —
its real job is pulling in a change made directly in Actual, like a new
transaction, since editing a field here already triggers the same
re-check on its own) and **Expand all**/**Collapse all** (the left
column's own cards only — Analysis has its own single fold toggle,
deliberately not swept up in a left-column bulk action) sit atop the
left column. Both charts
have a click-to-zoom button (appears on hover) that opens the same
chart, larger, in a modal — not a re-render, the chart's own DOM node
moves there and back, so its hover/tooltip keeps working unchanged.

**Plan**: birth date, one or more retirement ages to compare (space- or
comma-separated), and the age to assume the plan needs to last to (a
conservative default, not a lifespan estimate).

**Expense Projection**: target income % and spend history (in months),
plus **Expense categories** — every input to this app's own annual-spend
calculation, entirely local (see "Annual spend is entirely local" below).
The category picker is always visible (no "use every category" toggle to
unhide it) — a foldable, per-group checklist, every category checked by
default, with an **Expand all**/**Collapse all** toolbar, a **Show
hidden** toggle to bring categories Actual itself has hidden into the
list (unchecked by default even then), and a **Hide unchecked** toggle
that narrows the view to your current selection without changing it.
Each group has its own select-all-in-group checkbox and a live N/total
count, so a folded group's selection is still legible without opening
it. This selection drives every simulation on the page directly (Bridge,
Monte Carlo, the Spend tile).

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

**Simulation Settings** (optional): withdrawal strategy, minimum
withdrawal, withdrawal rule, return model, tax model, tax bands, inflation
(mean/std dev), and simulation count — grouped into **Withdrawal**,
**Returns & taxes**, **Tax bands**, and **Inflation & simulation**
sub-sections. Every field here is set once and applies to every
retirement-age comparison being simulated, rather than needing to be
re-entered per age. A field left blank keeps today's plain default; a
field set here overrides that default for every scenario's simulation.
Withdrawal rule picks a type (guardrails, ratcheting, floor &
ceiling, boundaries) and reveals that type's own parameters — switching
types keeps each type's values around, so flipping back doesn't lose what
you entered. Tax bands is an addable/removable list of threshold/rate
rows, set as one whole list rather than field-by-field, same as
withdrawal rule.

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
  you've already fully retired at 52) — that scenario simply
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

Whenever **withdrawal strategy** (Simulation Settings) is set to "Drain
pots in order," each portfolio account also gets a drag handle (⠿) on the
left of its row — Actual's own simulation engine drains pots in exactly
the order its `pots` array lists them, so this is the one place that
array order matters, and the account list becomes the thing you drag to
set it. Dropping a row persists the whole new order in one write
(`PATCH /api/retirement/accounts/order`) so the in-app Monte Carlo
simulation always drains pots in the order you last arranged. The handle (and the list's drag behavior)
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
the **Bridge** check (in Analysis, below), clamped to the account's live balance
(a market drop can leave less in the account than you've contributed).
**This only affects Bridge, not the in-app Monte Carlo simulation** —
Actual's own pot format (which the Monte Carlo simulation's inputs still
mirror) has no way to give one account two different access ages without
either double-counting its balance or hand-entering a starting balance
that would drift from reality over time, so the Monte Carlo simulation
still treats the whole account as locked until its normal access age.

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

**Annual spend is entirely local — this app never reads a live Actual
widget of any kind to derive it.** Expense Projection's own **Expense
categories** selection, if set, is a trailing-average over exactly that
selection (**Spend history** months, 12 by default — tunable in the same
card), scaled by **Expense Adjustment %** if set. Left unset, it falls
back to every non-income, non-hidden category over that same window — a
plain default, not a reason to go check what's live in Actual. Whichever
one is active, it feeds every simulation on the page the same way — Monte
Carlo, Bridge, the Spend tile above.

**Contributions and spending phases are managed for you**, not left at
a plain per-account default:

- A contribution stops at that scenario's own retirement age (`toAge`) —
  nobody is still funding an account from a paycheck once retired, and a
  scenario already retired at the age Check runs it for gets no
  contributions at all.
- Spending steps down automatically as guaranteed income and debt payoff
  arrive: a pension/Social Security stream you've entered (see
  "Retirement income" above), and, per debt account with payoff fields
  filled in (any loan — a mortgage, a HELOC, a car loan — the fields are
  just named after the common case), once that loan is projected to be
  paid off. **This assumes the regular payment is counted in your
  budgeted spend already** (the common Actual setup — a category you
  fund monthly, not a bare account-to-account transfer); if yours is
  tracked purely as a transfer, it was never part of the simulated
  spend, and this phase would overstate the reduction. An extra
  principal amount you've entered shortens the payoff itself but is
  deliberately **not** added to what frees up once paid off — it's a
  discretionary overpayment, often funded outside your regular budgeted
  spend (its own separate, unselected category, or straight from
  savings) even when the regular payment is tracked normally.

**Check** re-runs Bridge and Monte Carlo directly against your current
config and real, live account data every time the page loads or a field
changes — there's no separate "generate" step and nothing exported to (or
read back from) Actual's own dashboard feature; both charts and findings
are computed and drawn in this app. Two things get checked:

- **Bridge** — for each retirement age, whether the accounts you can
  actually reach at that age fund every year until the locked ones open
  up. This projects forward at each allocation's mean return with no
  volatility and grosses withdrawals up for tax **at that account's own
  rate** (0% for a Roth or HSA, a flat 22%/15% otherwise, or a per-account
  override — see "Withdrawal tax rate" below), applying the same
  accessible-only funding rule Actual's own Monte Carlo engine uses — a
  *best* case, so a scenario that runs dry here runs dry in essentially
  every simulated run. Also nets out guaranteed income/debt payoff the
  same way described above. **Drawn as a burndown chart**, one line per
  retirement age, next to the prose finding rather than instead of it:
  the accessible balance declining toward zero (or the end of the plan),
  with the still-locked balance as a dashed companion in the same color —
  a scenario that runs dry gets a hollow ring and a muted "unlocks NN"
  reference line marking how far off the next unlock actually is; one
  that funds the whole plan gets neither. A Rule of 55 boost, a debt
  payoff, and a pension/Social Security start each get their own labeled
  reference line too, stacked top-to-bottom in age order (soonest
  highest) so a crowded stretch never collides. Hovering shows the exact
  accessible/locked balance and that year's expenses at any age — the
  expenses figure is always the plan's own gross cost of living, not
  reduced by guaranteed income kicking in, so it reads as a stable,
  ever-growing number rather than one that mysteriously drops the moment
  a pension starts (income still reduces how much of that spend the
  portfolio itself has to cover — that's the accessible-balance line
  above, just not this figure). This chart cannot live in
  Actual's own dashboard — every one of Actual's widget types (checked
  against upstream, not guessed) is a query over your ledger, with no
  slot for a projected series like this one, so it stays here, in the
  Analysis card. A scenario that never depletes is only drawn 20 years past
  its own retirement age, not all the way to the end of the plan: a
  portfolio whose growth outpaces its spending can compound to genuinely
  enormous nominal figures over a 40+ year horizon, which would swamp the
  scale for every other scenario on the same chart and squash the years
  that actually matter down to an unreadable sliver. The real number is
  still in the finding text below, unaffected by where the line is drawn.
- **Monte Carlo** — a real stochastic simulation (5,000 runs by default,
  randomized returns, the same withdrawal-strategy/tax/inflation rules
  Simulation Settings above configures), run entirely in this app rather
  than read from or written to Actual's own dashboard — see "Vendored
  third-party code" below. Drawn as a fan chart per retirement age: an outer band
  (10th-90th percentile), an inner band (25th-75th, the interquartile
  range), and a solid median line, plus the plan's own success rate (the
  share of runs that fund it through the target age) as a direct label.
  The axis is scaled to the median's own peak, not the outer bands — a
  plan with any real chance of failure typically has a median that itself
  heads toward zero, which is the line that most needs to stay legible;
  the 75th/90th bands are still real and still drawn, just clipped at the
  top of the plot past that scale rather than resizing the whole chart
  around a lucky tail that can compound to an enormous nominal figure over
  a 30-40 year horizon. The real percentiles are still in the tooltip and
  the finding text either way.

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

`match` is an account id or exact name. Every assumption this app lets
you set (see Expense Projection/Simulation Settings above) lives in
`dashboard` as its own field, prefixed `crossover`/`monteCarlo` (a naming
holdover from when the `crossover` ones fed an exported crossover-card
widget that no longer exists — see `FireWidgetType`'s own doc comment in
`fire-dashboard.ts`). Either prefix's field, left out or `null`, falls
back to its own plain default (`DEFAULT_MONTE_CARLO_ASSUMPTIONS` in
`fire-dashboard.ts`, or see "Annual spend is entirely local" above for the
`crossover` ones) — there's no live Actual dashboard state either falls
back to any more.

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

### Vendored third-party code

`src/vendor/monte-carlo/` carries actualbudget/actual's own Monte Carlo
simulation engine (MIT licensed — `LICENSE-ACTUAL.txt` alongside it), run
in-process rather than reimplementing Actual's own simulation logic from
scratch. Kept close to a verbatim copy of upstream (each file's own header
names the exact commit and blob hash it was copied from, and what — if
anything — was changed); this app's own `buildMonteCarloWidget` supplies
its input, in exactly the shape Actual's own `monte-carlo-card` widget
would use, so this app's simulation can never disagree with what Actual
itself would produce from the same inputs.

```
./actual vendor check
```

Compares each vendored file's pinned commit against the file's current
state on GitHub (a git blob hash, not a content fetch or diff) and reports
whether it's drifted. Drift itself isn't a problem — this app doesn't
intend to track upstream forever — the command just makes it visible
rather than silent, so a future session can decide whether to re-vendor.
Needs network access, so it's a manual, on-demand command rather than
part of `./actual test`.

## Layout

```
actual                   task dispatcher, the entry point for everything
lib/cli-format.sh        shared bash help-text formatting, used by actual
src/                     TypeScript sources and their tests
  actual-helpers.ts      typed Actual REST client + pure helpers, incl. the ActualQL run-query client
  actual-session.ts      loads/writes/clears session.json -- the Actual credentials entered through the app's own login form
  anomaly-detect.ts      pure MAD-based outlier detection, no API dependency
  cli-format.ts          shared TypeScript help-text formatting
  fire-accounts.ts       account types/classification (heuristics + config.json overrides) and the FireConfig schema
  fire-dashboard.ts      builds the Monte Carlo widget/pot shape the in-app simulation runs on (vendored widget types)
  fire-sepp.ts           72(t) SEPP (substantially equal periodic payment) amount calculators
  fire-analysis.ts       pure bridge-projection logic behind Retirement's own Check
  fire-generate.ts       checkDashboard -- the non-CLI logic behind the Retirement page's Check
  fire-monte-carlo.ts    adapts this app's own account data into the vendored Monte Carlo engine's input shape
  vendor/monte-carlo/    vendored actualbudget/actual Monte Carlo engine (MIT) -- see "Vendored third-party code" above
  irs-limits.ts          loads irs-limits.json, the IRS contribution limits reference file
  irs-life-expectancy.ts loads irs-life-expectancy.json, the IRS Single Life Expectancy reference file (72(t) SEPP)
  federal-tax-brackets.ts    loads federal-tax-brackets.json; estimates MAGI/marginal/effective rate
  federal-poverty-guidelines.ts loads federal-poverty-guidelines.json, for the MAGI finding's %FPL/ACA-subsidy-cliff context
  app-server.ts          the companion app's node:http server, routes namespaced under /api/retirement/ (and /api/session)
  app-ui/                the companion app's static page (plain HTML/CSS/vanilla JS, no build step)
  app.ts                 executable CLI: thin bootstrap for app-server.ts
  set-budget.ts          executable CLI
  anomalies.ts           executable CLI
  match-uncleared.ts     executable CLI
  vendor-check.ts        executable CLI: ./actual vendor check
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

### Driving the app in a browser

`src/browser-tests/` drives the companion app in a real browser, covering
what route tests can't reach: whether the header menu actually opens,
whether hidden categories appear when toggled, whether moving the month
window rolls through the months in between, and whether the Category
column holds still while they pass. Every case there stands for a bug that
reached the working tree at some point and was only caught by pointing a
browser at the page.

No stub Actual server is involved: `startAppServer` runs inside the test
process, so its own outbound calls are stubbed exactly as the route tests
stub them, and only the browser is out-of-process. These run as part of
`./actual test` like everything else -- and skip themselves, with a
warning, on a machine where the browsers aren't installed, the same
courtesy `./actual lint` extends to a missing shellcheck.

The CLIs are covered on two levels of their own: `cli-args.test.ts` imports
each entry point's `parseArguments` directly (they export it, and guard
their own `main()` on being the program node was actually pointed at, so
importing one doesn't run it), and `cli-dispatch.test.ts` runs `./actual`
as a real process for the routing and exit codes that live in bash where
neither `tsc` nor eslint reaches. Nothing in either touches the network:
every case prints help or is rejected before a request is made, and the
subprocess tests run with a blanked environment so a machine with real
`AB_*` variables set can't wander into a live budget.

They typecheck against `src/browser-tests/tsconfig.json` rather than the
root one, purely so the DOM types those in-browser callbacks need stay out
of the rest of the repo: everything else here is Node-only, and putting
`dom` in the root `lib` would let server code reference browser globals and
still compile.

The browsers are baked into the sandbox image
(`.claude/sandbox/plugin.sh`) rather than downloaded per session, and
`./actual test` points Playwright at them by exporting
`PLAYWRIGHT_BROWSERS_PATH` when it finds them.

That export matters because the image sets the variable from
`/etc/profile.d`, which only a *login* shell reads -- so a script, an
editor terminal or a CI step has the browsers on disk with Playwright
looking in `~/.cache/ms-playwright` and failing with a bare "Executable
doesn't exist". Off the image the variable is left alone and Playwright
falls back to its own default location.

The app itself is served with `Cache-Control: no-store`. Without it a
browser may reuse `app.js`/`style.css` without revalidating (there is no
ETag or Last-Modified to check against), which silently defeats the page's
hot-reload -- it reloads on a new build id and is handed the same stale
assets -- and lets the two files drift apart, since they cache
independently.
