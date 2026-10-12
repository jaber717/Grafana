#!/usr/bin/env bash
# Runs the whole unit + end-to-end suite on a RHEL test host. The end-to-end tests print real PDFs, so Chromium comes from the pinned renderer
# image under rootless Podman (the same command as production). Needs Node >= 18 and Podman with the image already pulled.
#   tests/rhel/run-unit-suite.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=$(sed -n 's/^RENDERER_IMAGE=//p' config/reports/renderer.env.example)
export CHROMIUM_CMD="podman run --rm --userns=keep-id --user {uid}:{gid} -v {workdir}:{workdir}:Z -e HOME={workdir} --entrypoint chromium $IMAGE"
echo "node $(node --version), $(podman --version)"
time node --test tests/unit/*.test.mjs 2>&1 | grep -E '^not ok|^# (tests|pass|fail|skipped|duration)'
