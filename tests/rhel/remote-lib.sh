# shellcheck shell=bash
# Sourced ON the Grafana test machine by the acceptance driver (as root).  Query helpers; nothing here changes the platform.
HOME_GP=${HOME_GP:-/home/qual/gp}
B=https://grafana.test.lab:3000
gpc() { if [ -x /usr/local/sbin/grafana-platform ]; then echo /usr/local/sbin/grafana-platform; else echo "$HOME_GP/bin/grafana-platform"; fi; }
api() { curl -s -m 20 --resolve grafana.test.lab:3000:127.0.0.1 -u "admin:$(cat /etc/grafana-platform/secrets/admin-password)" -H 'Content-Type: application/json' "$@"; }
has_dash() { api "$B/api/dashboards/uid/$1" | grep -q '"dashboard"' && echo present || echo absent; }
mark_dash() { api -X POST -d "{\"dashboard\":{\"uid\":\"$1\",\"title\":\"$1\",\"panels\":[]},\"overwrite\":true}" "$B/api/dashboards/db" >/dev/null; }
dash_uids() { api "$B/api/search?type=dash-db&limit=200" | python3 -c 'import json,sys;print(" ".join(sorted(d["uid"] for d in json.load(sys.stdin) if not d["uid"].startswith(("m-","user-","dr-")))))'; }
ds_status() { for u in zabbix-lab netflow-clickhouse; do printf '%s=%s ' "$u" "$(api "$B/api/datasources/uid/$u/health" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status"))' 2>/dev/null)"; done; }
version() { api "$B/api/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])'; }
folders() { api "$B/api/folders" | python3 -c 'import json,sys;print(" ".join(sorted(f["uid"] for f in json.load(sys.stdin))))'; }
playlists() { api "$B/api/playlists" | python3 -c 'import json,sys;print(";".join(p["name"] for p in json.load(sys.stdin)))'; }
