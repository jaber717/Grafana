# Architecture

```
                         +------------------------------ grafana-01 (Debian 12 LXC, 192.168.1.194) ------------------------------+
 operator / NOC TV  --HTTP 3000-->  Grafana OSS 13.2.3  (SQLite, plugins: alexanderzobnin-zabbix-app 6.8.0, grafana-clickhouse-datasource 4.22.0)
                         |                                   |
        datasource zabbix-lab (uid)                datasource netflow-clickhouse (uid)
                         |  HTTPS :8443, user grafana-ro      |  HTTP :8123, user grafana_ro (read-only, source-restricted)
                         v                                   v
                 Zabbix LAB 7.0.30 API              ClickHouse 26.8 on netflow-01 (192.168.1.195)  <--  Akvorado (inlet -> Kafka -> outlet)
                 (NOC dashboards)                   (5 NetFlow dashboards)                              <--  routers / firewalls (NetFlow v9, IPFIX, sFlow)
```

## Responsibilities

| Component | Owns |
|---|---|
| This repository | dashboards (JSON), folders, datasource *definitions*, the playlist, pinned versions, deploy/verify/backup/rollback tooling |
| grafana-01 | the running Grafana, its database, plugin files, datasource *secrets* (encrypted in the database) |
| jaber717/Akvorado | the ClickHouse side: tables, retention, the `grafana_ro` user, the firewall rule that admits only 192.168.1.194 |
| Zabbix LAB | the `grafana-ro` account and the data behind the NOC dashboards |

## Dashboards

* **NOC** (`dashboards/noc`, datasource Zabbix): `noc-wan-overview` — six fixed WAN-link panels (STC, MOBILY, SAIX-A, SAIX-B, SITE-A, SITE-B), IN/OUT per link, item-ID mode of the Zabbix plugin; `noc-device-health` — CPU, memory, uptime, availability.
* **NetFlow** (`dashboards/netflow`, datasource ClickHouse): read Akvorado's rollup tables (`flows_1m0s`, `flows_5m0s`, `flows_1h0m0s`) chosen by time range, and the raw `flows` table only for IPs/ports/conversations, capped to 24 h. A *Data scope* variable (default "Real only") hides the synthetic demo exporter `::ffff:247.16.14.11`. Source of truth is the committed JSON; `tools/netflow/generate.mjs` reproduces it (`tests/check-generator.sh`).
* Playlist **NetFlow NOC Rotation** cycles the five NetFlow dashboards every 45 s for a wallboard.

## How state flows

`tools/export-live.mjs` (capture) → Git → `scripts/apply.mjs` (API, idempotent) → Grafana. `scripts/verify.mjs` closes the loop (read-only drift detection). `scripts/backup.mjs` / `restore.mjs` give a content rollback; `*-lxc.sh` give a host-level rollback (database + config + package version).

## Identifier policy

Everything is matched by **uid** (dashboards, folders, datasources) or **name** (playlists). `id` and `version` are instance-specific and are removed from the stored JSON and ignored in comparisons.
