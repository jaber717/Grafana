#!/usr/bin/env bash
# backup-lxc.sh — consistent backup of the Grafana instance's STATE (run INSIDE grafana-01, as root).
#
#   lab/scripts/backup-lxc.sh [--keep N]        (default keeps the newest 8)
#
# Archive /var/backups/grafana-repo/grafana-lxc-<stamp>.tar.gz (mode 0600) contains:
#   grafana.db            consistent online copy (sqlite3 .backup) — dashboards, users, API keys, datasource definitions AND
#                         their encrypted secrets
#   etc-grafana/          /etc/grafana (grafana.ini, provisioning/)
#   etc-default/          /etc/default/grafana-server (may hold datasource secrets)
#   systemd-dropins/      /etc/systemd/system/grafana-server.service.d/
#   plugins.txt           installed plugins and versions (grafana cli plugins ls)
#   manifest.txt          grafana version, host, time, SHA-256 of every file
# The archive therefore CONTAINS SECRETS: keep it 0600 and copy it off-host to protected storage only.
# For the repository-managed CONTENT (dashboards as JSON) use scripts/backup.sh from a workstation.
set -euo pipefail
KEEP=8; [ "${1:-}" = "--keep" ] && KEEP=${2:?}
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required for a consistent database copy: apt-get install sqlite3" >&2; exit 1; }
DB=/var/lib/grafana/grafana.db
[ -f "$DB" ] || { echo "$DB not found (is Grafana using SQLite on this host?)" >&2; exit 1; }
OUT=/var/backups/grafana-repo; install -d -m 0700 "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/b/etc-grafana" "$W/b/etc-default" "$W/b/systemd-dropins"
sqlite3 "$DB" ".backup '$W/b/grafana.db'"
cp -a /etc/grafana/. "$W/b/etc-grafana/"
[ -f /etc/default/grafana-server ] && cp -a /etc/default/grafana-server "$W/b/etc-default/"
[ -d /etc/systemd/system/grafana-server.service.d ] && cp -a /etc/systemd/system/grafana-server.service.d/. "$W/b/systemd-dropins/"
grafana cli plugins ls > "$W/b/plugins.txt" 2>&1 || true
{
  echo "created=$(date -u +%FT%TZ)"; echo "host=$(hostname)"; echo "grafana_package=$(dpkg-query -W -f='${Version}' grafana)"
  echo "sqlite_integrity=$(sqlite3 "$W/b/grafana.db" 'PRAGMA integrity_check;')"
  echo "--- sha256"; (cd "$W/b" && find . -type f ! -name manifest.txt -print0 | sort -z | xargs -0 sha256sum)
} > "$W/b/manifest.txt"
grep -q '^sqlite_integrity=ok$' "$W/b/manifest.txt" || { echo "database copy failed its integrity check" >&2; exit 1; }
( umask 077; tar -C "$W/b" -czf "$OUT/grafana-lxc-$STAMP.tar.gz" . )
chmod 600 "$OUT/grafana-lxc-$STAMP.tar.gz"
echo "backup written: $OUT/grafana-lxc-$STAMP.tar.gz ($(stat -c %s "$OUT/grafana-lxc-$STAMP.tar.gz") bytes) — contains secrets; copy off-host"
ls -1t "$OUT"/grafana-lxc-*.tar.gz | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; echo "pruned $(basename "$f")"; done
