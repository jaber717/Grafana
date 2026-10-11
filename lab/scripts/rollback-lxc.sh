#!/usr/bin/env bash
# rollback-lxc.sh — return grafana-01 to the state saved by lab/scripts/backup-lxc.sh / upgrade-lxc.sh (run INSIDE the container as root).
#
#   lab/scripts/rollback-lxc.sh [backup.tar.gz] [--yes]        default: the backup named in /var/backups/grafana-repo/last-upgrade
#
# Stops Grafana, verifies the archive's SHA-256 manifest, saves the CURRENT database/config to
# /var/backups/grafana-repo/pre-rollback-<stamp>.tar.gz (so a rollback is itself reversible), restores grafana.db, /etc/grafana,
# /etc/default/grafana-server and the systemd drop-ins, downgrades the package to the version recorded in the manifest (if it differs),
# starts Grafana and waits for /api/health. Plugins are re-installed from plugins/plugins.txt.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
ARCH=""; YES=0
for a in "$@"; do case "$a" in --yes) YES=1 ;; *) ARCH=$a ;; esac; done
if [ -z "$ARCH" ]; then
  [ -f /var/backups/grafana-repo/last-upgrade ] || { echo "no backup given and no last-upgrade record" >&2; exit 1; }
  ARCH=$(sed -n 's/^backup=//p' /var/backups/grafana-repo/last-upgrade)
fi
[ -f "$ARCH" ] || { echo "backup not found: $ARCH" >&2; exit 1; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
tar -C "$W" -xzf "$ARCH"
(cd "$W" && sed -n '/^--- sha256$/,$p' manifest.txt | tail -n +2 | sha256sum -c --quiet) || { echo "backup fails its SHA-256 manifest; refusing" >&2; exit 1; }
[ "$(sed -n 's/^sqlite_integrity=//p' "$W/manifest.txt")" = ok ] || { echo "backup database was not integrity-checked ok; refusing" >&2; exit 1; }
WANT=$(sed -n 's/^grafana_package=//p' "$W/manifest.txt"); WANT=${WANT%%-*}
CUR=$(dpkg-query -W -f='${Version}' grafana); CUR=${CUR%%-*}
echo "restore $ARCH  (grafana $WANT; installed $CUR)"
if [ "$YES" != 1 ]; then read -r -p "Grafana will be stopped and its database replaced. Continue? [y/N] " a; [ "$a" = y ] || exit 1; fi
STAMP=$(date +%Y%m%d-%H%M%S)
systemctl stop grafana-server
( umask 077; tar -C / -czf "/var/backups/grafana-repo/pre-rollback-$STAMP.tar.gz" var/lib/grafana/grafana.db etc/grafana etc/default/grafana-server etc/systemd/system/grafana-server.service.d 2>/dev/null || true )
if [ "$CUR" != "$WANT" ]; then apt-mark unhold grafana; apt-get install -y --allow-downgrades "grafana=$WANT"; apt-mark hold grafana; fi
install -m 0640 -o grafana -g grafana "$W/grafana.db" /var/lib/grafana/grafana.db
rm -f /var/lib/grafana/grafana.db-wal /var/lib/grafana/grafana.db-shm
rsync -a "$W/etc-grafana/" /etc/grafana/
[ -f "$W/etc-default/grafana-server" ] && install -m 0640 -o root -g grafana "$W/etc-default/grafana-server" /etc/default/grafana-server
if [ -n "$(ls -A "$W/systemd-dropins" 2>/dev/null)" ]; then install -d /etc/systemd/system/grafana-server.service.d; cp -a "$W/systemd-dropins/." /etc/systemd/system/grafana-server.service.d/; fi
systemctl daemon-reload
while read -r id ver _; do [ -n "$id" ] && grafana cli plugins install "$id" "$ver"; done < <(sed 's/#.*//' plugins/plugins.txt | awk 'NF')
systemctl start grafana-server
for i in $(seq 1 45); do curl -fs http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fs http://127.0.0.1:3000/api/health || { echo "Grafana is not healthy after the rollback; the pre-rollback archive is /var/backups/grafana-repo/pre-rollback-$STAMP.tar.gz" >&2; exit 1; }
echo; echo "rolled back. Verify from a workstation: scripts/verify.sh"
