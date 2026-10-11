# LAB versus production — exactly what differs

Same repository, same dashboards, same pinned Grafana and plugins. Two **environment files** (`env/lab.env.example`, `env/production.env.example`) hold every difference; secrets are files outside Git in both.

| | LAB (grafana-01, release 1.0.0 — unchanged) | Production (RHEL 9, `grafana-platform`) |
|---|---|---|
| Platform | Debian 12, unprivileged LXC on Proxmox | **RHEL 9**, virtual or physical, SELinux Enforcing, firewalld |
| Installer | `lab/scripts/install-lxc.sh` (APT repository, `apt-mark hold`) | `bin/grafana-platform install` (signed RPM, `dnf versionlock`, vendored+pinned key) |
| Service | Debian package unit + LXC systemd drop-in | RPM unit `grafana-server.service`, EnvironmentFile `/etc/sysconfig/grafana-server` |
| Listener | `http://192.168.1.194:3000` | `https://<GRAFANA_DOMAIN>:3000`, TLS ≥ 1.2, HSTS, secure cookies |
| Network admission | LAN | firewalld rich rules for `GRAFANA_ALLOWED_CIDRS` only (required, no default) |
| Zabbix datasource | `https://192.168.1.91:8443/api_jsonrpc.php`, LAB read-only user, **item ids of the LAB database** | `ZABBIX_URL` of the production Zabbix, its own read-only user, certificate verified; NOC dashboards use an **item map** to production item ids ([ZABBIX-ITEM-MAP.md](ZABBIX-ITEM-MAP.md)) |
| ClickHouse datasource | `http://192.168.1.195:8123`, plain HTTP, `grafana_ro` | `https://<netflow host>:8443`, TLS verified, `grafana_ro` (read-only, source-restricted to this Grafana) |
| Secrets | set by hand on grafana-01; never in Git | files in `/etc/grafana-platform/secrets/` (admin password and `secret-key` generated) |
| Content | applied from a workstation with `scripts/apply.sh` (API mode) | applied by `grafana-platform install` on the server (same tool, same UIDs) |
| Dashboards | 7 (5 NetFlow + 2 NOC), 2 folders, 1 playlist | identical files and UIDs; the NOC pair needs the item map or is skipped with a WARN (`ALLOW_NOC_WITHOUT_ITEM_MAP=yes`) |
| Backups | `lab/scripts/backup-lxc.sh` | `grafana-platform backup` + daily timer; archives optionally GPG-encrypted; restore refuses a wrong `secret-key` |
| Upgrade / rollback | `lab/scripts/upgrade-lxc.sh`, `rollback-lxc.sh` | `grafana-platform upgrade` / `rollback` with automatic rollback |
| Offline | not supported | offline bundle ([OFFLINE.md](OFFLINE.md)) |
| Dependencies on Debian/LXC | yes | **none** |
| Verification | `lab/scripts/verify-lxc.sh`, `scripts/verify.sh` | `grafana-platform verify` (adds RHEL/SELinux/firewalld/package-signature/permission checks) |

## Files that are LAB-only (kept for the running LAB; not used on RHEL)
`lab/scripts/*-lxc.sh`, `lab/tests/clean-room-local.sh`, `.env.example` (API credentials template for workstation use), `provisioning/` (file provisioning for a Debian instance), `config/datasources.json`
(the captured LAB definition — the production datasources are rendered from `config/datasources.tmpl.json` and the environment file; a unit test proves that `env/lab.env.example` renders **exactly** the captured LAB file).

## Files shared by both
`dashboards/**`, `config/folders.json`, `config/playlists.json`, `config/datasources.tmpl.json`, `plugins/plugins.txt`, `VERSIONS.env`, `scripts/*.mjs` (apply/verify/backup/restore content tools), `tools/`.

## Rules that keep the two apart
* The production tooling never contains or defaults to a LAB address; `release-gate.sh` fails if `env/production.env.example` mentions one.
* The LAB must never be a datasource of a test or production Grafana, and production credentials must never be used in a test: the acceptance tests use throw-away certificates and dummy credentials on isolated machines.
