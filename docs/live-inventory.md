# Captured state of the running Grafana (2026-10-10)

Method: **read-only HTTP API** of grafana-01 with the administrator login from the local access bundle (GET requests only), the Grafana health/datasource-health endpoints, and the earlier hand-over document. There was **no filesystem or SSH access to the container** in this session (key authentication refused for root/claude/grafana on 192.168.1.194), so file-level facts are marked *(hand-over, not re-inspected)*.

## Instance

| | |
|---|---|
| Host | `grafana-01`, `192.168.1.194`, Proxmox CT 206, Debian 12, 2 vCPU / 4 GiB / 20 GiB, autostart *(hand-over)* |
| Grafana | OSS **13.2.3**, commit `90ffed056f0884267356c12a0eeb72a022af53f1`, `grafana-server` on `http://0.0.0.0:3000` (plain HTTP) |
| Database | SQLite `grafana.db` under `/var/lib/grafana` (API: `database.type=sqlite3`); paths are the Debian-package defaults (`/etc/grafana/provisioning`, `/var/lib/grafana/plugins`, `/var/log/grafana`) |
| Instance name | `grafana-01` |
| Orgs / users | 1 org (Main Org.); users `admin` (Grafana admin) and `grafana-noc` ("NOC Viewer", read-only dashboards). No teams, no service accounts |
| Auth settings | sign-up off, anonymous off, basic auth on, default new-user role Viewer, brute-force protection on, `cookie_secure=false`, `allow_embedding=false` |
| Containers | unprivileged LXC; `/etc/systemd/system/grafana-server.service.d/lxc.conf` compatibility drop-in *(hand-over; content not captured)* |
| Monitored by | Zabbix Agent 2 7.0.31 in the container, host `grafana-01` in Zabbix with the Linux template and an agent-local `web.page.get[127.0.0.1,/api/health,3000]` item *(hand-over; Zabbix API authentication failed in this session, so not re-verified)* |

## Plugins (non-core, from `/api/plugins`)

`alexanderzobnin-zabbix-app` **6.8.0** (also provides `alexanderzobnin-zabbix-datasource` and `-triggers-panel` 6.8.0), `grafana-clickhouse-datasource` **4.22.0**. Other entries returned (loki, prometheus, tempo, elasticsearch, ... ) are Grafana's bundled/pre-installed plugins and are not managed here.

## Datasources (2)

| uid | Name | Type | Endpoint | Auth | Health (this session) |
|---|---|---|---|---|---|
| `zabbix-lab` (default) | Zabbix LAB | alexanderzobnin-zabbix-datasource | `https://192.168.1.91:8443/api_jsonrpc.php` | user `grafana-ro` + password (secret in Grafana) | OK — "Zabbix API version 7.0.30" |
| `netflow-clickhouse` | NetFlow ClickHouse | grafana-clickhouse-datasource | `192.168.1.195:8123` http, database `default` | user `grafana_ro` + password (secret in Grafana) | OK — "Data source is working" |

Zabbix datasource options as deployed: `trends: true`, `cacheTTL: 1h`, `alerting: true`, `tlsSkipVerify: true`. ClickHouse: dial 10 s, query 30 s, `secure: false`, `validateSql: false`.

## Content

| Folder (uid) | Dashboard (uid) | Live version | Last update | Datasource |
|---|---|---|---|---|
| NetFlow (`netflow`) | NOC Overview (`netflow-overview`) | 3 | 2026-10-06 | ClickHouse |
| | Top Talkers (`netflow-top-talkers`) | 3 | 2026-10-06 | ClickHouse |
| | ASN & Internet (`netflow-asn`) | 3 | 2026-10-06 | ClickHouse |
| | Exporters & Interfaces (`netflow-exporters`) | 3 | 2026-10-06 | ClickHouse |
| | Platform Health (`netflow-health`) | 2 | 2026-10-06 | ClickHouse |
| NOC (`noc`) | NOC — WAN Overview (`noc-wan-overview`) | 3 | 2026-10-04 | Zabbix |
| | NOC — Device Health (`noc-device-health`) | 8 | 2026-10-06 | Zabbix |

All seven were created **through the API** (`provisioned: false`). One playlist: **NetFlow NOC Rotation** (45 s, the five NetFlow dashboards in the order above). Panel-level detail: [dashboard-inventory.md](dashboard-inventory.md).
**Not present**: alert rules, contact points (policy default receiver `empty`), mute timings, notification templates, library panels, annotations managed here, teams, service accounts.

## Findings (recorded, NOT changed — the running instance is the source of truth)

| # | Finding | Impact / follow-up |
|---|---|---|
| G1 | Grafana is served over plain HTTP with `cookie_secure=false`. | LAN-only; credentials and session cookies cross the LAN unencrypted. Put it behind TLS if the LAN is not trusted. |
| G2 | The Zabbix datasource has `tlsSkipVerify: true`. | The API certificate is not verified. Trust the Zabbix CA and set it to `false`. |
| G3 | File-level configuration of the container (`grafana.ini` overrides, `/etc/default/grafana-server`, the LXC drop-in) was **not readable** in this session. The API shows only package-default paths and `instance_name=grafana-01`. | Reproducing an LXC from scratch needs the drop-in content; `install-lxc.sh` refuses to start on an LXC without it. Capture it from the container (read-only `cat`) and add it to `config/` in the next release. |
| G4 | The hand-over's bootstrap procedure sets the admin password through a systemd drop-in (`bootstrap-auth.conf`). | If that file still exists it holds a credential in clear text. `lab/scripts/verify-lxc.sh` warns about any `GF_*PASSWORD` in the drop-in directory. |
| G5 | Dashboards are API-created and editable, so a UI edit silently diverges from Git. | `scripts/verify.sh` detects drift; `apply` repairs it. |
| G6 | The older copy of `noc-device-health` in the monorepo (`Zabbix/grafana`) is **stale**: live version 8 differs from it. | This repository captures the live version 8; `noc-wan-overview` and the five NetFlow dashboards equal their earlier copies. |
| G7 | No alerting is configured. | Nothing to capture; add rules to this repository when created. |
