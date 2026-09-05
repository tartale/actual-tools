---
name: fire-dashboard
description: "Status/design for ./actual reports fire and ./actual accounts classify (interactive), a FIRE dashboard built on Actual's own native dashboard widgets"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-05T06:37:23.752Z
  originSessionId: 860c6192-bf02-40b0-9166-e69d50daa24b
---

`./actual report fire` and `./actual accounts classify` (2026-09-05, Phases 1-2
of a plan approved that session) build a FIRE (Financial Independence, Retire
Early) dashboard from the user's real Actual Budget data, inspired by the
feature scope of the (still unstarted, code-wise) `tartale/fire-me` repo —
see [[set-budget-migration]] for the original "possible future FIRE tool"
rationale behind writing `actual-helpers.ts` reusably in the first place.

**The core design decision, found by reading Actual's own upstream source
(actualbudget/actual on GitHub), not guessed**: Actual Budget already has
native dashboard widgets that are almost exactly a FIRE calculator —
`crossover-card` (a safe-withdrawal-rate "when can I retire" projection) and
`monte-carlo-card` (a full retirement simulator with per-account tax
treatment/access age/withdrawal strategy). So instead of reimplementing FIRE
math, this tool's job is to gather real account/spending data, classify
accounts, and **configure Actual's own already-vetted widgets** — never
touching FIRE math itself.

**No API writes a dashboard directly.** Confirmed by reading `@actual-app/api`'s
public method list (no dashboard/report methods at all) and by live-probing
this repo's existing REST wrapper (`/query`, `/aql`, `/dashboard`, `/reports`
all 404). The dashboard CRUD RPC handlers (`dashboard-create`,
`dashboard-import`, etc.) are internal-only, reachable by Actual's own client,
not external scripts. **Resolution**: the tool writes a local JSON file in
Actual's own `ExportImportDashboard` export/import shape; the user imports it
via Actual's real, currently-shipping dashboard "..." menu → Import. Zero new
API surface. **`dashboard-import` is destructive** — it replaces every widget
on the target page, no merge mode — so the tool's own help text and the
README both loudly instruct: create a dedicated, disposable page (e.g. named
"FIRE") and never import onto a page you care about. Actual's own undo
(ctrl-z) is the safety net for a bad import.

Two upstream gotchas that would have silently broken the widget if missed
(found by reading the actual crossover-spreadsheet.ts source, not assumed):
- `crossover-card`'s `incomeAccountIds` field is misleadingly named — it's
  not "accounts that receive income," it's the investable-portfolio balance
  the safe withdrawal rate is computed against. Must be exactly the accounts
  classified retirement/HSA/taxable-investment (never debt, never
  cash-other) — this is exactly what account classification exists to get
  right.
- `expenseCategoryIds` must never be left empty — an empty array silently
  zeroes the projected expense, making the widget claim "already FI" with
  $0/month spending.

**Account classification** (`src/fire-accounts.ts`): Actual's account API
exposes no type field at all (`{id, name, offbudget, closed}` only), so
classification is hybrid per the user's explicit choice — ordered
case-insensitive name-pattern heuristics (roth/hsa checked before the
broader 401k/ira pattern, so "Roth 401k" classifies correctly) with an
explicit `fire-accounts.json` override file (gitignored, real account
names/ids) taking priority. Unmatched accounts default to `cash-other`,
flagged `source: "default"` so `./actual accounts classify` can surface them
as "needs review" rather than guessing silently. Verified live against the
user's real budget: all 8 real retirement/investment/debt accounts
classified correctly by heuristic alone; the 3 everyday checking/savings/
credit-card accounts correctly fell to "needs review" (not wrong, just
unclassified cash).

**Account balance**: the API has no running-balance field. Computed instead
via the accounting identity `sumTransactionAmounts` — the sum of an
account's entire transaction history since 1970-01-01 *is* its current
balance. Deliberately does NOT flatten splits or exclude transfers (unlike
`fetchAllTransactionsSince`, which does both for other purposes) — a split
parent's amount already equals its children's sum, and a transfer's two
legs are both real postings to two different accounts that must count;
applying either filter here would break the identity, not improve it.
Verified live: a real 401k came back at $543,147.48, and a later
`report fire` run's summed portfolio total ($2,912,155.57 across 7 accounts)
matched the sum of those same accounts' individually-reported balances
exactly.

**Status**: Phases 1-2 complete and verified live (read-only `report
accounts`, dry-run and real `report fire` writing a valid JSON file, gitignored,
never touching anything inside Actual itself). Phase 3 (a `monte-carlo-card`
widget using the `taxTreatment`/`accessAge` fields Phase 1 already computes
but Phase 2 doesn't use yet) is scoped in the plan file but deliberately left
with open sub-questions (allocation preset defaults, tax model, where
`currentAge` comes from) to resolve with the user when that phase starts —
not guessed now.

**How to apply**: the full plan (with the widget schema details, exact
`crossover-card`/`net-worth-card`/`spending-card` field shapes, and Phase 3
scoping) is at `~/.claude/plans/take-a-look-at-ethereal-dawn.md`. New files:
`src/fire-accounts.ts` (+ `.test.ts`), `src/fire-dashboard.ts` (+ `.test.ts`,
the vendored `ExportImportDashboard` types — re-check against upstream
before extending, Actual doesn't version this file independently of its own
releases), `src/accounts-classify.ts`, `src/report-fire.ts`,
`fire-accounts.example.json`. `actual-helpers.ts` gained
`fetchAllOpenAccounts`, `sumTransactionAmounts`, `fetchAccountBalance`.

**Renamed 2026-09-05, same session**: `./actual report accounts` moved to `./actual accounts classify`, its own top-level `accounts` command group (`accountsUsage`/`commandAccounts` in `actual`), not under `report` anymore. `src/report-accounts.ts` renamed to `src/accounts-classify.ts`; `package.json`'s bin entry renamed `report-accounts` -> `accounts-classify`. `report` now has just `fire`.

**Second round of renames + `classify` made interactive, same session, later that day**:
- `fire-accounts.json` -> `accounts.json` (config file name only; the module stays `src/fire-accounts.ts`, types stay `FireAccountsConfig`/`FireAccountOverride`). `DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH` renamed `DEFAULT_ACCOUNTS_CONFIG_PATH`. `fire-accounts.example.json` deleted (no example file anymore).
- `./actual report fire` -> `./actual reports fire` (group `report` -> `reports`; `reportUsage`/`commandReport` -> `reportsUsage`/`commandReports`). `src/report-fire.ts` -> `src/reports-fire.ts`; bin entry `report-fire` -> `reports-fire`.
- `./actual reports fire` now **errors out** (not just warns) when `accounts.json` doesn't exist, instructing the user to run `./actual accounts classify` first — `loadClassifiedAccounts`'s `configFound: false` used to just print a warning and continue with heuristic-only classification; now it's a hard `throw`.
- **`./actual accounts classify` is now fully interactive**, not a read-only listing. For every open account it prompts a numbered choice among the 6 `FireAccountCategory` values (`promptChoice`/`openTtyInterface`, new in `actual-helpers.ts`, refactored out of `confirmViaTty`'s TTY-opening logic so one `/dev/tty` session is reused across every account instead of reopened per-question). Default precedence, per the user's explicit spec: existing `accounts.json` entry for that account, else the name heuristic, else **no default at all** — pressing Enter with no default re-prompts, there is no way to skip an unclassifiable account. `taxTreatment`/`accessAge` are derived automatically from the chosen category via a new `CATEGORY_TRAITS`/`traitsForCategory` lookup in `fire-accounts.ts` (the heuristic rules were refactored to source from the same table, removing the old per-rule trait duplication) — the interactive flow asks only one question per account (category), not three. Every run rewrites `accounts.json` from scratch with one entry per currently-open account (`writeFireAccountsConfig`, new), keyed by account **id** (not name) for robustness against renames.
- Verified live end-to-end via a pty-driven session against the real budget: all 8 real retirement/investment/debt accounts showed the correct heuristic default (bracketed `[N]`), the 3 everyday cash accounts showed no default and required an explicit choice, the written `accounts.json` was byte-correct, `reports fire --dry-run` then succeeded on top of it, and re-running `classify` afterward showed the just-written entries as the new defaults (including for the previously-unclassifiable accounts).
- `promptChoice` (unlike `confirmViaTty`) operates on the abstract `TtyInterface` rather than opening `/dev/tty` itself, so it's genuinely unit-testable with a fake `TtyInterface` double — added real tests for it in `actual-helpers.test.ts`, first real test coverage for any of this session's TTY-prompting code.

**Third round: category rename + split, same session**. `taxable-investment` -> `investment-taxable`; the combined `cash-other` fallback split into two real categories, `cash` and `other` (7 categories total now). The safe default for an unclassifiable account is `other`, not `cash` — `cash` is only ever chosen explicitly (override or interactive answer), since a name the heuristic can't recognize might not actually be cash.

**Real bug found and fixed while doing this rename, worth remembering for any future category rename**: `loadFireAccountsConfig` previously validated only `{version, accounts}` shape, not each override's `category`/`taxTreatment` value. A pre-rename `accounts.json` still on disk (e.g. one written by an earlier session before this rename) has entries like `category: "cash-other"`, which is no longer a member of `FIRE_ACCOUNT_CATEGORIES`. `FIRE_ACCOUNT_CATEGORIES.indexOf("cash-other")` returns `-1`; `accounts-classify.ts`'s old logic treated any non-null category as a valid default index, so `-1` got used as-is, displayed as a nonsensical `[0]` bracket, and if accepted (Enter), `FIRE_ACCOUNT_CATEGORIES[-1]` is `undefined` -- silently writing an entry with **no `category` field at all** (JSON.stringify drops `undefined`-valued keys) into the freshly-rewritten `accounts.json`. Caught this live, not in a test, while re-verifying the interactive flow after the rename with a leftover `accounts.json` from earlier the same session.

Fixed at the right layer: `loadFireAccountsConfig` now validates every override's `category` against `FIRE_ACCOUNT_CATEGORIES` and `taxTreatment` (when present) against a new `TAX_TREATMENTS` array, throwing a clear "unknown category/taxTreatment" error naming the offending `match` -- consistent with the function's existing "fail loudly on malformed config" doc comment, and protects every consumer (`accounts-classify.ts` and `reports-fire.ts` both), not just a defensive patch in one call site. Verified live: a stale `cash-other` entry now errors clearly instead of corrupting the rewritten file; a clean re-run of `classify` against fresh state produces a fully valid `accounts.json` with every entry's `category` a real `FIRE_ACCOUNT_CATEGORIES` member.

**Lesson for next time a category enum changes**: always test the interactive/config-loading path against a config file written by the *previous* version, not just fresh state -- a rename that's airtight against new data can still silently corrupt old data on read.

**Phase 3 (Monte Carlo) implemented, same session, later still**. `./actual reports fire -m --current-age N --target-age N` adds a `monte-carlo-card` widget. All open questions resolved with the user rather than guessed:

- **Allocation preset lives in `accounts classify`'s existing interactive flow**, not a separate interactive step in `reports-fire.ts`. After picking a category, portfolio accounts (retirement/HSA/investment-taxable) get one more numbered question -- a stock/bond mix -- with the same override-then-category-default precedence as the category question itself. This was a real design fork the user raised mid-session (should `reports fire` be interactive too?) and the answer was no: Actual's own Monte Carlo UI is already rich (return model, four withdrawal-rule types, spending phases, contributions, tax model, all with good defaults), so duplicating that as CLI prompts wasn't worth it -- our tool's unique value is the account-level facts Actual can't infer (category, tax treatment, access age, and now allocation), all collected in one place.
- **Allocation preset defaults**: `equity-80` (6.5% mean / 12% stdDev) for retirement-tax-deferred/retirement-roth/investment-taxable, `equity-60` (6%/10%) for hsa. debt/cash/other always get `allocationPreset: null` and are never asked.
- **Flat withdrawal tax rates**: 22% tax-deferred, 15% taxable, 0% tax-free/none. `taxModel: "flat"` explicitly set (matches Actual's own default, set anyway for an explicit, self-documenting generated file).
- **currentAge/targetAge are CLI flags** (`--current-age`/`--target-age` on `reports-fire.ts`), not a new `accounts.json` field -- required together whenever `-m` is given, validated `targetAge > currentAge`.
- **Scope for the rest of the widget**: pots + withdrawalStrategy ("proportional", not asked, low-stakes) + ages + one spendingPhase from the same real trailing-12-month spend already used for the crossover widget + a default `inflationMean: 0.03`. Everything else (returnModel, withdrawalRule, contributions, minimumWithdrawal, inflationStdDev, simulationCount) deliberately left unset so Actual's own UI defaults apply once the widget is opened.

**Two things found by reading Actual's real Monte Carlo source (`monteCarloSimulation.ts`) that would have produced a silently-wrong simulation if missed**:
- **`allocationPreset` alone is not enough.** It's a UI convenience only -- the simulation reads `expectedReturnMean`/`returnStdDev` directly. The vendored `ALLOCATION_PRESET_RETURNS` table in `fire-dashboard.ts` (exact numbers, copied verbatim from Actual's own `ALLOCATION_PRESETS` const) is used to set both fields explicitly on every generated pot alongside the preset label -- setting only the label would have silently fallen back to some other default at simulation time.
- **Monte Carlo Analysis is an experimental Actual feature**, off by default (Settings → Advanced → Experimental features). Both the CLI's own console output (when `-m` is used) and the README say so explicitly, since an imported widget won't render at all until the user turns this on in their own instance.

**New exports**: `fire-accounts.ts` gained `MonteCarloAllocationPreset`/`MONTE_CARLO_ALLOCATION_PRESETS`, `isPortfolioCategory`/`portfolioAccounts` (moved here from `fire-dashboard.ts`, since "which categories count as portfolio" is fundamentally an account-classification concept, not a widget-building one -- `fire-dashboard.ts`'s `portfolioAccountIds` now just wraps it), and `allocationPreset` on `FireAccountTraits`/`FireAccountOverride`/`CATEGORY_TRAITS`. `loadFireAccountsConfig`'s validation extended to also reject an unrecognized `allocationPreset`, same "fail loudly" pattern as category/taxTreatment. `fire-dashboard.ts` gained the vendored Monte Carlo types, `buildPot` (requires a non-null `allocationPreset` at the type level -- callers must filter/validate first, which `buildMonteCarloWidget` does, throwing a clear error naming the account if a portfolio account somehow has none), `buildSpendingPhase`, `buildMonteCarloWidget`.

Verified live end-to-end via a pty-driven `accounts classify` session (confirmed the allocation question only appears for portfolio categories, with correct per-category defaults) followed by `reports fire -m --current-age 45 --target-age 90`: 7 pots generated, each correctly linked by `accountId` (no hardcoded balance), correct return/stdDev per preset, correct tax rate per treatment, spending phase's `annualWithdrawal` matching the console's own printed trailing-spend figure exactly ($276,710.64), both dry-run and a real file write. 164 tests total (14 new for this phase).

**Fourth round, same session: fixed a real "existing accounts.json isn't fully respected" bug + added preset labels.** User reported two issues after using `classify` day-to-day:
- **Bug**: `classifyOneAccount` in `accounts-classify.ts` already consulted an existing override for the `category` and `allocationPreset` prompt defaults, but always recomputed `taxTreatment`/`accessAge` from `traitsForCategory(category)` (the plain category default) unconditionally -- any hand-customized `accessAge` (e.g. a real 401k's actual penalty-free-withdrawal age, which can differ from the generic default) was silently discarded and overwritten on every re-run of `classify`, even when the account's category hadn't changed. A related latent bug: the old `allocationPreset` default (`override?.allocationPreset ?? traits.allocationPreset`) didn't check whether the override's category matched the newly-chosen category, so a stale preset from a *previous* category could wrongly appear as the default for a newly-chosen different category.
- **Fix**: added a `carryOver` value (`override?.category === category ? override : null`) -- only when the account keeps the exact category it already had does `classifyOneAccount` carry forward the existing `taxTreatment`/`accessAge`/`allocationPreset`; changing the category resets all three to the new category's plain defaults instead, since a customization tuned for the old category isn't guaranteed to make sense for the new one. This is the general policy for anything derived from category the interactive flow doesn't ask about directly.
- **Labels added**: new `MONTE_CARLO_ALLOCATION_PRESET_LABELS` (`fire-accounts.ts`) maps each preset to a plain description ("100% stocks", "80% stocks / 20% bonds", etc.), displayed next to each numbered option in the allocation-preset prompt (e.g. `2) equity-80 (80% stocks / 20% bonds)`) -- the stored/returned value is still the bare preset string, only the prompt's display text changed.
- **Verified live** via a pty-driven session with a hand-crafted `accounts.json` giving one real 401k a customized `accessAge: 55` (default for its category is 59) and `allocationPreset: "equity-60"` (default for its category is `equity-80`): re-running `classify` and accepting every default showed `[3: equity-60 (60% stocks / 40% bonds)]` as the allocation prompt's default (not the category's `equity-80`), and the rewritten file preserved `accessAge: 55` untouched, confirming the carry-over gate works correctly when the category is kept the same.

**Fifth round, same session: `-m`/`--monte-carlo` removed, Monte Carlo widget always generated, ages now required.** User ran `reports fire` without `-m` (understandably, since nothing in the default invocation hinted a 4th widget existed), got a 3-widget dashboard, and reported "I don't see the monte carlo card" -- confirmed live: `fire-dashboard.json` on disk had only `net-worth-card`/`spending-card`/`crossover-card`, exactly what the flag-gated design produces without `-m`. Rather than better-documenting the flag, the user asked to remove the opt-in entirely: `reports-fire.ts`'s `-m`/`--monte-carlo` flag and its "requires ages if -m" conditional validation are gone; `--current-age`/`--target-age` are now unconditionally required (parse-time `usage()` error if either is missing), and `buildMonteCarloWidget` is unconditionally pushed onto every generated dashboard. `Options.monteCarlo: boolean` field removed; `currentAge`/`targetAge` are now plain `number` (not `number | null`) once parsed. The experimental-feature Monte Carlo console warning (enable under Settings > Advanced > Experimental features) is now printed on every real (non-dry-run) write, not just when `-m` was passed. README's `reports fire` section and its example invocations updated to match -- `./actual reports fire` alone is no longer a valid invocation; `--current-age`/`--target-age` are always required now, also noted at the account-classify allocation-question mention ("used by the Monte Carlo widget" instead of "used only if you generate the Monte Carlo widget").

**Sixth round, same session: `--current-age`/`--target-age` replaced with birth date + retirement age + an auto-computed horizon.** User flagged that `--current-age`/`--target-age` was bad UX -- current age isn't stable input (should come from a birth date, not be re-typed/re-computed by hand every run) and `--target-age` was really "estimate how long you'll live," which is a weird thing to ask a FIRE tool to make you type. Investigated by pulling Actual's real upstream `monteCarloSimulation.ts` (via `gh api repos/actualbudget/actual/contents/...`, not guessed) to find out what these fields actually drive:
- **`targetAge` has no meaning beyond `horizonYears = clamp(round(targetAge - currentAge), 1, 100)`** (`getMonteCarloHorizonYears`) -- it's pure simulation-length arithmetic, not an independently meaningful field.
- **`currentAge` is the temporal anchor every other age-based field is measured against** -- each pot's `accessAge`, each spending phase's `fromAge`. The engine's own comment: "currentAge is still needed to know when each pot's access age is reached." So it has to be a real, accurate age (from a birth date), not an arbitrary placeholder -- an accessAge of 59 (the standard tax-deferred retirement penalty-free-withdrawal age) only means the right thing if currentAge is real.
- **Non-obvious engine quirk, worth remembering for any future spendingPhases work**: with a *single* spending phase, its `fromAge` is a no-op. The per-year loop initializes `amount` from `spendingPhases[0].annualWithdrawal` *before* checking any `fromAge` condition, and only overwrites it if a later-sorted phase's `fromAge` has been reached (`plannedTodayByYear` loop in `runMonteCarloSimulation`). So a single phase's amount applies to literally every year regardless of what `fromAge` says on it -- `fromAge` only matters once there are 2+ phases.

Resolved with the user (all confirmed, no guessing): `--retirement-age` required (no default); a fixed default planning horizon of **age 100**, but with an optional `--plan-to-age N` override (not just hardcoded); pre-retirement annual withdrawal is **$0** (assumes other income covers pre-retirement spending -- the standard "still working" FIRE-calculator convention), not the same as post-retirement spend. Birth date source: `AB_BIRTH_DATE` env var (personal, stable, like `AB_BASE_URL`), overridable per-run via `--birth-date YYYY-MM-DD`; erroring clearly if neither is set.

**Implementation**:
- `actual-helpers.ts` gained `ageFromBirthDate(birthDate, asOf = new Date())` -- pure, takes an injectable `asOf` for calendar-independent tests, reuses `validateDateFormat` for the `YYYY-MM-DD` check, throws if the computed age is negative (birth date in the future).
- `fire-dashboard.ts`: `buildSpendingPhase` (singular) replaced with `buildSpendingPhases(currentAge, retirementAge, annualSpendCents)`, which returns **one** phase (`fromAge: null`, real spend) when `retirementAge <= currentAge` (already retired, or retiring today/in the past -- these collapse identically since the engine only cares about `fromAge <= age`, not exact equality timing), or **two** phases (`{fromAge: null, annualWithdrawal: 0}` then `{fromAge: retirementAge, annualWithdrawal: <real spend>}`) for a future retirement age -- this is the fix that makes retirement age actually change the simulation, given the single-phase no-op quirk above. `buildMonteCarloWidget`'s signature gained a `retirementAge` parameter (now `(x, y, accounts, currentAge, retirementAge, targetAge, annualSpendCents)`).
- `reports-fire.ts`: `--current-age`/`--target-age` gone. New: `--retirement-age N` (required), `--birth-date YYYY-MM-DD` (optional, overrides `AB_BIRTH_DATE`), `--plan-to-age N` (optional, default `DEFAULT_PLAN_TO_AGE = 100`). `main()` computes `currentAge` via `ageFromBirthDate`, validates `planToAge > currentAge` (same "must be greater than" pattern as the old current/target validation), and passes `(currentAge, options.retirementAge, options.planToAge)` into `buildMonteCarloWidget`.
- Tests: `actual-helpers.test.ts` gained an `ageFromBirthDate` describe block (whole-years counting, not-yet-had-birthday-this-year, malformed-date rejection, future-birth-date rejection). `fire-dashboard.test.ts`'s `buildSpendingPhase` describe became `buildSpendingPhases` (both branches tested); `buildMonteCarloWidget` tests updated for the new `retirementAge` argument plus a new case asserting a future retirement age threads through into the split phases. 170 tests total (6 new).
- Verified live against the real budget: `--retirement-age 60 --birth-date 1985-03-22` correctly produced `currentAge: 41`, `targetAge: 100` (default), and the two-phase split (`$0` until 60, then the real `$276,710.64/yr` trailing spend from 60 on); `--retirement-age 30` (in the past) correctly collapsed to the single always-on phase; `--plan-to-age 95` correctly overrode the default; `--plan-to-age 30` (below current age) correctly errored; `AB_BIRTH_DATE` env var and its `--birth-date` override both resolved to the expected `currentAge`; missing both birth-date sources errored clearly.
- README: `reports fire`'s usage line, flag docs, prose (spending-phase-split explanation), and example invocations all rewritten; `AB_BIRTH_DATE` added to the top-level config env var table with a note it's `reports-fire`-only (the table's other four vars are truly global across every command).

**Seventh round, same session: compare multiple retirement ages.** User wanted several retirement ages plotted, "preferably on a single monte carlo chart." Checked Actual's real widget model (`dashboard.ts`'s `MonteCarloWidget` type, `monteCarloSimulation.ts`) and the Monte Carlo UI directory (`MonteCarlo.tsx` etc.) for any multi-config comparison feature -- none exists. Every "scenario" in that codebase means one of the N individual simulation *runs* within a single config's percentile bands, not a distinct user-configured comparison. **A single `monte-carlo-card` widget holds exactly one config; there's no overlay/compare mode.** Told the user this constraint plainly rather than guessing around it, then implemented the closest real equivalent: one stacked widget per retirement age on the same dashboard page.

- `--retirement-age` on `reports-fire.ts` is now **repeatable** (`retirementAges: number[]`, `.push()`-accumulated), following this repo's existing repeatable-flag convention (`-c/--category` in `anomalies.ts`/`set-budget.ts`). Validation message follows the same house style: `"At least one --retirement-age is required."` (mirrors `anomalies.ts`'s `"At least one -c/--category is required."`).
- `fire-dashboard.ts`: `buildMonteCarloWidget` gained an optional trailing `name` parameter (default `"Monte Carlo"`, backward compatible with every existing call site/test). New `buildMonteCarloWidgets(x, y, accounts, currentAge, retirementAges, targetAge, annualSpendCents)` maps over the ages, stacking each widget's `y` by a new exported `MONTE_CARLO_WIDGET_HEIGHT` constant (4, matching the widget's own `height`) so they never overlap. A single age keeps the plain `"Monte Carlo"` name (no behavior change for the common case); 2+ ages get `"Monte Carlo — Retire at ${age}"` per widget so they're distinguishable on the page.
- `reports-fire.ts`'s `main()` now does `dashboard.widgets.push(...buildMonteCarloWidgets(...))` (spread, since it returns an array) instead of pushing one widget.
- Tests: `fire-dashboard.test.ts` gained a `buildMonteCarloWidgets` describe block (single-age plain name, multi-age unique names + correct non-overlapping stacked `y` coordinates + per-widget correct spending phases) plus a `buildMonteCarloWidget` name-override test. 174 tests total (4 new).
- Verified live: `--retirement-age 55 --retirement-age 60 --retirement-age 65` produced three `monte-carlo-card` widgets at `y: 6, 10, 14` named `"Monte Carlo — Retire at 55/60/65"`; a single `--retirement-age 60` still produces one widget named plain `"Monte Carlo"` (no regression for the common case); omitting `--retirement-age` entirely still errors clearly.
- README: `--retirement-age` flag description, a new "Comparing multiple retirement ages" callout explaining the stacked-not-overlaid reality, and a three-age example invocation added.
