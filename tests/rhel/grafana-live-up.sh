#!/usr/bin/env bash
# Prepares a DISPOSABLE Grafana (container "grafana" from grafana-demo-up) for the LIVE report path: installs the two pinned datasource
# plugins, creates the ClickHouse and Zabbix datasources (isolated test backends, dummy credentials), a Viewer token for the report job and an
# Editor token for build-dashboards. Tokens are written to $SECRETS (mode 600). Test machine only.
#   tests/rhel/grafana-live-up.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SECRETS=${SECRETS:-$HOME/gp-secrets}
PW=$(sudo cat /root/.rpt-grafana-pw)
G=http://127.0.0.1:3000
mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
while read -r id ver _; do
  [ -z "$id" ] && continue
  sudo docker exec grafana grafana cli plugins install "$id" "$ver" >/dev/null 2>&1 || sudo docker exec grafana grafana cli plugins install "$id" "$ver"
done < <(sed 's/#.*//' "$ROOT/plugins/plugins.txt" | awk 'NF')
sudo docker restart grafana >/dev/null
for _ in $(seq 1 60); do curl -fsS -m 3 "$G/api/health" >/dev/null 2>&1 && break; sleep 3; done
api() { curl -fsS -m 30 -u "admin:$PW" -H 'Content-Type: application/json' "$@"; }
api -X POST "$G/api/plugins/alexanderzobnin-zabbix-app/settings" -d '{"enabled":true,"pinned":false}' >/dev/null || true
ds() { api -X POST "$G/api/datasources" -d "$1" >/dev/null 2>&1 || api -X PUT "$G/api/datasources/uid/$2" -d "$1" >/dev/null; }
ds '{"uid":"netflow-clickhouse","name":"NetFlow ClickHouse","type":"grafana-clickhouse-datasource","access":"proxy","jsonData":{"defaultDatabase":"default","dialTimeout":"10","host":"127.0.0.1","port":8123,"protocol":"http","secure":false,"username":"grafana_ro","queryTimeout":"30","validateSql":false},"secureJsonData":{"password":"dummy-ro-pw-test"}}' netflow-clickhouse
ds '{"uid":"zabbix-lab","name":"Zabbix LAB","type":"alexanderzobnin-zabbix-datasource","access":"proxy","url":"http://127.0.0.1:18080/api_jsonrpc.php","isDefault":true,"jsonData":{"authType":"userLogin","trends":true,"cacheTTL":"1h","username":"grafana-ro","alerting":false},"secureJsonData":{"password":"dummy-zbx-pw"}}' zabbix-lab
mk_token() { # role name file
  local sa; sa=$(api "$G/api/serviceaccounts/search?query=$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.serviceAccounts||[]).find(x=>x.name===process.argv[1])?.id||"")})' "$2")
  [ -n "$sa" ] || sa=$(api -X POST "$G/api/serviceaccounts" -d "{\"name\":\"$2\",\"role\":\"$1\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
  api -X POST "$G/api/serviceaccounts/$sa/tokens" -d "{\"name\":\"t-$(date +%s)\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))' > "$3"
  chmod 600 "$3"
}
mk_token Viewer report-job "$SECRETS/viewer.token"
mk_token Editor report-editor "$SECRETS/editor.token"
echo "datasources: $(api "$G/api/datasources" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(d=>d.uid+":"+d.type).join(" ")))')"
echo "plugins: $(sudo docker exec grafana ls /var/lib/grafana/plugins | tr '\n' ' ')"
echo "tokens written to $SECRETS (viewer.token, editor.token)"
