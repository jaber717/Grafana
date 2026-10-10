#!/usr/bin/env bash
# install-lxc.sh — install the pinned Grafana + plugins on a Debian 12 host/LXC (run INSIDE grafana-01, as root).
#
#   scripts/install-lxc.sh [--dry-run] [--provisioning] [--skip-lxc-dropin-check]
#
# * Installs the exact Grafana version from VERSIONS.env from the official APT repository and holds the package
#   (upgrades only through scripts/upgrade-lxc.sh).
# * Installs the plugins listed in plugins/plugins.txt at their pinned versions.
# * --provisioning also installs provisioning/ (datasources + dashboard providers) and the dashboards under /var/lib/grafana/dashboards.
#   Without it the content is applied afterwards from a workstation with scripts/apply.sh (API mode, the mode used on grafana-01 today).
# * Idempotent: re-running with everything already at the pinned versions changes nothing.
# * Does NOT set any password: the first admin login/password and the datasource secrets are yours (see docs/installation.md).
#
# NOT captured in this repository: the content of grafana-01's unprivileged-LXC systemd drop-in
# (/etc/systemd/system/grafana-server.service.d/lxc.conf) — there was no filesystem access to the container when this repository was
# captured. On an LXC the script refuses to start Grafana unless that file exists (or you pass --skip-lxc-dropin-check).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
. ./VERSIONS.env
DRY=0; PROV=0; SKIPLXC=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --provisioning) PROV=1 ;; --skip-lxc-dropin-check) SKIPLXC=1 ;; -h|--help) sed -n '2,18p' "$0"; exit 0 ;; *) echo "unknown option: $a" >&2; exit 2 ;; esac; done
log() { printf '[install-lxc] %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
die() { printf '[install-lxc] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
. /etc/os-release
[ "${ID:-}" = debian ] && [ "${VERSION_ID:-}" = 12 ] || die "this script is for Debian 12 (found ${PRETTY_NAME:-unknown})"
VIRT=$(systemd-detect-virt -c 2>/dev/null || true)
log "environment: ${PRETTY_NAME}, container=${VIRT:-none}"

# ---- package ----------------------------------------------------------------------------------------------------
INSTALLED=$(dpkg-query -W -f='${Version}' grafana 2>/dev/null || true)
if [ "${INSTALLED%%-*}" = "$GRAFANA_VERSION" ]; then
  log "grafana $GRAFANA_VERSION already installed"
else
  [ -n "$INSTALLED" ] && die "grafana $INSTALLED is installed; use scripts/upgrade-lxc.sh (it backs up first)"
  log "adding the official Grafana APT repository"
  run apt-get update -qq
  run apt-get install -y -qq apt-transport-https ca-certificates curl gnupg
  run install -d -m 0755 /etc/apt/keyrings
  if [ "$DRY" = 0 ]; then curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/grafana.gpg; fi
  if [ "$DRY" = 0 ]; then echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" > /etc/apt/sources.list.d/grafana.list; fi
  run apt-get update -qq
  if [ "$DRY" = 0 ] && ! apt-cache madison grafana | awk '{print $3}' | grep -qx "$GRAFANA_VERSION"; then die "grafana $GRAFANA_VERSION is not available in the repository"; fi
  run apt-get install -y "grafana=$GRAFANA_VERSION"
  run apt-mark hold grafana
fi

# ---- LXC compatibility ------------------------------------------------------------------------------------------
DROPIN=/etc/systemd/system/grafana-server.service.d/lxc.conf
if [ "$VIRT" = lxc ] && [ ! -f "$DROPIN" ] && [ "$SKIPLXC" != 1 ]; then
  die "running in an LXC but $DROPIN is missing. grafana-01 needs its unprivileged-LXC compatibility drop-in (not captured in this repository: copy it from grafana-01 or recreate it, then re-run), or pass --skip-lxc-dropin-check"
fi

# ---- plugins ----------------------------------------------------------------------------------------------------
while read -r id ver _; do
  [ -z "$id" ] && continue
  cur=$(grafana cli plugins ls 2>/dev/null | awk -v p="$id" '$1==p {print $3}' | tr -d '@' | head -1 || true)
  if [ "$cur" = "$ver" ]; then log "plugin $id $ver already installed"; else log "installing plugin $id $ver"; run grafana cli plugins install "$id" "$ver"; fi
done < <(sed 's/#.*//' plugins/plugins.txt | awk 'NF')

# ---- provisioning (optional) ------------------------------------------------------------------------------------
if [ "$PROV" = 1 ]; then
  log "installing provisioning files and dashboards (file-provisioning mode)"
  run install -d -m 0750 -o root -g grafana /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards
  run install -m 0640 -o root -g grafana provisioning/datasources/datasources.yaml /etc/grafana/provisioning/datasources/
  run install -m 0640 -o root -g grafana provisioning/dashboards/dashboards.yaml /etc/grafana/provisioning/dashboards/
  for d in netflow noc; do
    run install -d -m 0755 -o grafana -g grafana "/var/lib/grafana/dashboards/$d"
    run cp dashboards/$d/*.json "/var/lib/grafana/dashboards/$d/"
    run chown -R grafana:grafana "/var/lib/grafana/dashboards/$d"
  done
  log "datasource secrets must be in /etc/default/grafana-server (ZABBIX_GRAFANA_PASSWORD, CLICKHOUSE_RO_PASSWORD), mode 0640 root:grafana"
fi

# ---- start ------------------------------------------------------------------------------------------------------
run systemctl daemon-reload
run systemctl enable --now grafana-server
if [ "$DRY" = 0 ]; then
  for i in $(seq 1 30); do curl -fs http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 2; done
  curl -fs http://127.0.0.1:3000/api/health || die "Grafana did not become healthy; see journalctl -u grafana-server"
  echo
fi
log "done. Next (from a workstation): GRAFANA_URL=... scripts/apply.sh  then  scripts/verify.sh"
