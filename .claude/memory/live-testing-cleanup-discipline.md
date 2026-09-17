---
name: live-testing-cleanup-discipline
description: "A verification-cleanup PATCH piped to /dev/null during live-data testing left the user's real config.json in a wrong state across turns, undetected until later -- always verify a reset's response, never fire-and-forget it"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2895bd5-4b33-4a55-8b6d-f01dc8ec722d
  modified: 2026-09-17T03:47:46.323Z
---

While live-testing the crossover/withdrawal-rule/tax-bands pinning features (see
[[crossover-self-containment]]) against the user's real, running dev server, several cleanup PATCH
calls meant to reset test values back to null were piped to `/dev/null` or otherwise never had their
response checked. One of those resets silently didn't take effect (or took a different effect than
intended) -- discovered a full conversation turn later, when `dashboard.monteCarloTaxModel` was
found to be `"flat"` in config.json instead of the `"bands"` it had been at the very start of the
session, and four crossover assumption fields were pinned to values that exactly matched the live
Actual widget rather than staying null. No single tool call could be identified with certainty as
the cause after the fact -- the forensic trail was already cold.

**Why this matters here specifically**: this app's dev server operates on `/workspace/config.json`,
a real file holding the user's actual retirement plan (gitignored, never a fixture) -- every
`curl`/Playwright round against `http://localhost:4279` during a live-verification pass writes to
that same file. There is no separate test config to break instead.

**How to apply**: when a testing round ends with "now reset this back," always capture and read the
reset PATCH's own response (or a follow-up GET) before moving on -- never pipe a cleanup/reset call
to `/dev/null` or otherwise skip confirming it landed, even when the round already "obviously
worked." If a discrepancy is ever found later anyway, don't guess-restore a specific value from
memory with false confidence (the crossover fields could plausibly have been the user's own
deliberate pin, not a leftover) -- reset the affected field to its true default (null/unpinned,
"defer to Actual") and say so plainly, rather than picking a specific number and hoping it's right.

**Second occurrence (2026-09-17):** while live-verifying the `mortgageBalanceAsOf` zero-clearing fix
(a bug report about not being able to clear "Extra Principal"), I typed `0` into the mortgage's
"Balance as of" field on the user's real Prince Circle Mortgage account to exercise the
`zeroBehavior: "allow"` path, and never reset it back afterward -- same failure as above, several
turns later a different task ("let's make that panel even smaller" for the toolbar) ran to
completion before the user reported "I don't see my debt payoff marker anymore" on an unrelated
later turn. Root cause: `calculateMortgagePayoff` (fire-analysis.ts) treats `balanceAsOf <= 0` as
"already paid off" (`monthsRemaining: 0`), so the leftover `0` silently suppressed both the Bridge
chart's "Debt Paid Off" marker and the summary tile -- a real feature going quietly missing, not an
error. The same test also left `mortgageExtraPrincipal` cleared entirely (that field's own
zeroBehavior is `"clear"`, so typing `0` there correctly nulled it out -- correct behavior for the
bug being verified, but still a leftover once the verification was done).

**Recovery technique worth reusing**: this time, unlike the first occurrence, the exact original
values were recoverable -- `/workspace/data/config.json` (the container/prod-mounted copy, not
touched by dev-server testing; see [[sre-deployment-responsibility]]'s dev-vs-container split) still
had the real `mortgageBalanceAsOf: 52469806` and `mortgageExtraPrincipal: 50000`. Before assuming a
value is unrecoverable and falling back to "reset to null and say so," check whether a second,
untouched copy of the same data exists (a container-mounted config, a recent export, a git-tracked
fixture) -- diff just the specific fields suspected of drifting (not the whole file/account, since
the two copies can have OTHER, legitimate differences from normal dev-ahead-of-prod drift) and
restore only those via the real API, not a raw file overwrite.
