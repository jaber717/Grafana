# Grafana — NOC / WAN / NetFlow dashboards (grafana-01)

> **Release 1.0.0** — captured from the running **grafana-01** on 2026-10-10 (Grafana OSS **13.2.3**, Zabbix plugin **6.8.0**, ClickHouse plugin **4.22.0**).
> The repository equals the live instance: `scripts/verify.mjs` → **PASS (19 checks)**, `scripts/apply.mjs --dry-run` → **12 unchanged, 0 to write**.
> The API tooling was also exercised end to end on a throw-away Grafana 13.2.3 (**13/13**). The **LXC/Debian host scripts have not been executed** and a
> **clean-room install on a fresh Debian 12 container is PENDING** — see [docs/validation.md](docs/validation.md).

Dashboards-as-code for the existing Grafana LXC. Nothing is rebuilt from scratch: every dashboard, folder, datasource definition and the playlist in this
repository is the **deployed** object (exported through the API), so applying the repository to the live instance changes nothing.

## What is in the box

| Path | Content |
|---|---|
| `dashboards/netflow/` | 5 NetFlow dashboards (ClickHouse / Akvorado): `netflow-overview`, `netflow-top-talkers`, `netflow-asn`, `netflow-exporters`, `netflow-health` |
| `dashboards/noc/` | 2 NOC dashboards (Zabbix): `noc-wan-overview` (6 WAN links), `noc-device-health` |
| `config/` | `folders.json`, `datasources.json` (definitions only — no secrets), `playlists.json` |
| `plugins/plugins.txt`, `VERSIONS.env` | pinned plugin and Grafana versions |
| `provisioning/` | OPTIONAL file-provisioning equivalents (clean installs only; secrets via environment) |
| `scripts/apply.sh` · `verify.sh` · `backup.sh` · `restore.sh` | API tooling (Node ≥ 18, run from any workstation that can reach Grafana) |
| `scripts/install-lxc.sh` · `upgrade-lxc.sh` · `backup-lxc.sh` · `rollback-lxc.sh` · `verify-lxc.sh` | host tooling, run **inside** the Debian 12 container as root |
| `scripts/release-gate.sh` | static pre-release checks |
| `tools/` | `export-live.mjs` (capture a live Grafana), `inventory.mjs` (generates `docs/dashboard-inventory.md`), `netflow/generate.mjs` (+ `test-queries.mjs`) |
| `tests/` | `clean-room-local.sh` (API tooling vs a throw-away Grafana), `check-generator.sh` |
| `docs/` | architecture, installation, operations, upgrade/rollback, troubleshooting, dependencies, live inventory, validation |

## Quick start (existing grafana-01 — no change expected)

```bash
git clone https://github.com/jaber717/Grafana.git && cd Grafana && git checkout v1.0.0
export GRAFANA_URL=http://192.168.1.194:3000 GRAFANA_USER=admin GRAFANA_PASSWORD=...   # or GRAFANA_TOKEN=...  (environment only)
scripts/verify.sh               # read-only: PASS = Grafana equals the repository
scripts/apply.sh --dry-run      # read-only: shows what apply would write (nothing today)
```

## Fresh Grafana (new container)

See [docs/installation.md](docs/installation.md): `scripts/install-lxc.sh` (inside the container) → `scripts/apply.sh` (from a workstation, with the two datasource secrets in the environment) → `scripts/verify.sh`.

## Design rules

* **Idempotent**: `apply` compares every object with the live one and writes only what differs; a second run writes nothing and creates no duplicate dashboards (dashboards are matched by `uid`; a same-title dashboard under another uid is refused).
* **No secrets in Git**: datasource passwords, tokens and admin logins come from the environment; Grafana never returns datasource secrets, so exports contain none. `scripts/release-gate.sh` blocks credential-like literals.
* **Never destructive by default**: `apply` does not delete anything; `restore` is a dry run unless `--apply`.
* The deployed dashboards were created through the API (not file-provisioned); this repository keeps that mode. File provisioning is provided for clean installs only (`docs/provisioning-mode.md`).

## Dependencies on the other platforms

grafana-01 → **Zabbix LAB** API `https://192.168.1.91:8443` (read-only account `grafana-ro`) for the NOC dashboards; grafana-01 → **ClickHouse on netflow-01** `192.168.1.195:8123` (read-only account `grafana_ro`, allowed only from 192.168.1.194) for the NetFlow dashboards, which show data collected by **Akvorado** (repository jaber717/Akvorado). Details: [docs/dependencies.md](docs/dependencies.md).

## Release discipline

`VERSION`, `CHANGELOG.md`, `scripts/release-gate.sh` (must PASS), annotated tags `vX.Y.Z`; `docs/validation.md` states what was live-verified, statically checked, and what is still pending.
