---
name: actual-service-stop-gotcha
description: "./actual service stop always tears down the production container too, regardless of -p/--dev -- use kill on the dev server's own PID instead"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2895bd5-4b33-4a55-8b6d-f01dc8ec722d
  modified: 2026-09-16T22:30:34.252Z
---

`./actual service stop` (`serviceStop` in the `actual` script) unconditionally runs `docker compose
down` whenever the `actual-tools` container exists, before it even looks at a `-p`/`--port` flag.
The port argument only controls which port's *process* gets killed for the non-container case --
it does not scope or skip the container teardown. `--dev` is not a flag this subcommand recognizes
at all (it's silently ignored, matching the script's `*) shift ;;` catch-all).

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
