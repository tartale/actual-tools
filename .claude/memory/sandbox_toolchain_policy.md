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
   `"typescript": "^5"`, not `"^5.9"` or `"^5.9.3"`. Sandbox side the major is
   set with `LANGUAGE_VERSIONS="typescript-5"` in `.claude/sandbox/build.sh`
   (the upstream `languages/typescript.sh` plugin parses the `typescript-`
   prefix out of that variable; `typescript-latest` tracks the newest).
   Keep the sandbox's global major equal to the project's, so a bare `tsc`
   behaves like `./actual build`.

**Standing exception (2026-09-04): TypeScript is held at 5.x, not latest.**
`typescript-eslint` peers on `typescript >=4.8.4 <6.1.0`, so it cannot run
against the 7.x native port, and no release or prerelease supports it yet.
The user chose type-aware `typescript-eslint` over being on the newest major.
Revisit when typescript-eslint ships TS 7 support. (Biome and oxlint were the
alternatives that would have kept TS 7; oxlint declares TS 7 support through
`oxlint-tsgolint`.)

**Why**: the major is where backward compatibility actually matters, so
pinning minor/patch just creates drift to clean up later with no
compatibility benefit.

**How to apply**: when adding a tool, ask first whether it can be baked into
the image; when adding a dependency, write the range as `^<major>`. See
[[set-budget-migration]] for the project this was established on.
