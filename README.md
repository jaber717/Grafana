# Grafana — NOC / WAN / NetFlow dashboards

Dashboards-as-code **and** a production installer for Grafana OSS **13.2.3** (Zabbix app 6.8.0, ClickHouse datasource 4.22.0):
seven dashboards (UIDs preserved), two folders, two datasources, one playlist.

| | |
|---|---|
| **Production target** | **RHEL 9**, native signed RPM + systemd, SELinux Enforcing, firewalld, TLS, secrets in files — `bin/grafana-platform` · [docs/PRODUCTION-RHEL9.md](docs/PRODUCTION-RHEL9.md) |
| **LAB (unchanged)** | grafana-01, Debian 12 LXC — `lab/scripts/*-lxc.sh`, API tools `scripts/apply.sh`, `verify.sh` · [docs/LAB-VS-PRODUCTION.md](docs/LAB-VS-PRODUCTION.md) |
| **Evidence** | [docs/VALIDATION-RHEL9.md](docs/VALIDATION-RHEL9.md) — acceptance matrix, exact versions tested, open gates |

> **Tested on RHEL 9.6** (clean install, idempotency, backup/restore/disaster recovery, upgrade/rollback, offline bundle). Any RHEL 9.x is accepted by `preflight` (RHEL 8 and 10 are rejected); other 9.x releases are supported targets, not individually validated.

## Production in five commands

```bash
tar xzf grafana-platform-1.0.1-rhel9-offline.tar.gz && cd grafana-platform-1.0.1     # or a git checkout of tag v1.0.1 (docs/GITHUB-ACCESS.md)
sudo install -d -m 0700 /etc/grafana-platform/secrets   # then create zabbix-password and clickhouse-password there (mode 600)
cp env/production.env.example /root/grafana.env && vi /root/grafana.env              # domain, CIDRs, URLs, certificate paths
sudo bin/grafana-platform preflight --env-file /root/grafana.env                     # read-only readiness check; PASS/WARN/FAIL
sudo bin/grafana-platform install   --env-file /root/grafana.env                     # idempotent install + full verification
```

Afterwards: `grafana-platform verify | status | backup | restore | upgrade | rollback | rotate-secrets` (see the guide).

## Daily traffic reports

Two A4-landscape PDFs every morning (NetFlow, Interface traffic) built from **Grafana panels** and delivered by e-mail / Telegram: [docs/DAILY-REPORTS.md](docs/DAILY-REPORTS.md) (install, configuration, operation), [docs/reports/VALIDATION.md](docs/reports/VALIDATION.md) (evidence, sizing, limits, GO/NO-GO), [docs/reports/examples/](docs/reports/examples/README.md) (DEMO, PARTIAL and NO DATA examples).

## Repository map

| Path | Content |
|---|---|
| `bin/grafana-platform`, `lib/` | the production control script (preflight, install, verify, status, backup, restore, upgrade, rollback) |
| `env/production.env.example`, `env/lab.env.example` | every environment-specific setting; no secrets |
| `dashboards/netflow/` · `dashboards/noc/` | 5 NetFlow dashboards (ClickHouse/Akvorado) and 2 NOC dashboards (Zabbix) |
| `config/` | folders, playlist, `datasources.tmpl.json` (rendered from the environment), the captured LAB `datasources.json`, Zabbix item descriptors |
| `vendor/rpm/RPM-GPG-KEY-grafana` | Grafana Labs signing key, fingerprint pinned in `VERSIONS.env` |
| `plugins/plugins.txt`, `VERSIONS.env` | pinned versions and SHA-256 values |
| `scripts/*.mjs`, `tools/` | content tools (apply/verify/backup/restore through the Grafana API), Zabbix item-map builder, offline bundle builder, panel smoke test |
| `systemd/` | daily backup timer |
| `tests/unit`, `tests/rhel` | unit tests; acceptance helpers (test PKI, mock Zabbix) for isolated machines |
| `lab/` | Debian/LXC LAB scripts (not used on RHEL) |
| `docs/` | production guide, backup/restore, offline, security, LAB-vs-production, item map, GitHub access, validation, + the original LAB documents |

## Design rules
* **Idempotent and fail-safe**: every step checks before it changes; `preflight` changes nothing; an interrupted install resumes; a failed upgrade rolls back by itself.
* **No secrets in Git**, no secrets on command lines, no silently disabled certificate verification.
* **Dashboards are never rewritten by the platform**: the Zabbix item ids of the NOC dashboards are mapped in memory at deployment ([docs/ZABBIX-ITEM-MAP.md](docs/ZABBIX-ITEM-MAP.md)).
* The LAB (`grafana-01`) is not touched by this release; its documents stay in `docs/` (`installation.md`, `live-inventory.md`, …).

## Release discipline
`VERSION`, `CHANGELOG.md`, `scripts/release-gate.sh` (must PASS), annotated tags `vX.Y.Z`, release assets with SHA-256 files; `docs/VALIDATION-RHEL9.md` states what was verified, on what, and what is still open.
