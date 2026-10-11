# Security policy

* **No secrets in this repository.** Datasource passwords, tokens and admin logins are read from the environment only (`.env.example` lists the names; `.env` is git-ignored). Grafana never returns datasource secrets, so exports contain none. `scripts/release-gate.sh` blocks credential-like literals, private keys, databases, archives and backups from being tracked.
* The deployment's access policy is **preserved, not changed**: no anonymous access, sign-up off, brute-force protection on, viewer account for the wallboard. Weak points that exist today are recorded, not silently fixed: plain HTTP + `cookie_secure=false` (G1), `tlsSkipVerify: true` on the Zabbix datasource (G2), a possible bootstrap password in a systemd drop-in (G4).
* Datasource accounts are read-only by design: Zabbix `grafana-ro`, ClickHouse `grafana_ro` (readonly, resource-limited, admitted only from the Grafana host).
* Backups: `scripts/backup.sh` output holds no secrets; `lab/scripts/backup-lxc.sh` archives hold the Grafana database (encrypted datasource secrets, API keys) and `/etc/default/grafana-server` — keep them 0600 and off-host.
* Test instances must never use production endpoints: `lab/tests/clean-room-local.sh` and `apply.mjs` sandbox mode enforce loopback-only targets and dead datasource endpoints.
* If a credential is exposed: rotate it at its source (Grafana admin, Zabbix `grafana-ro`, ClickHouse `grafana_ro` on netflow-01), then `scripts/apply.sh --datasource-only --rotate-secrets`. This repository never contained one.

## Production (RHEL 9.7, release 1.0.1)
The production platform has its own, stricter model — signed and pinned packages, TLS, SELinux/firewalld checks, secrets in root-only files, source-restricted listener, encrypted-at-rest options for backups — and states its limits openly:
see [docs/SECURITY-PRODUCTION.md](docs/SECURITY-PRODUCTION.md). The LAB statements above describe release 1.0.0 (grafana-01) and are unchanged. Report a suspected leak by rotating the credential at its source first
(`grafana-platform rotate-secrets` pushes new datasource passwords); never rewrite Git history without a reviewed plan.
