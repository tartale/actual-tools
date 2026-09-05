---
name: set-budget-migration
description: "Status/decisions for the completed replacement of balance-to-zero.sh with a TypeScript set-budget.ts, and why"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5809572f-3c7a-469d-b142-d0b41ca0bf68
  modified: 2026-09-05T01:57:01.027Z
---

`balance-to-zero.sh` is being fully replaced (no backward compat) by
`set-budget.ts` — a CLI supporting four actions: `balance` (existing
zero-the-balance behavior), `previous` (set budget to the previous single
month's actual spending), `previous-3`, `previous-12` (average the previous
3/12 months' actual spending, sign-flipped positive). Confirmed with the
user: `previous` is a single prior month, NOT the same as `previous-3` (the
original spec wording was ambiguous/typo-like); all history-based actions
use actual **spending**, not what was previously **budgeted**.

The rewrite moved from bash to TypeScript. Decision drivers:
- Node runs `.ts` files **natively** (type stripping is on by default from
  Node 22.18; the sandbox has v22.23.1, so the earlier "Node 26" note in the
  plan is wrong about the version but right about the capability) — direct shebang exec
  (`#!/usr/bin/env node` on a `.ts` file), relative imports with explicit
  `.ts` extensions, types/interfaces fully erased at runtime. No
  `tsx`/`ts-node`/build step needed to run the script, and no
  `jq`/`curl`/`gdate` dependency either (`fetch`/`Date` built in).
  `typescript`/`vitest` are devDependencies only, for `tsc --noEmit` /
  tests — not needed to execute `set-budget.ts` itself.
- The user is also considering a future FIRE (early-retirement) forecasting
  add-on to Actual Budget (possibly a custom report, possibly a standalone
  service) — that would almost certainly be TypeScript/Node too (Actual's
  own ecosystem, `@actual-app/api` is JS/TS). Writing the Actual REST
  client + month/currency helpers in TS now means they're reusable there,
  rather than being bash throwaway work.

**Why**: avoids re-deriving the same API client in TS later for the FIRE
tool, and Node's native TS support means there's no real cost (no build
step, no extra runtime deps) to making this switch now.

**Status (2026-09-04): implemented, verified and pushed to main.**
The TypeScript sources live under `src/` (`actual-helpers.ts`,
`set-budget.ts`, `actual-helpers.test.ts` — 39 vitest tests) with
`package.json`/`tsconfig.json` at the root; `balance-to-zero.sh` is
`git rm`'d; `match-uncleared.sh` untouched. Typecheck and tests pass, and the
four actions plus category/group filtering were verified live against the
real budget.

One addition beyond the original plan: a `-n`/`--dry-run` flag that also
honours `DRY_RUN=true` (the convention `match-uncleared.sh` and `.envrc`
already use). Added after a live smoke test wrote a real budget value — the
write was correct per spec and was reverted immediately, but there was no
safe way to exercise the write path without it.

All tasks now run through the `./actual` dispatcher at the repo root
(`build`, `lint`, `test`, `budget set-values`, `budget match-uncleared`);
`budget match-uncleared` still execs the bash script pending its port.

**Income categories are a hard exclusion in `set-values`** (2026-09-04):
`shouldUpdateCategory` returns false unconditionally for any category with
`is_income: true`, regardless of `-c` filters — this also fixed a latent bug
where a no-filter sweep would have hit income categories and computed NaN
budgets, since the Actual API returns `received` for income categories
instead of `budgeted`/`spent`/`balance`. On top of that, an explicit `-c`
that names an income category or its parent group (by id or name) is a
fail-fast error via `findIncomeFilterMatches`, checked before any month data
is fetched — the user wants a no-filter sweep to skip income silently, but
an explicit filter naming income to be a hard, immediate error rather than a
silent no-op.

**Every `--help` in this repo shares one typer/rich-inspired look** (2026-09-04),
per the user's request: a bold `Usage:` line, then labelled `─ Section ────`
rules with a name/description column aligned per-section. Checked for an
existing Node library first (per the user's explicit preference to reuse one
over hand-rolling); none matched without a real downside — `citty` was
closest but doesn't auto-detect non-TTY output (colour leaks into redirected
files unless the caller sets `NO_COLOR`), and the framework-style libraries
(commander, gunshi) don't produce this layout by default at all. Landed on
hand-rolling with zero new dependencies: `src/cli-format.ts` (`renderHelp`)
for the TypeScript CLI, using `node:util`'s built-in `styleText` — confirmed
it does per-stream TTY/color-depth detection correctly on its own (stdout and
stderr judged independently), so no manual TTY-check code was needed there.
`lib/cli-format.sh` is the bash equivalent (`cliUsage`/`cliRule`/`cliSection`),
sourced by both `actual` and `match-uncleared.sh`, checking `[[ -t 2 ]]` and
`NO_COLOR` by hand since bash has no equivalent built-in. `./actual budget`
gained its own `--help` (a "Subcommands" list) where before it only errored
with no subcommand given. Along the way, fixed `-h`/`--help` to exit 0 (was
exiting 1, i.e. treated as an error) in `actual` and added `-h`/`--help` to
`match-uncleared.sh`, which previously had no help flag at all.

**`./actual budget anomalies` added** (2026-09-05): flags a category/month
whose spending deviates sharply from that category's own trailing 12-month
history, and optionally tags the responsible transaction(s). Detection is a
MAD-based modified z-score (Iglewicz & Hoaglin), chosen over a plain
mean/stddev z-score or a simple %-of-average test because personal-finance
categories are often lumpy (an annual payment isn't "anomalous" just because
11 of 12 months are $0) — MAD's median-based math resists exactly the single
past outlier that would otherwise skew a mean-based baseline. Pure math lives
in `src/anomaly-detect.ts` (`detectAnomaly`), fully unit-tested with no API
dependency, reusable outside this Actual-specific context if ever needed.

Two-level detection, confirmed with the user: level 1 flags the category/month
against its own monthly `spent` history; level 2, only for a flagged
month and only when `-t` is given, re-runs the same MAD test against that
category's individual historical transaction amounts to find which specific
transaction(s) are themselves outliers — not just "the biggest one" naively.
If none of them individually clears the bar (the excess is spread across
several ordinary transactions), the fallback — the user's explicit choice
over "tag nothing" — is to tag the single largest transaction in that
category/month, so a flagged month is never left with nothing tagged.

Tags are `#anomaly-high`/`#anomaly-low` (direction only, not magnitude or
z-score) prepended into the transaction's `notes` field via plain string
concatenation — confirmed with the user this is exactly the same mechanism
`match-uncleared.sh` already uses for `#cleared`, nothing Actual-API-specific.
Precise numbers (dollar figures, historical median) go in the console log
line, not the tag, so the tag stays stable across any future retuning of the
detection formula.

Real-world correctness finds during implementation, both confirmed live
against the actual budget before writing any code around them:
- **Split transactions**: a "parent" transaction has `category: null` and an
  amount spanning every category in the split; the real per-category
  amount/notes live on each child inside `.subtransactions`, which do NOT
  also appear at the top level of the account's transaction list. Missing
  this would have silently under-counted or mis-attributed every split.
  `flattenTransactions` in `actual-helpers.ts` replaces a parent with its
  children before any category filtering happens. Verified a child's own id
  is independently PATCH-able (a real, reversible round-trip PATCH against
  the live budget, writing back the exact same notes value it already had).
- Individual transaction `.amount` uses the same sign convention as category
  `.spent` (negative for outflow) — confirmed live rather than assumed, since
  a mismatch here would have silently inverted every "high"/"low" label.
- No per-category transactions endpoint exists; transaction-level fetches
  reuse `match-uncleared.sh`'s existing pattern (fetch every on-budget
  account's transactions via `since_date`, filter client-side).

Also fixed while building this: `renderHelp` (`src/cli-format.ts`) wasn't
word-wrapping the top-level page description, only per-entry descriptions —
invisible until this command's longer description exposed it at normal
terminal widths.

**Two more `set-values` actions added** (2026-09-05): one copies last month's
**budgeted** figure forward (`fetchPreviousBudgeted`, reads
`CategoryMonth.budgeted`) — the odd one out among the actions, since every
other one derives from actual *spending*, not what was previously budgeted.
And the ACTION argument can now be a literal dollar amount instead of a
preset (`parseDollarAmount`, e.g. `set-values 249.99 2026-08`) — tried as a
fallback only after `isAction()` fails, parsed as a plain decimal string (no
`$`, up to 2 decimal places) and rounded to cents to avoid float imprecision.
`Options.action` is now `Action | number`; `computeNewBudget` dispatches on
`typeof action === "number"` first, then `"balance"`/budgeted-copy/history.

**Renamed right after, same session**: the original three spending-average
actions (`previous`/`previous-3`/`previous-12`, N=1/3/12 months of actual
spending) became `spent`/`spent-3`/`spent-12`, freeing up the name `previous`
for the new budgeted-copy action above (which had briefly been called
`repeat`). So today: `previous` = last month's *budgeted* amount,
`spent`/`spent-3`/`spent-12` = actual spending averages. `HistoryAction` is
now `"spent" | "spent-3" | "spent-12"`; `HISTORY_MONTHS` keys match. Easy to
mix up when reading old commit messages/plan text that still say "previous"
meaning the pre-rename spending action — check the date.

**`match-uncleared.sh` ported to TypeScript** (2026-09-05, `src/match-uncleared.ts`);
the bash file is `git rm`'d, matching the precedent set when `balance-to-zero.sh`
was replaced — no backward-compat shim. `lib/cli-format.sh` stays, since
`actual`'s own top-level/`budget` help still uses it.

**Correction (still 2026-09-05, same session)**: initially assumed tagging
both sides of a matched pair was the intended behavior, since the bash
help text said so and only the uncleared side was ever actually patched
(`clearedId`/`clearedNotes` computed and unused — flagged as a discrepancy
pending this port, in an earlier session). The user corrected this: the
bash *implementation* was right all along — only the uncleared transaction
should ever be tagged — and it was the bash *help text* that was stale.
Reverted to uncleared-only tagging (`patchTransactionNotes` called once, on
the uncleared side only); the cleared transaction is read to confirm a
match but never written to. Help text/README now say this explicitly. Don't
re-introduce both-sides tagging without asking again.

One real fix made during the port, confirmed with the user before
finalizing:
- **`DRY_RUN`/`-n` now actually prevents the write.** The bash version called
  `curlWithStatus` (the PATCH) unconditionally, and only used `DRY_RUN` to
  skip checking the response afterward — the write always fired regardless.
  Added an explicit `-n`/`--dry-run` flag too, matching `set-values` and
  `anomalies`.

**Deliberately NOT changed, despite a real false-positive found live against
the actual budget**: the match is by transaction *magnitude* only, never
sign, in both the original bash and the port — confirmed live that this lets
an unrelated refund (+$801.15) match an unrelated charge (-$524.81, same
payee, close in time) as if they were the same event. Asked the user whether
to add a same-sign requirement; they said keep the original matching as-is
and fix the *documentation* instead — the tool's real purpose is catching a
transaction that got re-imported as a second, separate row (pending →
posted) rather than updated in place, not general "similar nearby charges"
detection. The help text and README now describe that purpose explicitly;
the matching logic itself is untouched. If this class of false match becomes
a real nuisance later, a same-sign check is the fix to revisit.

`findMatchingTransaction` in `actual-helpers.ts` is the ported core (pure,
fully unit-tested): same account, normalized payee (`normalizePayeeName` —
lowercase, collapsed whitespace, trimmed), cleared candidate dated strictly
after the uncleared transaction and within 5 days, magnitude no more than
30% above the uncleared amount (no lower bound) — `Array.prototype.find`
naturally replicates jq's `first(select(...))`, first-in-array-order
semantics, not closest-match. `Transaction` gained `cleared`/`tombstone`
fields for this. `addDays`/`validateDateFormat` mirror the existing
`addMonths`/`validateMonthFormat` pattern for day-level date math.

**How to apply**: the full plan snapshot is at
`.claude/plans/set-budget-migration.md` in the repo (the machine-local copy
`~/.claude/plans/idempotent-scribbling-gosling.md` does not exist in the
sandbox). The [[actual-budget-api-shape]] memory has the live REST API
details `actual-helpers.ts` wraps — that module is the piece meant to be
reused by any future FIRE forecasting tool. Work happened in a claude-sandbox
environment (config under `.claude/sandbox/`).
