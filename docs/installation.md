# Installation

Two layers: the **host** (Grafana package + plugins, inside the container) and the **content** (dashboards/datasources, through the API).

## Prerequisites

* Debian 12 container or VM, root access, outbound HTTPS to `apt.grafana.com` and `grafana.com` (plugin download), `sqlite3` for backups.
* **For an LXC (unprivileged):** the systemd compatibility drop-in `/etc/systemd/system/grafana-server.service.d/lxc.conf` that grafana-01 uses. *Its content is not in this repository (not readable when captured, finding G3).* Copy it from grafana-01 (`cat` it) or recreate it before running the installer; the script refuses on an LXC without it unless `--skip-lxc-dropin-check`.
* Reachability: Zabbix API `https://192.168.1.91:8443`; ClickHouse `192.168.1.195:8123` (netflow-01 admits only 192.168.1.194 — a new Grafana IP needs the change described in the Akvorado repository's `docs/grafana.md`).
* Secrets, from your password store: Grafana admin login (set on first start), `ZABBIX_GRAFANA_PASSWORD` (Zabbix account `grafana-ro`), `CLICKHOUSE_RO_PASSWORD` (`/opt/netflow/secrets/grafana-ro-password` on netflow-01).
* A workstation with Node.js ≥ 18 for the content scripts.

## Fresh install

```bash
# 1. inside the container, as root
git clone https://github.com/jaber717/Grafana.git /opt/grafana-repo && cd /opt/grafana-repo && git checkout v1.0.0
scripts/install-lxc.sh --dry-run          # prints every action
scripts/install-lxc.sh                    # Grafana 13.2.3 (held), pinned plugins, service enabled and healthy
scripts/verify-lxc.sh                     # host checks (read-only)

# 2. on first start set the admin password through Grafana (UI first-login prompt or `grafana cli admin reset-admin-password`)

# 3. from a workstation
export GRAFANA_URL=http://<grafana-host>:3000 GRAFANA_USER=admin GRAFANA_PASSWORD=...
export ZABBIX_GRAFANA_PASSWORD=... CLICKHOUSE_RO_PASSWORD=...
scripts/apply.sh --dry-run                # shows what will be created
scripts/apply.sh                          # folders, datasources, 7 dashboards, playlist (idempotent)
scripts/verify.sh                         # expect: VERIFY: PASS
```

`scripts/install-lxc.sh --provisioning` is the alternative for a clean instance that should be configured by files (see [provisioning-mode.md](provisioning-mode.md)); do not combine it with `apply.sh`.

## Existing grafana-01

Nothing to install. `scripts/verify.sh` should PASS and `scripts/apply.sh --dry-run` should report `0 created, 0 updated`. To change content: edit under `dashboards/`, `scripts/release-gate.sh`, `scripts/apply.sh --dry-run`, then `scripts/apply.sh`.

## Status of this procedure

`install-lxc.sh` has **not been executed** (no clean Debian 12 container was available and grafana-01 must not be touched). The content procedure (steps 3) was executed against a throw-away Grafana 13.2.3 with the pinned plugins: [validation.md](validation.md).
