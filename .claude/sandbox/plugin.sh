#!/usr/bin/env bash
set -euo pipefail

"${PLUGINS_DIR}"/languages/typescript.sh
"${PLUGINS_DIR}"/tools/docker.sh
"${PLUGINS_DIR}"/tools/playwright.sh

# Test runner for this repo's TypeScript tools. Installed globally so a fresh
# container can run `vitest run` before (or without) a project-level
# `npm install`; when node_modules is present, npm scripts prefer the local
# copy pinned in package.json.
npm install -g vitest
