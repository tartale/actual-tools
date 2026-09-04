#!/usr/bin/env bash

THIS_SCRIPT_DIR="$(cd $(dirname ${BASH_SOURCE}); pwd)"

# Track the newest releases of the language toolchains rather than pinning to a
# version that would drift out of date as the image is rebuilt.
PLUGINS="${THIS_SCRIPT_DIR}/plugin.sh" CS_IMAGE_TAG="${CS_IMAGE_TAG}" \
  LANGUAGE_VERSIONS="typescript-latest" \
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/tartale/claude-sandbox/refs/heads/main/build-image.sh)"
