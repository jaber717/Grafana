# Dependencies on Zabbix, Akvorado and ClickHouse

| Dependency | Used by | What must be true | How to check | If it breaks |
|---|---|---|---|---|
| **Zabbix LAB 7.0.x API** `https://192.168.1.91:8443/api_jsonrpc.php` | datasource `zabbix-lab`, both NOC dashboards | account `grafana-ro` exists with read access to the monitored hosts/items; API reachable from grafana-01; plugin `alexanderzobnin-zabbix-app` 6.8.0 | `scripts/verify.sh` → "datasource zabbix-lab health - Zabbix API version 7.0.30" | NOC panels show "No data"/datasource error; fix the account/URL/TLS, then `apply.sh --datasource-only --rotate-secrets` if the password changed |
| **Zabbix item IDs** | `noc-wan-overview` (item-ID mode: IN `51487 51751 51610 51528 51661 51570`, OUT `51496 51760 51619 51537 51679 51585` as found in the dashboard JSON) | the six WAN interface items still exist with the same IDs | open the dashboard; a deleted/recreated item shows no data | re-point the panel to the new item ID in `dashboards/noc/noc-wan-overview.json` (and re-capture) |
| **ClickHouse on netflow-01** `192.168.1.195:8123` | datasource `netflow-clickhouse`, five NetFlow dashboards | HTTP port published on the host IP and admitted **only** for 192.168.1.194 (DOCKER-USER); account `grafana_ro` read-only (readonly=2, 30 s / 600 MB / 2 threads limits) with SELECT on `default.flows`, `flows_1m0s`, `flows_5m0s`, `flows_1h0m0s`, `exporters` and `system.*` health tables | `scripts/verify.sh` → "datasource netflow-clickhouse health"; Akvorado repo `scripts/verify.sh` on netflow-01 | NetFlow dashboards fail; check the firewall rule and the `grafana-ro-password` |
| **Akvorado** (jaber717/Akvorado) | produces the data in ClickHouse | tables named as in `docs/reference/clickhouse-schema.sql` of that repository; rollup resolutions 1m/5m/1h retained 30 d / 90 d / 365 d, raw 14 d | dashboards "Platform Health" shows last-flow age and ingestion | an Akvorado upgrade that renames columns/tables needs a dashboard regeneration (`tools/netflow/generate.mjs`) |
| **Flow exporters** | no flows → empty NetFlow panels | routers send NetFlow/IPFIX/sFlow to netflow-01 | "Platform Health": "NO RECENT FLOWS" is not an outage of Grafana | operational |
| **Zabbix monitoring of grafana-01** | not used by dashboards | Agent 2 + `Grafana HTTP` item on host `grafana-01` *(hand-over)* | Zabbix | n/a |

## Version coupling

* The NetFlow queries were written against Akvorado **2026.10.0** / ClickHouse **26.8** schemas.
* The NOC dashboards use the Zabbix plugin's panel/query format of **6.8.0** against Zabbix **7.0.30**.
* Grafana **13.2.3** is the version both were authored and live-tested on; the plugin versions are pinned in `plugins/plugins.txt`.
