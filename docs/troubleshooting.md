# Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| `verify.sh`: `datasource zabbix-lab health` FAIL, message about login | `grafana-ro` password wrong/locked or Zabbix unreachable | log in to Zabbix as `grafana-ro` from another client; `apply.sh --datasource-only --rotate-secrets` with the right password. Repeated wrong passwords lock the account for a short time — do not loop |
| `datasource zabbix-lab health` FAIL, TLS error | certificate changed and `tlsSkipVerify` was turned off | trust the Zabbix CA, or restore `tlsSkipVerify` as deployed |
| `datasource netflow-clickhouse health` FAIL, timeout | the ClickHouse HTTP port is firewalled for this Grafana's IP | netflow-01: `iptables -S DOCKER-USER` must allow `<grafana IP>/32` on 8123 before the DROP (Akvorado `docs/grafana.md`) |
| `datasource netflow-clickhouse health` FAIL, authentication | `grafana_ro` password rotated | `CLICKHOUSE_RO_PASSWORD=... scripts/apply.sh --datasource-only --rotate-secrets` |
| NetFlow panels "No data" but health OK | no real exporter is sending (scope "Real only"), or time range older than raw retention (14 d) | set *Data scope* to "Real + demo" to see the synthetic data; check Akvorado `scripts/status.sh` |
| `apply.sh`: `required plugin ... is not installed` | plugin missing on the target | `grafana cli plugins install <id> <version>` (versions in `plugins/plugins.txt`), restart Grafana |
| `apply.sh`: `refused ... would create a duplicate` | a dashboard with the same title but another uid exists in that folder | find it (`/api/search?query=...`); delete or re-uid it; `--allow-title-conflicts` forces creation |
| `apply.sh`: `datasource ... missing ... is not set` | the datasource must be created but the secret is not in the environment | export `ZABBIX_GRAFANA_PASSWORD` / `CLICKHOUSE_RO_PASSWORD` |
| `verify.sh`: `dashboard X content differs` | edited in the UI | capture it (`tools/export-live.mjs`) if intended, or `apply.sh` to revert |
| `verify.sh`: `unmanaged dashboard` WARN | extra dashboard in a managed folder | informational; nothing deletes it |
| HTTP 401/403 from the scripts | the account is not an Admin or the token expired | datasource and folder writes need Admin; use a service-account token with Admin role |
| `install-lxc.sh`: `LXC drop-in missing` | unprivileged LXC without the compatibility drop-in | copy `/etc/systemd/system/grafana-server.service.d/lxc.conf` from grafana-01 first (finding G3) |
| `grafana-server` fails in an unprivileged LXC with namespace/sandbox errors | systemd sandboxing options not permitted | the drop-in above; journal: `journalctl -u grafana-server -b` |
| After an upgrade Grafana is unhealthy | failed DB migration | `scripts/rollback-lxc.sh` |
| Scripts print `EPIPE` / garbled non-ASCII titles on Windows | piping to `head`/`grep -q`, or a non-UTF-8 console | capture output into a variable first; dashboard titles contain "—" (U+2014) — keep files UTF-8 |
