# Changelog

## [1.0.0] - 2026-10-10

First published release. Content = the **running** grafana-01 (Grafana OSS 13.2.3), captured through its API.

### Captured (unchanged behaviour)
* 7 dashboards (5 NetFlow / ClickHouse, 2 NOC / Zabbix) with their uids, variables, queries and panels; folders `NetFlow` and `NOC`; datasources `zabbix-lab` and `netflow-clickhouse` (definitions only); playlist `NetFlow NOC Rotation`; plugin pins (Zabbix app 6.8.0, ClickHouse 4.22.0).
* `scripts/verify.mjs` against the live instance: PASS (19 checks). `scripts/apply.mjs --dry-run`: 12 unchanged.

### Added
* API tooling: `apply` (idempotent, duplicate-safe, `--dry-run`, `--rotate-secrets`), `verify` (read-only), `backup`, `restore` (manifest-verified, dry-run default), `tools/export-live.mjs`, `tools/inventory.mjs`.
* Host tooling for the Debian 12 LXC: `install-lxc.sh`, `upgrade-lxc.sh`, `backup-lxc.sh`, `rollback-lxc.sh`, `verify-lxc.sh` (**not yet executed**).
* NetFlow dashboard generator (`tools/netflow`) with a test proving it reproduces the committed dashboards.
* Optional file provisioning (clean installs only), `scripts/release-gate.sh`, `tests/clean-room-local.sh` (13 checks against a throw-away Grafana), documentation.

### Known gaps
See `docs/live-inventory.md` findings G1-G7 and `docs/validation.md` (LXC scripts and clean-room Debian install: PENDING).
