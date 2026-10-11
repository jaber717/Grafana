#!/usr/bin/env bash
# Installs grafana-report on a RHEL 9.x host (idempotent). It NEVER enables the timer and NEVER enables e-mail or Telegram by itself:
#   sudo scripts/install-reports.sh [--with-renderer] [--install-podman] [--enable-timer]
#     --with-renderer   also install grafana-image-renderer.service (use on the host that runs the renderer)
#     --install-podman  dnf install podman (AppStream) when it is missing
#     --enable-timer    enable the daily timer (07:00 Asia/Riyadh). Without it the timer is installed but stays OFF.
# Afterwards: edit /etc/grafana-platform/reports/report.env + interfaces.yaml, create the token files, run `grafana-report check-config`.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run as root" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ETC=${GP_ETC:-/etc/grafana-platform}/reports
STATE=/var/lib/grafana-report
LOGD=/var/log/grafana-report
WITH_RENDERER=0 INSTALL_PODMAN=0 ENABLE_TIMER=0
for a in "$@"; do case $a in --with-renderer) WITH_RENDERER=1;; --install-podman) INSTALL_PODMAN=1;; --enable-timer) ENABLE_TIMER=1;; *) echo "unknown option $a" >&2; exit 1;; esac; done
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in rhel:9.*|rocky:9.*|almalinux:9.*|centos:9*) ;; *) echo "ERROR: RHEL 9.x family required (found ${ID:-?} ${VERSION_ID:-?})" >&2; exit 1;; esac
say() { printf '  %s\n' "$*"; }

echo "== service user and directories"
getent group grafana-report >/dev/null || groupadd --system grafana-report
id grafana-report >/dev/null 2>&1 || useradd --system --gid grafana-report --home-dir "$STATE/home" --shell /sbin/nologin --comment "Grafana daily reports" grafana-report
# rootless Podman maps container users through a subordinate id range
grep -q '^grafana-report:' /etc/subuid 2>/dev/null || usermod --add-subuids 300000-365535 --add-subgids 300000-365535 grafana-report
install -d -m 0750 -o root -g grafana-report "$ETC"
install -d -m 0750 -o grafana-report -g grafana-report "$STATE" "$STATE/out" "$STATE/state" "$STATE/home" "$LOGD"
printf 'd /run/grafana-report 0700 grafana-report grafana-report -
' > /etc/tmpfiles.d/grafana-report.conf
systemd-tmpfiles --create /etc/tmpfiles.d/grafana-report.conf
say "user grafana-report, $ETC, $STATE, $LOGD, /run/grafana-report (tmpfiles.d)"

echo "== command"
ln -sfn "$ROOT/bin/grafana-report" /usr/local/sbin/grafana-report
say "/usr/local/sbin/grafana-report -> $ROOT/bin/grafana-report"

echo "== configuration templates (existing files are never overwritten)"
for f in report.env interfaces.yaml; do
  src="$ROOT/config/reports/$f.example"; [ -f "$src" ] || src="$ROOT/config/reports/${f%.yaml}.example.yaml"
  if [ ! -e "$ETC/$f" ]; then install -m 0640 -o root -g grafana-report "$src" "$ETC/$f"; say "created $ETC/$f (edit it)"; else say "kept    $ETC/$f"; fi
done
if [ "$WITH_RENDERER" = 1 ] && [ ! -e "$ETC/renderer.env" ]; then
  install -m 0600 -o root -g root "$ROOT/config/reports/renderer.env.example" "$ETC/renderer.env"
  tok=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32); sed -i "s/^AUTH_TOKEN=.*/AUTH_TOKEN=$tok/" "$ETC/renderer.env"
  say "created $ETC/renderer.env with a RANDOM renderer token - put the same value in grafana.ini [rendering] renderer_token"
fi

echo "== prerequisites"
command -v node >/dev/null 2>&1 || [ -x /opt/grafana-platform/node/bin/node ] && say "Node.js present" || echo "  WARNING: Node.js >= 18 not found (the offline bundle provides it under /opt/grafana-platform/node)"
if ! command -v podman >/dev/null 2>&1; then
  if [ "$INSTALL_PODMAN" = 1 ]; then dnf -y install podman >/dev/null && say "podman installed"; else echo "  WARNING: podman not installed (needed for the recommended CHROMIUM_CMD; use --install-podman, or set CHROMIUM_CMD to a local Chromium)"; fi
else say "$(podman --version)"; fi

echo "== systemd units"
changed=0
units="grafana-report.service grafana-report.timer"; [ "$WITH_RENDERER" = 1 ] && units="$units grafana-image-renderer.service"
for u in $units; do cmp -s "$ROOT/systemd/$u" "/etc/systemd/system/$u" 2>/dev/null || { install -m 0644 "$ROOT/systemd/$u" "/etc/systemd/system/$u"; changed=1; }; done
[ "$changed" = 1 ] && systemctl daemon-reload
say "installed: $units"
if [ "$ENABLE_TIMER" = 1 ]; then systemctl enable --now grafana-report.timer >/dev/null 2>&1; say "timer ENABLED: $(systemctl list-timers grafana-report.timer --no-legend | awk '{print $1, $2, $3}')"; else say "timer installed but NOT enabled (grafana-report schedule enable)"; fi
echo
echo "Next: edit $ETC/report.env and interfaces.yaml, write the token files (mode 0600, owner grafana-report), then: sudo -u grafana-report grafana-report check-config"
