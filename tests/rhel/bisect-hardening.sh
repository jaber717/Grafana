#!/usr/bin/env bash
# Finds which systemd hardening directives are compatible with rootless Podman for the grafana-report user (test machine only).
# Each variant runs `podman run ... chromium --version` as a transient unit; PASS means Chromium started.
set -u
IMG=docker.io/grafana/grafana-image-renderer@sha256:4b3d29a66c1dd11d513f8378907953b3c2c0c0535cbf5cf8fe83f7f398ae8b4c
BASE=(--uid=grafana-report --gid=grafana-report --pipe --wait --collect -q -E HOME=/var/lib/grafana-report/home -E XDG_RUNTIME_DIR=/run/grafana-report -p RuntimeDirectory=grafana-report -p RuntimeDirectoryMode=0700 -p RuntimeDirectoryPreserve=yes -p StateDirectory=grafana-report)
CMD=(podman run --rm --userns=keep-id --user 996:995 --entrypoint chromium "$IMG" --version)
try() { # label, properties...
  local label=$1; shift
  sudo rm -rf /run/grafana-report/* /run/grafana-report/.[!.]* 2>/dev/null   # every variant starts from a clean runtime directory
  local args=("${BASE[@]}"); for p in "$@"; do args+=(-p "$p"); done
  if out=$(sudo systemd-run "${args[@]}" "${CMD[@]}" 2>&1 | grep -v 'level=warning'); echo "$out" | grep -q '^Chromium'; then echo "PASS  $label"; else echo "FAIL  $label: $(echo "$out" | head -1 | cut -c1-120)"; fi
}
try "no hardening"
for p in PrivateTmp=yes ProtectSystem=strict ProtectHome=yes ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes ProtectClock=yes LockPersonality=yes RestrictRealtime=yes SystemCallArchitectures=native UMask=0027 NoNewPrivileges=yes RestrictNamespaces=yes; do
  try "$p" "$p" "ReadWritePaths=/var/lib/grafana-report"
done
