#!/usr/bin/env bash
# verify-lxc.sh — READ-ONLY host-level checks inside grafana-01 (run as root; changes nothing).
# The content checks (dashboards, datasources, playlists) are scripts/verify.sh, run from a workstation through the API.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
. ./VERSIONS.env
FAIL=0; WARN=0
ok() { echo "[PASS] $1"; }; bad() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }; warn() { echo "[WARN] $1"; WARN=$((WARN+1)); }
ver=$(dpkg-query -W -f='${Version}' grafana 2>/dev/null || true); ver=${ver%%-*}
[ "$ver" = "$GRAFANA_VERSION" ] && ok "grafana package $ver (pinned $GRAFANA_VERSION)" || bad "grafana package '${ver:-none}', pinned $GRAFANA_VERSION"
apt-mark showhold 2>/dev/null | grep -qx grafana && ok "package is on hold (upgrades only via upgrade-lxc.sh)" || warn "package is not on hold"
systemctl is-active --quiet grafana-server && ok "grafana-server is active" || bad "grafana-server is not active"
systemctl is-enabled --quiet grafana-server && ok "grafana-server is enabled at boot" || warn "grafana-server is not enabled"
curl -fs http://127.0.0.1:3000/api/health | grep -q '"database": *"ok"' && ok "/api/health database ok" || bad "/api/health not ok"
while read -r id v _; do
  [ -z "$id" ] && continue
  cur=$(grafana cli plugins ls 2>/dev/null | awk -v p="$id" '$1==p {print $3}' | tr -d '@' | head -1)
  [ "$cur" = "$v" ] && ok "plugin $id $v" || bad "plugin $id: installed '${cur:-none}', pinned $v"
done < <(sed 's/#.*//' plugins/plugins.txt | awk 'NF')
if [ "$(systemd-detect-virt -c 2>/dev/null)" = lxc ]; then [ -f /etc/systemd/system/grafana-server.service.d/lxc.conf ] && ok "LXC drop-in present" || bad "LXC drop-in /etc/systemd/system/grafana-server.service.d/lxc.conf missing"; fi
# a bootstrap admin password left in a systemd drop-in or an unrestricted env file is a credential on disk
if grep -rlE 'GF_SECURITY_ADMIN_PASSWORD|GF_.*PASSWORD' /etc/systemd/system/grafana-server.service.d 2>/dev/null | grep -q .; then warn "a systemd drop-in sets a GF_*PASSWORD variable (credential on disk): $(grep -rlE 'GF_.*PASSWORD' /etc/systemd/system/grafana-server.service.d | tr '\n' ' ')- remove it after the first login if it was only used for bootstrap"; else ok "no GF_*PASSWORD in systemd drop-ins"; fi
if [ -f /etc/default/grafana-server ]; then m=$(stat -c %a /etc/default/grafana-server); case "$m" in 600|640|400|440) ok "/etc/default/grafana-server mode $m" ;; *) warn "/etc/default/grafana-server mode $m (may hold datasource secrets)" ;; esac; fi
m=$(stat -c %a /var/lib/grafana/grafana.db 2>/dev/null || echo ?); case "$m" in 600|640|660) ok "grafana.db mode $m" ;; ?) warn "grafana.db not found" ;; *) warn "grafana.db mode $m" ;; esac
echo; [ "$FAIL" -eq 0 ] && echo "VERIFY-LXC: PASS ($WARN warning(s))" || echo "VERIFY-LXC: FAIL ($FAIL)"
[ "$FAIL" -eq 0 ]
