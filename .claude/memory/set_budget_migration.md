---
name: set-budget-migration
description: "Status/decisions for the completed replacement of balance-to-zero.sh with a TypeScript set-budget.ts, and why"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5809572f-3c7a-469d-b142-d0b41ca0bf68
  modified: 2026-09-04T19:30:00.000Z
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

**How to apply**: the full plan snapshot is at
`.claude/plans/set-budget-migration.md` in the repo (the machine-local copy
`~/.claude/plans/idempotent-scribbling-gosling.md` does not exist in the
sandbox). The [[actual-budget-api-shape]] memory has the live REST API
details `actual-helpers.ts` wraps — that module is the piece meant to be
reused by any future FIRE forecasting tool. Work happened in a claude-sandbox
environment (config under `.claude/sandbox/`).
