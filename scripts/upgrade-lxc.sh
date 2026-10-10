#!/usr/bin/env bash
# upgrade-lxc.sh — upgrade Grafana (and pinned plugins) on grafana-01 with a mandatory backup first. Run INSIDE the container as root.
#
#   scripts/upgrade-lxc.sh <target-grafana-version> [--yes]
#
# 1. refuses unless <target> differs from the installed version and is available in the APT repository
# 2. scripts/backup-lxc.sh (database + config + plugin list) — the archive is the rollback source
# 3. writes /var/backups/grafana-repo/last-upgrade (previous version + backup name) for scripts/rollback-lxc.sh
# 4. apt-get install grafana=<target>, re-installs the plugins pinned in plugins/plugins.txt (update that file first if the target
#    needs other plugin versions), restarts, waits for /api/health
# Grafana runs its own database migrations on first start; they are NOT reversible by downgrading the package alone, which is why
# rollback-lxc.sh restores the database copy taken in step 2.
# After a successful upgrade: update VERSIONS.env in this repository, run scripts/verify.sh from a workstation, tag a new release.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
TARGET=${1:?usage: upgrade-lxc.sh <target-grafana-version> [--yes]}
YES=0; [ "${2:-}" = "--yes" ] && YES=1
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
CUR=$(dpkg-query -W -f='${Version}' grafana); CUR=${CUR%%-*}
[ "$CUR" != "$TARGET" ] || { echo "already at $TARGET"; exit 0; }
apt-get update -qq
apt-cache madison grafana | awk '{print $3}' | grep -qx "$TARGET" || { echo "grafana $TARGET is not available in the APT repository" >&2; exit 1; }
echo "upgrade grafana $CUR -> $TARGET"
if [ "$YES" != 1 ]; then read -r -p "A backup is taken first. Continue? [y/N] " a; [ "$a" = y ] || exit 1; fi
bash scripts/backup-lxc.sh
BK=$(ls -1t /var/backups/grafana-repo/grafana-lxc-*.tar.gz | head -1)
printf 'previous_version=%s\nbackup=%s\ntarget=%s\n' "$CUR" "$BK" "$TARGET" > /var/backups/grafana-repo/last-upgrade
chmod 600 /var/backups/grafana-repo/last-upgrade
apt-mark unhold grafana
systemctl stop grafana-server
apt-get install -y "grafana=$TARGET"
apt-mark hold grafana
while read -r id ver _; do [ -n "$id" ] && grafana cli plugins install "$id" "$ver"; done < <(sed 's/#.*//' plugins/plugins.txt | awk 'NF')
systemctl start grafana-server
for i in $(seq 1 45); do curl -fs http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fs http://127.0.0.1:3000/api/health || { echo "Grafana is not healthy after the upgrade. Roll back: scripts/rollback-lxc.sh" >&2; exit 1; }
echo; echo "upgraded to $(dpkg-query -W -f='${Version}' grafana). Rollback if needed: scripts/rollback-lxc.sh"
