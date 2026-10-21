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

**The sandbox's docker host IS the NAS (`tartalenas.local`/`10.0.1.3`) -- hairpin-NAT gotcha
(found/fixed 2026-10-21)**: this sandbox container and the NAS's own `actual-http-api` server
(linked mode's REST dependency, `data/session.json`'s `baseUrl`) run on the *same physical
machine*. A bridged container can't loop back out to the host's own LAN-facing IP to reach a
sibling service on that same host (classic docker hairpin-NAT limitation) -- so raw TCP from
inside this sandbox to `tartalenas.local`/`10.0.1.3:5007` times out on every port, even though the
host is right there and the NAS is healthy. Symptom in the app: linked mode's connected
REST calls fail with `UND_ERR_CONNECT_TIMEOUT` even though "other tools" (anything hitting the NAS
from outside this sandbox) work fine.

**Fix**: the sandbox's docker run config needs `--add-host tartalenas.local:<gateway-ip>` (the
docker bridge gateway, confirmed stable at `172.17.0.1` -- check `cat /proc/net/route`'s Gateway
column, or `cat /etc/hosts` for the entry, if it's ever rebuilt differently). Two things that look
like fixes but aren't:
- `--add-host tartalenas.local:host-gateway` -- the magic keyword didn't survive Synology
  Container Manager's own `/etc/hosts` regeneration on this NAS (DSM rewrites the file post-start
  with its own template, visible by its header comment "Any manual change will be lost..." --
  clobbers plain `ExtraHosts` silently even though `docker inspect` shows it set correctly).
- `--add-host tartalenas.local:10.0.1.3` -- the real LAN IP, same as plain DNS resolution already
  gave for free; still hits the hairpin-NAT dead end. Must be the **gateway** IP, not the host's
  own LAN-facing IP, even though they're the same physical machine.

**How to check after any sandbox restart** (this is a recurring risk, not a one-time fix -- a
re-provision could silently drop the flag or revert to `host-gateway`/the LAN IP): `cat /etc/hosts`
should show `172.17.0.1 tartalenas.local`; then confirm end-to-end with
`curl -s --max-time 15 http://localhost:4276/api/retirement/check` (should return real account
data, not hang).
