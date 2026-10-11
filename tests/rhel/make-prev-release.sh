#!/usr/bin/env bash
# Builds a copy of this release pinned to an OLDER Grafana package: it stands in for "the previous release" in the upgrade/rollback acceptance test.
#   make-prev-release.sh <release-dir> <dest-dir> <old-grafana-version>          e.g.  ... ~/gp ~/gp-prev 13.2.2   (the package grafana-13.2.2-1 must be in the repository)
set -euo pipefail
SRC=$(readlink -f "${1:?release dir}"); DST=${2:?dest dir}; OLD=${3:?old version}
rm -rf "$DST"; cp -a "$SRC" "$DST"; cd "$DST"
sed -i "s/^GRAFANA_VERSION=.*/GRAFANA_VERSION=$OLD/; s/^GRAFANA_RPM_NEVRA=.*/GRAFANA_RPM_NEVRA=grafana-$OLD-1.x86_64/" VERSIONS.env
echo "$(cat VERSION)-prev" > VERSION
echo "previous release variant in $DST: Grafana $OLD"
