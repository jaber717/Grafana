#!/usr/bin/env bash
# Clean-room test of the API tooling against a THROW-AWAY Grafana (never production).
#
#   1. start an empty Grafana of the pinned version on 127.0.0.1:3999 with the pinned plugins (see docs/validation.md for how it was done)
#   2. GRAFANA_URL=http://127.0.0.1:3999 GRAFANA_USER=admin GRAFANA_PASSWORD=<throw-away> tests/clean-room-local.sh
#
# Refuses to run against anything but a loopback URL. Datasource endpoints are rewritten to a dead loopback address
# (APPLY_SANDBOX_ENDPOINTS=1) so the instance can never contact the real Zabbix or ClickHouse.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
case "${GRAFANA_URL:-}" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: GRAFANA_URL must be a loopback URL" >&2; exit 2 ;; esac
export APPLY_SANDBOX_ENDPOINTS=1 ZABBIX_GRAFANA_PASSWORD=test-only CLICKHOUSE_RO_PASSWORD=test-only
PASS=0; FAIL=0
ok()  { echo "[PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
api() { curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" -H 'Content-Type: application/json' "$@"; }
count_dash() { api "$GRAFANA_URL/api/search?type=dash-db&limit=500" | grep -o '"uid"' | wc -l; }
EXPECT=$(ls dashboards/*/*.json | wc -l)
has() { grep -qF -- "$1" <<<"$2"; }

# 0. start from empty
[ "$(count_dash)" = "0" ] && ok "0. instance starts with no dashboards" || { bad "0. instance is not empty - use a fresh data directory"; exit 1; }

# 1. first apply creates everything
out=$(node scripts/apply.mjs); echo "$out" | tail -2
has ", 0 refused" "$out" && ok "1. apply refused nothing" || bad "1. apply refused something"
[ "$(count_dash)" = "$EXPECT" ] && ok "1. first apply: $EXPECT dashboards present" || bad "1. dashboard count after apply is $(count_dash), expected $EXPECT"

# 2. second apply is a no-op (idempotent, no duplicates)
out=$(node scripts/apply.mjs | tail -1)
has "applied: 0 created, 0 updated" "$out" && ok "2. second apply wrote nothing (idempotent)" || bad "2. second apply changed something: $out"
[ "$(count_dash)" = "$EXPECT" ] && ok "2. still $EXPECT dashboards (no duplicates)" || bad "2. dashboard count changed to $(count_dash)"

# 3. a dashboard with the same title but another uid is refused (no silent duplicate)
api -X DELETE "$GRAFANA_URL/api/dashboards/uid/noc-wan-overview" >/dev/null
node -e '
const fs=require("fs");const [url,u,p]=[process.env.GRAFANA_URL,process.env.GRAFANA_USER,process.env.GRAFANA_PASSWORD];
const h={"Content-Type":"application/json",Authorization:"Basic "+Buffer.from(u+":"+p).toString("base64")};
const title=JSON.parse(fs.readFileSync("dashboards/noc/noc-wan-overview.json","utf8")).title;
fetch(url+"/api/dashboards/db",{method:"POST",headers:h,body:JSON.stringify({dashboard:{id:null,uid:"someone-else",title,panels:[],schemaVersion:39},folderUid:"noc",overwrite:false})}).then(r=>r.text()).then(()=>{});'
sleep 1
out=$(node scripts/apply.mjs)
has "would create a duplicate" "$out" && ok "3. same-title dashboard under another uid is refused" || bad "3. title conflict not detected"
api -X DELETE "$GRAFANA_URL/api/dashboards/uid/someone-else" >/dev/null

# 4. drift is detected by verify and repaired by apply
node scripts/apply.mjs >/dev/null
node -e '
const [url,u,p]=[process.env.GRAFANA_URL,process.env.GRAFANA_USER,process.env.GRAFANA_PASSWORD];
const h={"Content-Type":"application/json",Authorization:"Basic "+Buffer.from(u+":"+p).toString("base64")};
(async()=>{const r=await (await fetch(url+"/api/dashboards/uid/netflow-health",{headers:h})).json();
r.dashboard.title="TAMPERED"; await fetch(url+"/api/dashboards/db",{method:"POST",headers:h,body:JSON.stringify({dashboard:r.dashboard,folderUid:"netflow",overwrite:true})});})();'
sleep 1
v=$(node scripts/verify.mjs)
has "dashboard netflow-health - content differs" "$v" && ok "4. verify detects a tampered dashboard" || bad "4. verify missed the tampered dashboard"
a=$(node scripts/apply.mjs)
has "updated   dashboard netflow-health" "$a" && ok "4. apply repairs it" || bad "4. apply did not repair"
v=$(node scripts/verify.mjs --skip-datasources)
if grep -q "FAIL" <<<"$v"; then bad "4. verify still fails on non-datasource checks"; else ok "4. verify clean for dashboards/folders/playlist (datasource endpoints are sandboxed here, so their definition/health checks are expected to FAIL)"; fi

# 5. backup, destroy, restore (rollback of content)
bk=$(mktemp -d); node scripts/backup.mjs --out "$bk" | tail -1
b=$(ls -d "$bk"/grafana-* | head -1)
api -X DELETE "$GRAFANA_URL/api/dashboards/uid/netflow-overview" >/dev/null
api -X DELETE "$GRAFANA_URL/api/dashboards/uid/noc-device-health" >/dev/null
[ "$(count_dash)" = "$((EXPECT-2))" ] && ok "5. two dashboards deleted for the test" || bad "5. test setup failed"
r=$(node scripts/restore.mjs "$b")
if has "would create dashboard netflow-overview" "$r" && [ "$(count_dash)" = "$((EXPECT-2))" ]; then ok "5. restore dry run reports the loss and changes nothing"; else bad "5. restore dry run wrong"; fi
node scripts/restore.mjs "$b" --apply >/dev/null
[ "$(count_dash)" = "$EXPECT" ] && ok "5. restore --apply recreated them" || bad "5. restore --apply left $(count_dash) dashboards"
f=$(ls "$b"/dashboards/noc/*.json | head -1); echo " " >> "$f"
r=$(node scripts/restore.mjs "$b" 2>&1)
has "SHA-256" "$r" && ok "5. a modified backup is refused" || bad "5. modified backup accepted"
rm -rf "$bk"

echo; echo "clean-room (API tooling): $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
