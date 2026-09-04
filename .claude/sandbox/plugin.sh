#!/usr/bin/env bash
set -euo pipefail

${PLUGINS_DIR}/languages/typescript.sh

# Docker CLI (client only; talks to the host daemon over the bind-mounted
# socket). Needed to build/run the deployment image.
${PLUGINS_DIR}/tools/docker.sh
