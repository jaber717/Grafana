# File-provisioning mode (alternative, clean installs only)

grafana-01 is run in **API mode**: its dashboards and datasources were created through the HTTP API and are editable in the UI. This repository keeps that mode (`scripts/apply.sh`).

`provisioning/` contains the file-provisioning equivalent for a **new** Grafana that should be fully configured by files:

* `provisioning/datasources/datasources.yaml` — the same two datasources; secrets are `$ZABBIX_GRAFANA_PASSWORD` / `$CLICKHOUSE_RO_PASSWORD`, expanded by Grafana from the `grafana-server` environment (Debian: `/etc/default/grafana-server`, mode 0640 root:grafana).
* `provisioning/dashboards/dashboards.yaml` — two file providers (`netflow`, `noc`) with `disableDeletion: true`, `allowUiUpdates: false`; dashboards are copied to `/var/lib/grafana/dashboards/<folder>/` by `install-lxc.sh --provisioning`.

**Do not enable it on grafana-01 or mix it with `apply.sh` on one instance**: the file providers would take over (or conflict with) the API-created dashboards that have the same uids, and provisioned datasources cannot be edited or updated through the API. If you ever migrate grafana-01 to provisioning, back up first (`backup.sh`, `backup-lxc.sh`), remove the API-created datasources/dashboards in a planned window, then install the files.

Status: **not tested** (no clean Debian 12 container was available).
