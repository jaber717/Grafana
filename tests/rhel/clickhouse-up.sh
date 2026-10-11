#!/usr/bin/env bash
# Isolated ClickHouse for the report tests (test machine only): the REAL Akvorado schema (tests/fixtures/clickhouse-schema.sql) plus a
# read-only user with a DUMMY password. Listens on loopback only (host networking, so no Docker bridge traffic is needed).
#   tests/rhel/clickhouse-up.sh [schema.sql]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCHEMA=${1:-$HERE/../fixtures/clickhouse-schema.sql}
NAME=${CH_CONTAINER:-ch}
IMAGE=clickhouse/clickhouse-server@sha256:d97c9867f770fab06113bfe82f2cd17dcc9535f0773972469a2464b4fefc6a48
D=$(mktemp -d)
cat > "$D/listen.xml" <<'XML'
<clickhouse><listen_host>127.0.0.1</listen_host><http_port>8123</http_port><tcp_port>9000</tcp_port></clickhouse>
XML
sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --name "$NAME" --network host --restart unless-stopped -v "$D/listen.xml:/etc/clickhouse-server/config.d/listen.xml:ro" -v "$SCHEMA:/schema.sql:ro" -e CLICKHOUSE_SKIP_USER_SETUP=1 "$IMAGE" >/dev/null
for _ in $(seq 1 60); do sudo docker exec "$NAME" clickhouse-client -q 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
# the schema has a dictionary that loads from the Akvorado orchestrator (absent here): it stays empty, which is fine for these tests.
# Statements are applied one by one with retries because the file is alphabetical and views precede the tables they read.
node "$HERE/apply-schema.mjs" "$SCHEMA" http://127.0.0.1:8123
sudo docker exec "$NAME" clickhouse-client -q "CREATE USER IF NOT EXISTS grafana_ro IDENTIFIED BY 'dummy-ro-pw-test' SETTINGS readonly = 2"
sudo docker exec "$NAME" clickhouse-client -q "GRANT SELECT ON default.* TO grafana_ro"
sudo docker exec "$NAME" clickhouse-client -q "GRANT SELECT ON system.* TO grafana_ro"
echo "clickhouse $(sudo docker exec "$NAME" clickhouse-client -q 'SELECT version()') ready; tables: $(sudo docker exec "$NAME" clickhouse-client -q "SELECT groupArray(name) FROM system.tables WHERE database='default' AND name LIKE 'flows%' AND NOT name LIKE '.inner%'")"
