#!/usr/bin/env bash
set -euo pipefail

${PLUGINS_DIR}/languages/typescript.sh

# Docker CLI (client only; talks to the host daemon over the bind-mounted
# socket). Needed to build/run the deployment image.
${PLUGINS_DIR}/tools/docker.sh

# Test runner for this repo's TypeScript tools. Installed globally so a fresh
# container can run `vitest run` before (or without) a project-level
# `npm install`; when node_modules is present, npm scripts prefer the local
# copy pinned in package.json.
npm install -g vitest
