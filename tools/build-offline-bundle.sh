#!/usr/bin/env bash
# Builds the OFFLINE installation bundle for grafana-platform: the pinned Grafana RPM, the pinned plugin archives and the pinned Node.js tarball,
# next to this release, in ONE archive that can be carried to an isolated RHEL 9 server.
#
#   tools/build-offline-bundle.sh [output-dir]        (needs: bash, curl, sha256sum, tar, gzip; Internet access)
#
# Every download is checked against a SHA-256 that is pinned in this repository (VERSIONS.env, plugins/plugins.txt); a mismatch aborts.
# The RPM keeps its vendor signature, which the installer verifies again with the pinned key (rpm -K) on the target host.
# Result: <output-dir>/grafana-platform-<version>-rhel9-offline.tar.gz  (+ .sha256)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
# shellcheck disable=SC1091
. ./VERSIONS.env
VERSION=$(cat VERSION)
OUT=${1:-$ROOT/dist}
NAME=grafana-platform-$VERSION
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT" "$STAGE/$NAME/bundle/rpm" "$STAGE/$NAME/bundle/plugins" "$STAGE/$NAME/bundle/node"

fetch() { # url dest sha256
  echo "  downloading $(basename "$2")"
  curl -fsSL --retry 3 -o "$2" "$1"
  local got; got=$(sha256sum "$2" | cut -d' ' -f1)
  [ "$got" = "$3" ] || { echo "ERROR: $(basename "$2") has SHA-256 $got, the repository pins $3" >&2; exit 1; }
}

echo "== release tree"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" ls-files -z | grep -zv "^dist/" | tar -C "$ROOT" --null -T - -cf - | tar -xf - -C "$STAGE/$NAME"
else
  tar -C "$ROOT" --exclude=./dist --exclude=./bundle --exclude=.git --exclude=node_modules -cf - . | tar -xf - -C "$STAGE/$NAME"
fi

find "$STAGE/$NAME" -type f \( -path "*/bin/*" -o -name "*.sh" -o -name "render.py" -o -name "*.mjs" -o -name "flowgen.py" -o -name "mock-zabbix.py" \) -exec chmod 0755 {} +   # executable bits (a Windows checkout does not carry them)

echo "== Grafana RPM ($GRAFANA_RPM_NEVRA)"
fetch "$GRAFANA_RPM_REPO_URL/Packages/$GRAFANA_RPM_FILE" "$STAGE/$NAME/bundle/rpm/${GRAFANA_RPM_NEVRA}.rpm" "$GRAFANA_RPM_SHA256"

echo "== plugins"
while read -r id ver sha _; do
  [ -z "$id" ] && continue
  fetch "https://grafana.com/api/plugins/$id/versions/$ver/download?os=linux&arch=amd64" "$STAGE/$NAME/bundle/plugins/$id-$ver.zip" "$sha"
done < <(sed 's/#.*//' plugins/plugins.txt | awk 'NF')

echo "== Node.js $NODE_BUNDLE_VERSION"
fetch "https://nodejs.org/dist/$NODE_BUNDLE_VERSION/$NODE_BUNDLE_FILE" "$STAGE/$NAME/bundle/node/$NODE_BUNDLE_FILE" "$NODE_BUNDLE_SHA256"

echo "== manifest"
( cd "$STAGE/$NAME/bundle"
  { echo "grafana-platform $VERSION offline bundle"; echo "built: $(date -u +%FT%TZ)"; echo "grafana: $GRAFANA_RPM_NEVRA (key $GRAFANA_RPM_GPG_FPR)"; echo "node: $NODE_BUNDLE_VERSION"
    echo "plugins:"; sed 's/#.*//' ../plugins/plugins.txt | awk 'NF {print "  " $1 " " $2}'; } > MANIFEST.txt
  find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS )

echo "== archive"
ARCH="$OUT/$NAME-rhel9-offline.tar.gz"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner --sort=name -czf "$ARCH" "$NAME"
( cd "$OUT" && sha256sum "$(basename "$ARCH")" > "$(basename "$ARCH").sha256" )
echo "built: $ARCH ($(du -h "$ARCH" | cut -f1))"; cat "$ARCH.sha256"
