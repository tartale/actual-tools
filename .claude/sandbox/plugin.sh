#!/usr/bin/env bash
# Runs as root while this project's sandbox image is built (see build.sh).
# PLUGINS_DIR points at claude-sandbox's built-in plugins.
set -euo pipefail

# Pinned by major only (see sandbox-toolchain-policy memory): typescript-5 because
# typescript-eslint doesn't support the 7.x native port yet, playwright-1 to match this project's
# own "^1" devDependency. Without this, languages/typescript.sh and tools/playwright.sh both fall
# back to whatever's newest on npm at build time -- which is how a sandbox rebuild silently landed
# TypeScript 7 (breaking typescript-eslint) and a newer Playwright than this project's lockfile
# pins (breaking every browser-driven test) in the same image.
export LANGUAGE_VERSIONS="typescript-5 playwright-1"

"${PLUGINS_DIR}"/languages/typescript.sh
"${PLUGINS_DIR}"/tools/docker.sh
"${PLUGINS_DIR}"/tools/playwright.sh

# Test runner for this repo's TypeScript tools. Installed globally so a fresh
# container can run `vitest run` before (or without) a project-level
# `npm install`; when node_modules is present, npm scripts prefer the local
# copy pinned in package.json.
npm install -g vitest
