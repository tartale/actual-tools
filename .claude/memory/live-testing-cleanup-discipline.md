---
name: live-testing-cleanup-discipline
description: A verification-cleanup PATCH piped to /dev/null during live-data testing left the user's real config.json in a wrong state across turns, undetected until later -- always verify a reset's response, never fire-and-forget it
metadata:
  node_type: memory
  type: project
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
