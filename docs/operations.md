# Operations, upgrade and rollback

## Daily / on demand (workstation, read-only)

```bash
scripts/verify.sh            # Grafana == repository?  PASS/FAIL/WARN per object, datasource health included
scripts/apply.sh --dry-run   # what would be written
node tools/netflow/test-queries.mjs --quiet   # run every NetFlow panel query through Grafana, report errors and timings (read-only SELECTs)
```
`WARN unmanaged dashboard` means someone created a dashboard in a managed folder: it is not deleted by anything here.

## Change a dashboard

1. Edit in the Grafana UI **or** in Git. If you edit in the UI, capture it: `node tools/export-live.mjs` (read-only against Grafana, rewrites the files), `node tools/inventory.mjs`, review the diff.
2. NetFlow dashboards are generated: edit `tools/netflow/generate.mjs`, run `node tools/netflow/generate.mjs` from the repository root (writes `dashboards/netflow/`), then the capture/apply flow.
3. `scripts/release-gate.sh` → `scripts/apply.sh --dry-run` → `scripts/apply.sh` → `scripts/verify.sh` → commit, bump `VERSION`/`CHANGELOG.md`, tag.

## Backup

| What | Command | Contains secrets? |
|---|---|---|
| Content as JSON (dashboards with versions, folders, datasource definitions, playlists, alerting objects, plugin list, users' logins) — workstation, API | `scripts/backup.sh --out backups --keep 10` | no (Grafana never returns datasource secrets) |
| Whole instance state (database, `/etc/grafana`, `/etc/default/grafana-server`, drop-ins) — inside the container | `lab/scripts/backup-lxc.sh` → `/var/backups/grafana-repo/grafana-lxc-<stamp>.tar.gz` (0600) | **yes** — keep off-host and protected |

Take both before any upgrade (the upgrade script takes the LXC one itself). Schedule is yours; recommended: content backup after every dashboard change, LXC backup weekly.

## Upgrade

```bash
# inside the container, as root
lab/scripts/upgrade-lxc.sh 13.x.y            # refuses an unavailable/same version; backs up; installs; re-installs plugins; waits for health
# afterwards, from a workstation
scripts/verify.sh
# then update VERSIONS.env (+ plugins/plugins.txt), CHANGELOG.md, tag a release
```
Grafana migrates its database on first start of a new version. That migration is not undone by downgrading the package — rollback restores the database copy.

## Rollback

| Situation | Command |
|---|---|
| A dashboard change was wrong | In Grafana: Dashboard → Settings → Versions → restore. Or `scripts/restore.sh backups/grafana-<stamp>` (dry run) then `--apply` |
| Content was damaged/deleted | `scripts/restore.sh backups/grafana-<stamp> --apply` (verifies the backup's SHA-256 manifest first; datasources are only reported — recreate with `scripts/apply.sh --datasource-only`) |
| Upgrade went bad | inside the container: `lab/scripts/rollback-lxc.sh` (uses `/var/backups/grafana-repo/last-upgrade`; saves the current state to `pre-rollback-<stamp>.tar.gz`, restores database + config, downgrades the package, restarts) |
| Whole container lost | recreate the container, `lab/scripts/install-lxc.sh`, restore `/var/lib/grafana/grafana.db` and `/etc/grafana` from a `backup-lxc.sh` archive (`lab/scripts/rollback-lxc.sh <archive>` does exactly that), or `apply.sh` for content only |

## Rotating the datasource secrets

ClickHouse: rotate on netflow-01 first (Akvorado repository, `docs/grafana.md`). Zabbix: change the `grafana-ro` password in Zabbix. Then push the new value into Grafana (the definitions are unchanged, so use `--rotate-secrets`):

```bash
CLICKHOUSE_RO_PASSWORD=... ZABBIX_GRAFANA_PASSWORD=... scripts/apply.sh --datasource-only --rotate-secrets
scripts/verify.sh        # datasource health must be OK
```
