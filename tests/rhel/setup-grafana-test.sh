#!/usr/bin/env bash
# Prepares an ISOLATED RHEL test host for the grafana-platform acceptance run: test CA + certificates, dummy secrets, a mock Zabbix,
# a synthetic Zabbix item map and an environment file.  Everything uses dummy credentials and throw-away certificates.
#   sudo tests/rhel/setup-grafana-test.sh <release-dir> [clickhouse-ip]
set -euo pipefail
REL=$(readlink -f "${1:?release dir}"); CH_IP=${2:-}
W=/root/gp-test; mkdir -p "$W/pki" "$W/tls"; chmod 700 "$W"
CH_NAME=localhost; [ -n "$CH_IP" ] && CH_NAME=ch.test.lab
IPADDR=$(hostname -I | awk '{print $1}')

bash "$REL/tests/rhel/make-test-pki.sh" "$W/pki" "grafana.test.lab:$IPADDR" "zabbix.test.lab:127.0.0.1" ${CH_IP:+"ch.test.lab:$CH_IP"} >/dev/null
cp "$W/pki/grafana.test.lab.crt" "$W/tls/grafana.crt"; cp "$W/pki/grafana.test.lab.key" "$W/tls/grafana.key"

# name resolution for the test names (no DNS in the isolated network)
sed -i '/# gp-test/d' /etc/hosts
{ echo "127.0.0.1 grafana.test.lab zabbix.test.lab # gp-test"; [ -n "$CH_IP" ] && echo "$CH_IP ch.test.lab # gp-test"; } >> /etc/hosts

# dummy secrets (never real credentials)
install -d -m 0750 /etc/grafana-platform /etc/grafana-platform/secrets
printf 'dummy-zabbix-pw-%s' "$RANDOM" > /etc/grafana-platform/secrets/zabbix-password
printf 'dummy-clickhouse-pw-%s' "$RANDOM" > /etc/grafana-platform/secrets/clickhouse-password
chmod 600 /etc/grafana-platform/secrets/zabbix-password /etc/grafana-platform/secrets/clickhouse-password

# synthetic item map: every LAB id the dashboards use -> a fake id on the mock Zabbix (including the ones marked unresolved)
python3 - "$REL" "$W/item-map.json" <<'PY'
import json, re, sys, glob
rel, out = sys.argv[1:3]
ids = set()
for f in glob.glob(rel + "/dashboards/**/*.json", recursive=True):
    for m in re.finditer(r'"itemids":\s*"([0-9,\s]+)"', open(f).read()):
        ids.update(x.strip() for x in m.group(1).split(",") if x.strip())
json.dump({i: "9" + i for i in sorted(ids)}, open(out, "w"), indent=1)
print("item map entries:", len(ids))
PY

cat > "$W/test.env" <<EOF
PLATFORM_ENV=production
GRAFANA_DOMAIN=grafana.test.lab
GRAFANA_HTTP_PORT=3000
GRAFANA_PROTOCOL=https
GRAFANA_TLS_CERT_FILE=$W/tls/grafana.crt
GRAFANA_TLS_KEY_FILE=$W/tls/grafana.key
GRAFANA_TLS_CA_FILE=$W/pki/ca.pem
GRAFANA_ALLOWED_CIDRS=192.168.1.0/24
GRAFANA_ADMIN_USER=admin
ZABBIX_DS_NAME=Zabbix
ZABBIX_URL=https://zabbix.test.lab:8443/api_jsonrpc.php
ZABBIX_USER=grafana-ro
ZABBIX_CA_FILE=$W/pki/ca.pem
ZABBIX_TLS_SKIP_VERIFY=false
CLICKHOUSE_HOST=$CH_NAME
CLICKHOUSE_PORT=8443
CLICKHOUSE_SECURE=true
CLICKHOUSE_USER=grafana_ro
CLICKHOUSE_CA_FILE=$W/pki/ca.pem
ZABBIX_ITEM_MAP_FILE=$W/item-map.json
PACKAGE_SOURCE=repo
EOF
chmod 600 "$W/test.env"

# mock Zabbix (as a transient systemd unit so it survives the ssh session)
systemctl stop gp-mock-zabbix 2>/dev/null || true
systemd-run --unit=gp-mock-zabbix --description="acceptance-test mock Zabbix" /usr/bin/python3 "$REL/tests/rhel/mock-zabbix.py" "$W/pki/zabbix.test.lab.crt" "$W/pki/zabbix.test.lab.key" 8443 >/dev/null
sleep 1
curl -sS --cacert "$W/pki/ca.pem" --resolve zabbix.test.lab:8443:127.0.0.1 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"apiinfo.version","id":1}' https://zabbix.test.lab:8443/api_jsonrpc.php; echo
echo "ready: $W/test.env"
