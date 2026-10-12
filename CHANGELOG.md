# Changelog

## [Unreleased] — feature/daily-reports

Daily NetFlow and Interface traffic reports rendered by Grafana (docs/DAILY-REPORTS.md, docs/reports/VALIDATION.md). **No change to any of the seven operational dashboards, to any UID or datasource definition, or to the v1.0.1 release.**

### Added
* `bin/grafana-report` (+ `reports/`): `run`, `generate`, `deliver`, `test-delivery`, `check-config`, `build-dashboards`, `discover`, `status`, `schedule`, `load-image`, `demo`. Dependency-free Node.js.
* Two report dashboards in the folder `NOC / Daily Reports` (generated; reference copies in `reports/dashboards/`), A4-landscape PDF composer with a layout guard, DEMO / PARTIAL / NO DATA designs, example PDFs and previews (`docs/reports/examples/`).
* E-mail (SMTP with STARTTLS/TLS, HTML + text, multiple recipients) and Telegram delivery with retries, duplicate protection (ledger, lock, already-delivered short-circuit) and failure notices.
* systemd: `grafana-report.service/.timer` (07:00 Asia/Riyadh, off until enabled), `grafana-image-renderer.service` (digest-pinned image, Podman), `scripts/install-reports.sh`, offline renderer bundle (`tools/build-renderer-bundle.sh`).
* Optional `[rendering]` block in the platform's `grafana.ini` (`RENDERING_SERVER_URL`, `RENDERING_CALLBACK_URL`, `RENDERING_TOKEN_FILE`; **off by default**, token read from a file).
* Tests: 106 unit/integration tests (6 end-to-end with real Chromium), RHEL validation scripts (real ClickHouse 174 checks, real Zabbix plugin accuracy 20 checks, resource measurement, systemd hardening bisection).

## [1.0.1] - 2026-10-11

RHEL 9 production platform. **No change to any dashboard, UID, datasource definition or plugin version** (a unit test proves the LAB environment renders the captured LAB datasources byte-for-byte).

### Added
* `bin/grafana-platform` (+ `lib/`): `preflight`, `install`, `verify`, `status`, `backup`, `restore` (incl. `--bootstrap` for bare-host recovery), `upgrade` (backup first, automatic rollback), `rollback`, `rotate-secrets`. Idempotent, PASS/WARN/FAIL.
* Native Grafana RPM install: vendored signing key with pinned fingerprint, `gpgcheck`/`repo_gpgcheck`, `includepkgs`, `dnf versionlock`; plugins pinned by SHA-256; Node.js content tools.
* Environment separation: `env/production.env.example`, `env/lab.env.example`, `config/datasources.tmpl.json`; secrets only in files; HTTPS listener, firewalld source rules, SELinux/firewalld checks.
* Zabbix item map for the NOC dashboards (`config/zabbix-item-descriptors.json`, `tools/zabbix-item-map.mjs`).
* Offline bundle builder (`tools/build-offline-bundle.sh`), daily backup timer, `tools/panel-smoke.mjs`.
* Documents: production guide, backup/restore, offline, security, LAB-vs-production, item map, GitHub access, RHEL validation. Release gate extended (unit tests, template and pin checks).

### Changed
* Debian/LXC host scripts moved to `lab/` (unchanged apart from paths).
* `GRAFANA_VERSION_OVERRIDE`-aware version checks in `scripts/verify.mjs`.

### Known limitations
See [docs/VALIDATION-RHEL9.md](docs/VALIDATION-RHEL9.md): accepted on RHEL 9.6 test machines, **RHEL 9 run pending**; Grafana is not SELinux-confined (no policy ships with RHEL); NOC panel *values* need a production Zabbix to be validated; release assets are not signed.

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
