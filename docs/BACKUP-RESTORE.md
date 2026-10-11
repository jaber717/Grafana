# Backup, restore and recovery (RHEL 9 deployment)

## What a backup is

`grafana-platform backup` writes one archive `grafana-platform-<stamp>-<label>.tar.gz` (mode 0600) into `BACKUP_DIR` (default `/var/backups/grafana-platform`).
A **daily timer** (`grafana-platform-backup.timer`, 03:15 + random delay, `Persistent=true`) creates the `scheduled` ones; `BACKUP_KEEP` (default 8) regular and 5 safety
(`pre-upgrade`, `pre-restore`) archives are kept.

| Content | In every archive | Only with `--include-secrets` |
|---|---|---|
| `grafana.db` — taken with SQLite's online backup API (a consistent point-in-time copy while Grafana runs) and checked with `PRAGMA integrity_check` | ✔ | |
| What the database holds: dashboards, folders, library panels, datasources (passwords encrypted with `secret_key`), users, teams, service accounts/tokens, orgs, preferences, playlists, annotations, alert rules | ✔ | |
| `/etc/grafana/` (rendered `grafana.ini`, provisioning), `/etc/sysconfig/grafana-server`, TLS **certificate** | ✔ | TLS **private key** |
| `platform.env`, `release.json`, the Zabbix item map, public CA certificates named in the environment | ✔ | |
| A JSON export of dashboards/folders/datasources/playlist through the API (portable, human-readable) | ✔ | |
| `manifest.txt` with the SHA-256 of every file, versions, and the SHA-256 of `secret_key` | ✔ | |
| `/etc/grafana-platform/secrets/*`: `admin-password`, **`secret-key`**, `zabbix-password`, `clickhouse-password` | | ✔ |

**Not in the archive:** the Grafana RPM and plugins (re-installed from the pinned, verified sources — the offline bundle holds them), logs, rendered images, the derived search index
`/var/lib/grafana/unified-search` (rebuilt at start), and the **data of Zabbix and ClickHouse** (those are backed up by their own platforms; Akvorado: `akvorado-platform backup`).

`BACKUP_GPG_PASSPHRASE_FILE=<file>` encrypts the whole archive (`gpg --symmetric --cipher-algo AES256`, the file is `*.tar.gz.gpg`). Without it an archive made with
`--include-secrets` contains credentials in clear text and the tool says so (WARN). **Keep the passphrase and at least one archive made with `--include-secrets` off the server.**

## Guarantees — and their limits

* **Consistency:** the database copy is a transactionally consistent snapshot. The archive is verified against its own SHA-256 manifest and the database against `integrity_check` *before* anything is restored.
* **RPO** = time since the last archive (≤ 24 h with the timer). Everything created after it (dashboards edited in the UI, new users, annotations) is lost by a restore.
* **RTO** ≈ install time + restore time: minutes on the tested systems (the database is a few MB).
* **Secrets are the weak point.** Datasource passwords inside the database are encrypted with `secret_key`. A restore **refuses** to continue when the archive has no secrets and the `secret-key`
  on the host is not the one the database was encrypted with (it compares SHA-256s) — otherwise Grafana would start with datasources that silently cannot log in.
* **Version rule:** an archive may be restored on the same or a *newer* Grafana (the database is migrated at start); an archive from a *newer* Grafana than the installed one is refused.
* **A restore always saves the current state first** (`pre-restore` archive) so a wrong restore is itself reversible.
* **What is not guaranteed:** the repository's LAB content (UIDs) is restored byte-for-byte only for the *managed* objects; changes made in the UI after the backup are gone; Grafana alerting
  state/silences are in the database and come back as they were at backup time.

## Procedures

### A. Back up
```bash
sudo grafana-platform backup                      # database + config + content export, no secrets
sudo grafana-platform backup --include-secrets    # + secrets and TLS key (set BACKUP_GPG_PASSPHRASE_FILE to encrypt)
# copy it off the server, e.g.:  scp /var/backups/grafana-platform/grafana-platform-*.tar.gz backup-host:/srv/backups/grafana/
```

### B. Restore on the same host (damaged data, wrong change)
```bash
sudo grafana-platform restore /var/backups/grafana-platform/grafana-platform-<stamp>-manual.tar.gz        # asks for confirmation; --yes to skip
```
Steps performed: verify archive → compare versions and `secret_key` → safety backup → stop Grafana → restore database, configuration (and secrets if included) → clear the search index → re-install plugins →
start → wait for health → full `verify`. **Tested:** a dashboard and a datasource were deleted and a junk dashboard created; after the restore the originals were back and the junk dashboard gone (exact results of the final acceptance run: [VALIDATION-RHEL9.md](VALIDATION-RHEL9.md)).

### C. Recover a lost server (bare RHEL 9 host)
1. Prepare the host as for a new install (RHEL repositories, [PRODUCTION-RHEL9.md](PRODUCTION-RHEL9.md) §2) and unpack the release.
2. If the archive was made with `--include-secrets`:
   ```bash
   sudo bin/grafana-platform restore /path/archive.tar.gz --bootstrap     # puts platform.env, secrets, item map, CA and TLS files back (no Grafana needed yet)
   sudo bin/grafana-platform install                                      # uses the restored platform.env and secrets
   sudo grafana-platform restore /path/archive.tar.gz --yes               # database and configuration
   ```
   Otherwise recreate `platform.env`, the secret files (**including the original `secret-key`**) and the certificate yourself, `install`, then `restore`.
3. `sudo grafana-platform verify`.
**Tested:** Grafana, `/etc/grafana`, `/var/lib/grafana`, `/etc/grafana-platform` (env + secrets) and the TLS files were all deleted; the three commands above rebuilt the server; the marker dashboard created before the
disaster was back, both datasources reported healthy (proving the restored `secret_key`) and `verify` passed (exact results: [VALIDATION-RHEL9.md](VALIDATION-RHEL9.md)).

### D. Undo an upgrade
`grafana-platform upgrade` takes a `pre-upgrade` archive and caches the previous RPM; `grafana-platform rollback` (or the automatic rollback when the post-upgrade verification fails) restores both. See [PRODUCTION-RHEL9.md](PRODUCTION-RHEL9.md) §6.

### E. Check an archive without restoring it
```bash
mkdir /tmp/chk && tar -xzf archive.tar.gz -C /tmp/chk && (cd /tmp/chk && sed -n '/^--- sha256$/,$p' manifest.txt | tail -n +2 | sha256sum -c --quiet && echo archive intact)
sqlite3 /tmp/chk/grafana.db 'PRAGMA integrity_check;'
```

## Backup hygiene checklist
* `BACKUP_DIR` on a different volume from `/var/lib/grafana`, and a copy on another host. `verify` warns when the newest backup is older than 3 days.
* Test a restore on a scratch host at least once per quarter (the procedure above is the test).
* Rotate the datasource passwords after restoring a *copy* onto a test system; never point a test Grafana at production datasources.
