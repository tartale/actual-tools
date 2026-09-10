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

**Playwright (added 2026-09-09/10)**, for driving the companion app in a real
browser -- see [[app-budget-section]] for what that turned up. It follows the
same shape as `vitest`: installed globally in the image
(`tools/playwright.sh` in `.claude/sandbox/plugin.sh`, browsers baked into
`/ms-playwright`) **and** pinned as a project devDependency (`"playwright":
"^1"`). Both are needed and for different reasons -- the image install
provides the CLI and the browsers, while the devDependency is what makes
`import { chromium } from "playwright"` actually resolve from `/workspace`
(global `node_modules` is not on the project's resolution path).

**The gotcha worth remembering**: the image exports
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` from `/etc/profile.d/playwright.sh`,
which only a **login** shell reads. A script, an agent's shell, an editor
terminal or a CI step therefore has the browsers on disk while Playwright
looks in `~/.cache/ms-playwright` and fails with a bare "Executable doesn't
exist at ...". `./actual test` now sets the variable itself when it is unset
and `/ms-playwright` exists (`ensurePlaywrightBrowsers` in `actual`), before
`ensureDependencies` -- deliberately in that order, since the `playwright`
package's own postinstall reads the same variable and will then skip a
redundant several-hundred-megabyte browser download. Off the image the
variable is left alone so Playwright falls back to its own default.

**Why**: the major is where backward compatibility actually matters, so
pinning minor/patch just creates drift to clean up later with no
compatibility benefit.

**How to apply**: when adding a tool, ask first whether it can be baked into
the image; when adding a dependency, write the range as `^<major>`. See
[[set-budget-migration]] for the project this was established on.
