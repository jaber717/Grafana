#!/usr/bin/env bash
# apply.mjs wrapper: checks Node >= 18 and passes all arguments.
set -euo pipefail
command -v node >/dev/null || { echo "Node.js >= 18 is required (workstation or any host that can reach Grafana)" >&2; exit 1; }
[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 18 ] || { echo "Node.js >= 18 is required" >&2; exit 1; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/apply.mjs" "$@"
