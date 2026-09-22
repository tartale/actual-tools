---
name: actual-service-stop-gotcha
description: "FIXED 2026-09-22 (twice, same day) -- ./actual service stop used to always tear down the production container too, regardless of -p/--dev; later that day, a SEPARATE bug meant --dev was silently ignored entirely (stop/status both always targeted the container port). Kept for the historical reasoning and the still-true dev-server-is-always-fair-game rule."
metadata: 
  node_type: memory
  type: project
  originSessionId: e2895bd5-4b33-4a55-8b6d-f01dc8ec722d
  modified: 2026-09-22T00:00:00.000Z
---

**Second, separate bug found and fixed later the same day (PR #48)**: after the first fix below,
`serviceStop`/`serviceStatus` still silently DROPPED `--dev` entirely (swallowed by the `*) shift
;;` catch-all) and always computed `defaultPort(mode, false)` -- the CONTAINER port -- regardless.
So `./actual service stop --dev` no longer endangered the container (the fix below made sure of
that), but it also did nothing useful at all: it looked for a process on the wrong port, found
nothing, and reported success. Caught live right after merging [[detached-mode]]'s unification PR:
two `stop --dev` calls both reported success, but the old dev processes kept running and kept
serving stale, pre-merge responses -- see [[fresh-restart-dev-servers-on-landing]] for the incident
and the resulting standing practice (restart dev servers fresh after every landing, don't trust a
stop step's own report). Both functions now parse `--dev` correctly and skip docker entirely when
it's set.

**Fixed 2026-09-22, as a side effect of [[detached-mode]]'s own rework** -- adding a second
always-on compose service (`app-detached`, alongside the original `app`) forced `serviceStop` to
stop using `docker compose down` (whole-PROJECT teardown, including the shared network both
services depend on) at all; it now runs `docker compose rm -sf <service>`, scoped to just the one
compose service `--mode` selected (default `linked`, i.e. `app`/`actual-tools`, unchanged target
from before). The bug described below is gone: `-p`/`--dev` alone no longer silently take down the
production container, because there is no longer an unconditional, unscoped teardown path at all.
**`--dev` was never meant to touch the container at all** -- it only ever launches a bare
`node --watch` process directly; the description below documents the OLD failure mode for context,
not current behavior.

**New standing rule, stated directly by the user (2026-09-22): a dev server (any of the four ports
now -- see [[detached-mode]]) can be wiped/restarted at any time, by any developer, no permission
needed.** This is narrower than it sounds: it's about DEV servers specifically (ports ending in the
`--dev` range, `4278`/`4279`), not the deployed containers (`4276`/`4277`), which still warrant the
normal care around shared/production state. Concretely: finding a dev server running stale code
(e.g. after a merge) is not a "should I ask first" moment -- just `kill` the PID and restart it.
The original incident below (accidentally taking down PRODUCTION while trying to restart dev) is
still the cautionary tale for why container vs. dev-process boundaries matter, but the fix above
plus this rule together mean the dev side of that boundary no longer needs the same hesitation.

---

**Original bug (fixed above, kept for the reasoning):** `./actual service stop` (`serviceStop` in
the `actual` script) used to unconditionally run `docker compose down` whenever the `actual-tools`
container existed, before it even looked at a `-p`/`--port` flag. The port argument only controlled
which port's *process* got killed for the non-container case -- it did not scope or skip the
container teardown. `--dev` was not a flag this subcommand recognized at all (it was silently
ignored, matching the script's `*) shift ;;` catch-all).

Concretely: `./actual service stop --dev` and `./actual service stop -p 4279` BOTH stop the
production container on 4247, even when the actual goal is only to restart the dev server on a
different port.

**Why this matters**: hit this directly -- ran `./actual service stop --dev` meaning to restart
just the dev server after a code change, and it took down the live production container instead
(twice, since the first recovery attempt via `-p 4279` repeated the same mistake). No data loss
(bind-mounted `data/` is untouched by `docker compose down`), but real avoidable downtime.

**How to apply**: to restart only the dev server, find its PID directly (`ps aux | grep app.ts`,
matching `node --watch ./src/app.ts` and its spawned worker) and `kill` it by PID, then relaunch
with `node --watch ./src/app.ts --port <port> --no-open &`. Never use `./actual service stop` for
this -- it is only for the production container, whatever port/flag is passed. If the container
does get stopped by accident, `source .envrc && ./actual service start` restores it (compose
recreates the container from the same image + bind mount, nothing lost) -- but note `source .envrc`
must NOT be piped into anything else on the same line (`source .envrc | tail` runs the source in a
subshell and its exports evaporate) or `AB_DATA_DIR` won't take effect and the recreate fails with
a bind-mount error.
