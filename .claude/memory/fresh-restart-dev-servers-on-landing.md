---
name: fresh-restart-dev-servers-on-landing
description: "Whenever work lands on main, do a fresh restart of the linked/detached --dev servers -- don't leave a stale process serving pre-merge code"
metadata:
  node_type: memory
  type: feedback
---

Whenever a PR merges to `main`, do a fresh restart of BOTH `--dev` servers (linked port 4278,
detached port 4279) against the new `main`, not just leave whatever was already running.

**Why**: stated directly by the user (2026-09-22) right after hitting this in practice --
`./actual service stop --dev --mode linked`/`--mode detached`, run right after merging
[[detached-mode]]'s unification PR, both reported success but left the actual dev processes
running untouched (a real bug in `./actual` itself: `serviceStop`/`serviceStatus` silently
dropped `--dev` and always targeted the CONTAINER port -- fixed same session, PR #48). The user
then hit a stale, pre-merge error (`annualExpenses must be a non-negative number` -- a route shape
that predated the unification) on port 4279 because the old process was still answering requests
there. A fresh restart after every landing is the general practice that makes this class of bug
harmless even if a stop step silently fails again some other way.

**How to apply**: after a merge (or any time `main` moves), kill and restart both dev servers:
```
./actual service stop --dev --mode linked
./actual service stop --dev --mode detached
./actual service start --dev --mode linked   # background/disown -- long-running
./actual service start --dev --mode detached # background/disown -- long-running
```
If `service stop --dev` reports "Nothing to stop" or "process could not be identified" but a dev
port still answers a request, don't trust the stop's own report -- confirm via `curl .../api/mode`
or `ps aux | grep app\.ts`, and kill directly by PID if needed (see [[pgrep-self-match]] for the
`pgrep -f` self-match gotcha when doing this by hand). Consistent with the standing "dev servers
can be wiped/restarted any time by any developer" rule (see [[actual-service-stop-gotcha]]) -- this
just makes doing so the default after every landing, not only when something looks wrong.
