---
name: sandbox-toolchain-policy
description: How this repo's claude-sandbox image and package.json should pin tool versions
metadata:
  node_type: memory
  type: feedback
  modified: 2026-09-04T20:05:00.000Z
---

Two standing rules for the actual-tools repo's toolchain:

1. **Anything installable at container-build-time goes in
   `.claude/sandbox/plugin.sh`**, not into an ad-hoc install at session time,
   so it survives a container reboot without reinstalling.
2. **Track the latest major of each tool, and pin only by major** —
   `"typescript": "^7"`, not `"^7.0"` or `"^7.0.2"`. Sandbox side, this is
   done with `LANGUAGE_VERSIONS="typescript-latest"` in
   `.claude/sandbox/build.sh` (the upstream `languages/typescript.sh` plugin
   parses the `typescript-` prefix out of that variable).

**Why**: the major is where backward compatibility actually matters, so
pinning minor/patch just creates drift to clean up later with no
compatibility benefit.

**How to apply**: when adding a tool, ask first whether it can be baked into
the image; when adding a dependency, write the range as `^<major>`. See
[[set-budget-migration]] for the project this was established on.
