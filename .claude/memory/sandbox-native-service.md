---
name: sandbox-native-service
description: actual-tools' own production deployment now runs inside this sandbox container itself (native node process, no NAS/docker-socket) -- ports, data path, pidfile scheme, SessionStart hook; supersedes sre-deployment-responsibility
metadata:
  node_type: memory
  type: project
---

As of 2026-10-21, this sandbox's docker CLI and socket were removed (security) and the
NAS-hosted production containers were stopped, per [[sandbox-runs-the-service]] (the general
shape, first established the same day on a different project). actual-tools' production now runs
*inside this sandbox container*, natively, not via docker on the NAS.

**`./actual service start/status/stop/restart/logs`** now branch on a `dockerAvailable()` check
(not cached -- rechecked every call, since availability can change across sandbox rebuilds):
- Docker present: original `docker compose up -d` path, unchanged -- this stays correct for any
  external user self-hosting via the published `ghcr.io` image or `compose.yaml` directly.
- Docker absent (this sandbox, now): native fallback -- a plain background `node` process, pidfile
  + logfile under `<repo>/.tmp/run/<mode>/` (already gitignored). Killed by pidfile
  (`kill`/`kill -9` after a 10s wait), never `pkill -f` ([[pgrep-self-match]]). `status` uses a real
  HTTP check (`httpOk()` against `/api/dev/build-id`), not just a TCP connect, and reports
  `up`/`wedged`/`down`.
- The native path **never reads `AB_DATA_DIR`** (a NAS-host-absolute path meaningful only to a
  remote docker daemon's bind-mount resolution) -- it always uses this repo's own `./data`, where
  the real, live `config.json`/`session.json` already sit. No `.envrc` sourcing needed for the
  native path at all; that gotcha only applies to the (now unused) docker-on-NAS path described in
  the superseded [[sre-deployment-responsibility]].

**Two instances, same as before**: linked on port `4276`, detached on `4277` (dev ports `4278`/
`4279` unchanged). Both currently run natively and are expected to stay up continuously.

**Boot**: a `SessionStart` hook in `.claude/settings.json` runs `./actual service start` (linked)
then `./actual service start --mode detached` idempotently every session start, since this
sandbox's Claude process is effectively the container's own init/boot sequence and nothing else
supervises these processes across a container restart.

**How to apply**: after any sandbox restart, run `./actual service status [--mode detached]` for
both and report; after merging a change to `main`, redeploy both the same way
[[sre-deployment-responsibility]] used to describe (build isn't needed -- no build step exists;
just `service restart` both modes, or let the next session start's hook catch it).
