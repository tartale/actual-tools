---
name: sre-deployment-responsibility
description: The dev session is also SRE for this project now -- after shipping, rebuild the container image and restart the running instance, not just merge the PR
metadata:
  node_type: memory
  type: feedback
---

The user asked (2026-09-16) to take on SRE duties in addition to development for this project: "as
SRE, you'll spin up the project as a docker container, and if we have updates, you'll rebuild the
image and update the running instance." This is a standing expansion of this Dev-context session's
own responsibilities, not a one-off request -- distinct from [[nas-sre-files-issues]], which
describes a different, more conservative SRE mode for a session running ON the NAS itself
(files issues, changes nothing without authorization). Here, in the Dev context that already has
full git autonomy, the same autonomy now extends to redeploying the running container.

**How to apply**: once a "let's ship it" round lands on `main` (per
[[interactive-session-workflow]]/[[run-full-test-suite]]'s existing completion steps), also:

```
./actual build image
source .envrc && ./actual service start   # recreates the container on the new image
source .envrc && ./actual service status  # confirm it comes back healthy
```

`./actual service start` on an already-running container recreates it in place (`docker compose
up -d` picks up the new image tag) -- no separate stop/start needed. `service status`/`build
image` don't need the env vars sourced, but `service start` does (it needs `AB_DATA_DIR`/
`AB_HOST_ALIAS`/`AB_BASE_URL`/`AB_BUDGET_ID`/`AB_API_KEY` for the compose file's
`${VAR:-default}` substitutions to resolve against the NAS's own paths/hostnames, not this
sandbox's) -- **always `source .envrc && ./actual service <cmd>` in ONE Bash call**, never `source`
then a separate call, since shell env doesn't persist between Bash tool invocations. Forgetting
this fails silently-ish with "Bind mount failed: '/workspace/data' does not exist" -- the compose
default falls back to a sandbox-relative path the docker daemon (remote, on the NAS) can't see.

**Why this matters, found setting it up the first time**: `./data/` in the repo was empty (just
`.gitkeep`) -- the container's own config lives at `AB_DATA_DIR`/config.json, a completely separate
file from the repo-root `config.json` that `--dev` mode uses by default (`DEFAULT_CONFIG_PATH =
"config.json"` in fire-accounts.ts vs. the Dockerfile's own `CMD`, which always passes `--config
/app/data/config.json`). Starting the container fresh means starting with a BLANK config unless
something seeds `./data/config.json` first. First-time setup: `cp config.json data/config.json`
(both are gitignored -- real financial data, never committed). After that one-time seed, the two
copies are independent and expected to drift: `--dev` mode (repo-root config.json) is the
interactive-verification copy used while iterating on a change; the container's own
`data/config.json` is the one the user actually lives on day to day, rewritten by every edit made
through the deployed instance itself. Don't try to keep them in sync beyond that first seed --
that's the same normal "dev data vs. prod data" split as any other app.

**How to check it's actually up**: `source .envrc && ./actual service status` reports `up`/`down`
and container health; `docker inspect actual-tools --format='{{.State.Health.Status}}'` if more
detail is needed. The healthcheck has a 10s start_period and 30s interval, so "starting" right
after `service start` is normal -- give it under a minute before treating that as a problem.

**Two deployed services now, as of [[detached-mode]] (2026-09-22)**: `./actual service start` with
no `--mode` only ever touches the original linked service (`actual-tools`, port 4276) -- unchanged,
backward compatible. Since both services share the SAME image (`actual-tools:local`), a change that
isn't linked-mode-specific (most server/shared-logic changes) needs BOTH redeployed after a build,
not just the default one:

```
./actual build image
source .envrc && ./actual service start                  # linked (unchanged behavior)
source .envrc && ./actual service start --mode detached   # detached (new -- easy to forget)
source .envrc && ./actual service status                  # linked
source .envrc && ./actual service status --mode detached   # detached
```

Skip the detached redeploy only for a change that's provably linked-only (e.g. something inside a
route the MODE gate already blocks in detached mode) -- otherwise redeploy both by default rather
than reasoning about which one a given diff could possibly touch.
