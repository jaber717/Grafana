# Offline (air-gapped) installation

For a RHEL 9 server with **no Internet access**. "Offline" means the *Grafana platform* needs nothing from the Internet; the server must still have the RHEL BaseOS and
AppStream repositories (Satellite, a local mirror, or the RHEL 9 installation ISO mounted as a repository) because the prerequisites (`unzip`, `sqlite`, `xz`,
`python3-dnf-plugin-versionlock`, `policycoreutils-python-utils`) come from them.

## What the bundle contains

One archive: `grafana-platform-<version>-rhel9-offline.tar.gz` (+ `.sha256`), about 320 MB:

| Path | Content | Integrity |
|---|---|---|
| `grafana-platform-<version>/` | the complete release (scripts, dashboards, templates, docs) | `git ls-files` of the tagged commit |
| `bundle/rpm/grafana-13.2.3-1.x86_64.rpm` | the official signed Grafana RPM | SHA-256 pinned in `VERSIONS.env` at build time **and** vendor signature checked again on the server (`rpm -K`, pinned key fingerprint) |
| `bundle/plugins/*.zip` | the two pinned plugin archives | SHA-256 pinned in `plugins/plugins.txt`, checked before extraction |
| `bundle/node/node-v20.20.2-linux-x64.tar.xz` | Node.js for the content tools (used only if the host has none) | SHA-256 pinned in `VERSIONS.env` |
| `bundle/SHA256SUMS`, `bundle/MANIFEST.txt` | checksums of every file / human-readable manifest | `preflight` runs `sha256sum -c` |

## Build it (on any machine with Internet access; no root, no RHEL needed)
```bash
git clone … && cd Grafana && git checkout v1.0.1          # or unpack the release tarball
tools/build-offline-bundle.sh dist                         # needs bash, curl, sha256sum, tar, gzip
sha256sum -c dist/grafana-platform-1.0.1-rhel9-offline.tar.gz.sha256
```
A mismatch against any pinned SHA-256 aborts the build. The published release also attaches the finished archive ([GITHUB-ACCESS.md](GITHUB-ACCESS.md)).

## Install it (on the isolated server)
```bash
# transfer the archive and its .sha256 by approved media, then:
sha256sum -c grafana-platform-1.0.1-rhel9-offline.tar.gz.sha256
tar xzf grafana-platform-1.0.1-rhel9-offline.tar.gz && cd grafana-platform-1.0.1
cp env/production.env.example /root/grafana.env      # set PACKAGE_SOURCE=bundle and BUNDLE_DIR=$PWD/bundle, plus the usual settings
sudo bin/grafana-platform preflight --env-file /root/grafana.env
sudo bin/grafana-platform install   --env-file /root/grafana.env
```
Everything else (secrets, certificate, item map) is exactly as in [PRODUCTION-RHEL9.md](PRODUCTION-RHEL9.md). Upgrades work the same way: bring the next bundle, `sudo bin/grafana-platform upgrade`.
The cached previous RPM for rollbacks lives in `BACKUP_DIR/rpm`.

**Tested** on a RHEL 9.6 virtual machine whose firewall dropped every packet except loopback and replies: preflight (checksums verified), install (RPM signature OK, plugins and Node.js from
the bundle), verification and datasource health against an equally isolated Akvorado server — see [VALIDATION-RHEL9.md](VALIDATION-RHEL9.md).
