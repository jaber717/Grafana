# Validation record — release 1.0.0 (2026-10-10)

> **RHEL 9 production platform (release 1.0.1):** the acceptance record is [VALIDATION-RHEL9.md](VALIDATION-RHEL9.md). This page is the LAB release 1.0.0 record and is kept as it was.

Legend: **LIVE** = executed against grafana-01 (GET requests only), **SANDBOX** = executed against a throw-away Grafana on the workstation, **STATIC** = files only, **PENDING** = not executed.

| # | Check | Type | Result | Evidence / limitation |
|---|---|---|---|---|
| 1 | Repository equals the running instance | LIVE | **PASS** (19 checks) | `scripts/verify.mjs`: health, Grafana 13.2.3, both plugins at the pinned versions, 2 folders, 2 datasource definitions **and their health** (Zabbix API 7.0.30; ClickHouse working), 7 dashboards identical (id/version ignored), playlist, alert rules (0). |
| 2 | `apply` would write nothing to the live instance | LIVE (dry run) | **PASS** | `scripts/apply.mjs --dry-run`: 12 unchanged, 0 created, 0 updated, 0 refused. **`apply` without `--dry-run` was never run against grafana-01.** |
| 3 | Dashboard JSON is the deployed JSON | LIVE | **PASS** | exported with `tools/export-live.mjs` (only `id` and `version` removed). The five NetFlow files also equal the files on netflow-01's deployment repo; `noc-wan-overview` equals the monorepo copy; `noc-device-health` (live v8) differs from the stale monorepo copy (finding G6) — the live one is captured. |
| 4 | API tooling end to end on an empty Grafana of the same version/commit with the pinned plugins | SANDBOX | **PASS** (13/13) | `lab/tests/clean-room-local.sh`: first apply creates 12 objects; second apply writes nothing; still 7 dashboards (no duplicates); same-title/other-uid refused; tampering detected and repaired; backup → delete → restore dry run → `--apply` → recreated; modified backup refused. Grafana 13.2.3 (commit `90ffed05…`, identical to production) on Windows with `alexanderzobnin-zabbix-app` 6.8.0 and `grafana-clickhouse-datasource` 4.22.0. |
| 5 | Secret rotation path (`--rotate-secrets`) | SANDBOX | **PASS** | unchanged definition → rewritten only with the flag; next run unchanged. |
| 6 | NetFlow generator reproduces the committed dashboards | STATIC | **PASS** | `tests/check-generator.sh` (5/5). |
| 7 | Shell and JS syntax, JSON consistency (uids, folders, datasource refs, playlist refs, plugin coverage), no secrets/keys/archives, inventory current, VERSION == CHANGELOG | STATIC | **PASS** | `scripts/release-gate.sh` (0 skipped). |
| 8 | `install-lxc.sh`, `upgrade-lxc.sh`, `backup-lxc.sh`, `rollback-lxc.sh`, `verify-lxc.sh` | STATIC only | **PENDING** | `bash -n` only. They have never been executed: there was no SSH/pct access to grafana-01 and no clean Debian 12 container. |
| 9 | Clean-room install on a fresh Debian 12 container (`install-lxc.sh` → `apply.sh` → `verify.sh`) | - | **PENDING** | |
| 10 | Unprivileged-LXC systemd drop-in reproduced | - | **PENDING / BLOCKED** | content not readable in this session (finding G3). |
| 11 | File-provisioning mode | - | **PENDING** | untested; documented as clean-install-only. |
| 12 | `restore.mjs --apply` and `apply.mjs` (real writes) on grafana-01 | - | **NOT RUN** | deliberately, to avoid changing production. |

## Incident during validation (disclosed)

The first sandbox run used the repository's real datasource endpoints. Creating the datasources made the throw-away Grafana run a health check, which sent **one login attempt with a dummy password to the LAB Zabbix API as `grafana-ro`** (and one connection attempt to ClickHouse :8123, which the netflow-01 firewall drops for non-grafana-01 sources). No lock-out threshold was reached, nothing was changed in Zabbix, and the production datasource health was re-checked OK afterwards. The sandbox was immediately repointed to dead loopback endpoints and `apply.mjs` gained `APPLY_SANDBOX_ENDPOINTS=1` (refused unless `GRAFANA_URL` is loopback), which `lab/tests/clean-room-local.sh` now always sets.
