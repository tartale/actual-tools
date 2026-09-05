---
name: fire-dashboard
description: "Status/design for ./actual reports fire and ./actual accounts classify (interactive), a FIRE dashboard built on Actual's own native dashboard widgets"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-05T03:30:18.975Z
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
