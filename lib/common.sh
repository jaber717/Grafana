# shellcheck shell=bash
# Shared helpers for grafana-platform: paths, logging, PASS/WARN/FAIL accounting, environment loading, small utilities.

ETC=${GP_ETC:-/etc/grafana-platform}
OPT=${GP_OPT:-/opt/grafana-platform}
ENV_INSTALLED="$ETC/platform.env"
RELEASE_JSON="$ETC/release.json"
GRAFANA_ETC=/etc/grafana
GRAFANA_VAR=/var/lib/grafana
LOGDIR=/var/log/grafana-platform

ENV_FILE_ARG=""; OPT_YES=0; OPT_INCLUDE_SECRETS=0; OPT_ARGS=()
PASS_N=0; WARN_N=0; FAIL_N=0

c_ok=""; c_warn=""; c_bad=""; c_off=""
if [ -t 1 ]; then c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_bad=$'\033[31m'; c_off=$'\033[0m'; fi
pass() { printf '%s[PASS]%s %s\n' "$c_ok" "$c_off" "$*"; PASS_N=$((PASS_N+1)); }
warn() { printf '%s[WARN]%s %s\n' "$c_warn" "$c_off" "$*"; WARN_N=$((WARN_N+1)); }
fail() { printf '%s[FAIL]%s %s\n' "$c_bad" "$c_off" "$*"; FAIL_N=$((FAIL_N+1)); }
info() { printf '       %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '%s[FATAL]%s %s\n' "$c_bad" "$c_off" "$*" >&2; exit 1; }
summary() { printf '\n%s: %d PASS, %d WARN, %d FAIL\n' "$1" "$PASS_N" "$WARN_N" "$FAIL_N"; [ "$FAIL_N" -eq 0 ]; }

parse_common_args() {
  OPT_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --env-file) ENV_FILE_ARG=${2:?--env-file needs a path}; shift 2 ;;
      --yes|-y) OPT_YES=1; shift ;;
      --include-secrets) OPT_INCLUDE_SECRETS=1; shift ;;
      *) OPT_ARGS+=("$1"); shift ;;
    esac
  done
}

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

# Parse KEY=VALUE without executing anything. Only the keys this tool knows are exported.
load_env() {
  local f=${ENV_FILE_ARG:-}
  if [ -z "$f" ]; then if [ -f "$ENV_INSTALLED" ]; then f=$ENV_INSTALLED; elif [ -f "$RELEASE_DIR/env/production.env" ]; then f="$RELEASE_DIR/env/production.env"; fi; fi
  [ -n "$f" ] && [ -f "$f" ] || die "no environment file: pass --env-file <file> (template: $RELEASE_DIR/env/production.env.example) or install one at $ENV_INSTALLED"
  ENV_FILE_USED=$f
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in ''|\#*|[[:space:]]*\#*) continue ;; esac
    line=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//')
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "$f: unparsable line: ${line:0:40}"
    k=${BASH_REMATCH[1]}; v=${BASH_REMATCH[2]}
    v=$(printf '%s' "$v" | sed -E 's/^"(.*)"[[:space:]]*(#.*)?$/\1/; t; s/^'"'"'(.*)'"'"'[[:space:]]*(#.*)?$/\1/; t; s/[[:space:]]+#.*$//; s/[[:space:]]+$//')
    printf -v "$k" '%s' "$v"; export "${k?}"
  done < "$f"
  : "${PLATFORM_ENV:=production}" "${GRAFANA_PROTOCOL:=https}" "${GRAFANA_HTTP_PORT:=3000}" "${GRAFANA_ADMIN_USER:=admin}" "${ZABBIX_TLS_SKIP_VERIFY:=false}"
  : "${PACKAGE_SOURCE:=repo}" "${SECRETS_DIR:=$ETC/secrets}" "${BACKUP_DIR:=/var/backups/grafana-platform}" "${BACKUP_KEEP:=8}" "${ALLOW_NOC_WITHOUT_ITEM_MAP:=no}" "${GRAFANA_ALLOW_INSECURE_HTTP:=no}"
  : "${ZABBIX_ITEM_MAP_FILE:=$ETC/zabbix-item-map.json}" "${GRAFANA_FIREWALL_ZONE:=}" "${PLATFORM_ALLOW_EL_CLONE:=no}"
  export PLATFORM_ENV GRAFANA_PROTOCOL GRAFANA_HTTP_PORT GRAFANA_ADMIN_USER ZABBIX_TLS_SKIP_VERIFY PACKAGE_SOURCE SECRETS_DIR BACKUP_DIR BACKUP_KEEP ZABBIX_ITEM_MAP_FILE
}

log_to_file() { # tee everything to a log file for installs/upgrades
  mkdir -p "$LOGDIR"; chmod 750 "$LOGDIR"
  local f="$LOGDIR/$1-$(date +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "$f") 2>&1
  echo "log: $f"
}

installed_version() { rpm -q --qf '%{VERSION}-%{RELEASE}' grafana 2>/dev/null | grep -E '^[0-9]' || true; }
want_version() { echo "${GRAFANA_VERSION_OVERRIDE:-$GRAFANA_VERSION}-$GRAFANA_RPM_RELEASE"; }

base_url() { printf '%s://%s:%s' "$GRAFANA_PROTOCOL" "${GRAFANA_DOMAIN:-localhost}" "$GRAFANA_HTTP_PORT"; }
curl_local() { # curl against the local instance by its public name (TLS verified against the installed certificate)
  local args=(-sS -m 15)
  if [ "$GRAFANA_PROTOCOL" = https ]; then args+=(--resolve "${GRAFANA_DOMAIN}:${GRAFANA_HTTP_PORT}:127.0.0.1"); fi   # verified against the system trust store
  curl "${args[@]}" "$@"
}

wait_health() { # $1 seconds
  local i=0 max=${1:-90}
  while [ "$i" -lt "$max" ]; do
    if curl_local -f "$(base_url)/api/health" 2>/dev/null | grep -q '"database": *"ok"'; then return 0; fi
    sleep 2; i=$((i+2))
  done
  return 1
}

secret() { cat "$SECRETS_DIR/$1" 2>/dev/null | tr -d '\r\n'; }

# Run the Node-based content tools with the right environment (credentials from secret files, never printed).
node_bin() { command -v node || true; }
run_content_tool() { # $1 script name (apply|verify|backup|restore), rest = args
  local tool=$1; shift
  local node; node=$(node_bin); [ -n "$node" ] || die "Node.js >= 18 not found"
  GRAFANA_URL="$(base_url)" GRAFANA_USER="$GRAFANA_ADMIN_USER" GRAFANA_PASSWORD="$(secret admin-password)" \
  GRAFANA_CONNECT_ADDR=127.0.0.1 GRAFANA_CA_FILE=/etc/pki/tls/certs/ca-bundle.crt \
  ZABBIX_GRAFANA_PASSWORD="$(secret zabbix-password)" CLICKHOUSE_RO_PASSWORD="$(secret clickhouse-password)" \
  PLATFORM_ENV_FILE="$ENV_FILE_USED" \
  "$node" "$RELEASE_DIR/scripts/$tool.mjs" "$@"
}

mode_of() { stat -c %a "$1" 2>/dev/null || echo "?"; }
owner_of() { stat -c %U:%G "$1" 2>/dev/null || echo "?"; }
