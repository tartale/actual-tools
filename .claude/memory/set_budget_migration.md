---
name: set-budget-migration
description: "Status/decisions for replacing balance-to-zero.sh with a TypeScript set-budget.ts, and why"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5809572f-3c7a-469d-b142-d0b41ca0bf68
  modified: 2026-09-04T19:09:30.919Z
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
- Node 26 (installed) runs `.ts` files **natively** — direct shebang exec
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

**How to apply**: when resuming this work, read the full plan at
`~/.claude/plans/idempotent-scribbling-gosling.md` (file layout: flat
`actual-helpers.ts` + `set-budget.ts` + `actual-helpers.test.ts` at repo
root, mirroring the existing bash scripts' convention; `match-uncleared.sh`
stays bash, untouched). `actual-helpers.ts` has an exploratory WIP draft
already committed (not yet finalized/wired to a CLI or tests) — treat it as
a starting point, not final. The [[actual-budget-api-shape]] memory has the
live REST API details this module wraps. Work is continuing in a
claude-sandbox environment (config added under `.claude/sandbox/`).
