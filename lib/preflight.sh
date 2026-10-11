# shellcheck shell=bash
# Read-only readiness checks. Sets PLATFORM_STATE to FRESH | MANAGED | CONFLICT. Never changes the system.

check_pkg_installable() { rpm -q "$1" >/dev/null 2>&1 || dnf -q list --available "$1" >/dev/null 2>&1; }

validate_cidrs() {
  python3 - "$@" <<'PY'
import ipaddress, sys
bad = []
for c in sys.argv[1:]:
    try:
        n = ipaddress.ip_network(c, strict=False)
        if n.prefixlen == 0:
            bad.append(c + " (matches everything)")
    except ValueError:
        bad.append(c)
print(" ".join(bad)); sys.exit(1 if bad else 0)
PY
}

run_preflight() {
  local mode=${1:-install}
  step "Operating system and security baseline"
  [ "$(id -u)" -eq 0 ] && pass "running as root" || fail "must run as root"
  local id="" vid=""
  if [ -r /etc/os-release ]; then id=$(. /etc/os-release; echo "${ID:-}"); vid=$(. /etc/os-release; echo "${VERSION_ID:-}"); fi
  if [ "$id" = rhel ] && [[ "$vid" == 9.* ]]; then
    if [ "$vid" = "9.7" ]; then pass "Red Hat Enterprise Linux $vid"; else warn "Red Hat Enterprise Linux $vid (production target is 9.7; 9.x is accepted)"; fi
  elif [[ "$id" =~ ^(almalinux|rocky|centos)$ ]] && [[ "$vid" == 9.* ]] && [ "${PLATFORM_ALLOW_EL_CLONE:-no}" = yes ]; then
    warn "$id $vid is an EL9 rebuild, accepted only because PLATFORM_ALLOW_EL_CLONE=yes (acceptance testing); production must be RHEL"
  else
    fail "unsupported OS '$id $vid' (needs RHEL 9.x; Debian/Ubuntu/other are not supported)"
  fi
  [ "$(uname -m)" = x86_64 ] && pass "architecture x86_64" || fail "architecture $(uname -m) is not supported (x86_64 only)"
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then pass "SELinux is Enforcing"; else fail "SELinux must be Enforcing (found: $(getenforce 2>/dev/null || echo unknown))"; fi
  grep -qiE '^SELINUX=enforcing' /etc/selinux/config 2>/dev/null && pass "SELinux is persistently Enforcing" || fail "/etc/selinux/config does not say SELINUX=enforcing"
  systemctl is-active --quiet firewalld && pass "firewalld is active" || fail "firewalld must be installed and active"
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && pass "system clock is NTP-synchronized" || warn "clock is not NTP-synchronized (certificate validation and Zabbix timestamps depend on it)"

  step "Environment file ($ENV_FILE_USED)"
  [ -n "${GRAFANA_DOMAIN:-}" ] && [ "$GRAFANA_DOMAIN" != "grafana.example.com" ] && pass "GRAFANA_DOMAIN=$GRAFANA_DOMAIN" || fail "GRAFANA_DOMAIN is empty or still the template value"
  [[ "$GRAFANA_HTTP_PORT" =~ ^[0-9]+$ ]] && [ "$GRAFANA_HTTP_PORT" -ge 1024 ] && [ "$GRAFANA_HTTP_PORT" -le 65535 ] && pass "listener port $GRAFANA_HTTP_PORT" || fail "GRAFANA_HTTP_PORT must be 1024-65535 (the Grafana service does not run as root)"
  case "$GRAFANA_PROTOCOL" in
    https) pass "protocol https" ;;
    http) if [ "$GRAFANA_ALLOW_INSECURE_HTTP" = yes ]; then warn "plain HTTP explicitly allowed (GRAFANA_ALLOW_INSECURE_HTTP=yes): credentials and cookies are unencrypted"; else fail "GRAFANA_PROTOCOL=http needs GRAFANA_ALLOW_INSECURE_HTTP=yes"; fi ;;
    *) fail "GRAFANA_PROTOCOL must be https or http" ;;
  esac
  if [ -n "${GRAFANA_ALLOWED_CIDRS:-}" ]; then
    local badc; if badc=$(validate_cidrs $GRAFANA_ALLOWED_CIDRS); then pass "firewall sources: $GRAFANA_ALLOWED_CIDRS"; else fail "GRAFANA_ALLOWED_CIDRS invalid: $badc"; fi
  else fail "GRAFANA_ALLOWED_CIDRS is empty (there is no default: the port is never opened to everyone)"; fi
  case "${ZABBIX_URL:-}" in https://*) pass "Zabbix URL uses https" ;; http://*) [ "${ALLOW_INSECURE_DATASOURCES:-no}" = yes ] && warn "Zabbix over plain http (ALLOW_INSECURE_DATASOURCES=yes)" || fail "ZABBIX_URL is http://; use https or set ALLOW_INSECURE_DATASOURCES=yes" ;; *) fail "ZABBIX_URL is not set" ;; esac
  if [ "$ZABBIX_TLS_SKIP_VERIFY" = true ]; then [ "${ALLOW_INSECURE_DATASOURCES:-no}" = yes ] && warn "Zabbix certificate verification is DISABLED (ALLOW_INSECURE_DATASOURCES=yes)" || fail "ZABBIX_TLS_SKIP_VERIFY=true is refused in production; provide ZABBIX_CA_FILE instead (or ALLOW_INSECURE_DATASOURCES=yes)"; else pass "Zabbix certificate verification enabled"; fi
  if [ "${CLICKHOUSE_SECURE:-false}" = true ]; then pass "ClickHouse connection uses TLS"; else [ "${ALLOW_INSECURE_DATASOURCES:-no}" = yes ] && warn "ClickHouse over plain http (ALLOW_INSECURE_DATASOURCES=yes)" || fail "CLICKHOUSE_SECURE=false: enable TLS on ClickHouse (Akvorado repository) or set ALLOW_INSECURE_DATASOURCES=yes"; fi
  [ -n "${CLICKHOUSE_HOST:-}" ] && [ "${CLICKHOUSE_HOST}" != "netflow.example.com" ] && pass "ClickHouse host $CLICKHOUSE_HOST" || fail "CLICKHOUSE_HOST is empty or still the template value"
  case "$PLATFORM_ENV" in production) pass "PLATFORM_ENV=production" ;; *) warn "PLATFORM_ENV=$PLATFORM_ENV (not production)" ;; esac
  if grep -rqE '192\.168\.1\.(91|195|194)' "$ENV_FILE_USED" 2>/dev/null; then fail "the environment file still contains LAB addresses (192.168.1.x)"; else pass "no LAB addresses in the environment file"; fi

  step "Secrets ($SECRETS_DIR)"
  if [ -d "$SECRETS_DIR" ]; then
    local f m
    for f in zabbix-password clickhouse-password; do
      if [ -s "$SECRETS_DIR/$f" ]; then m=$(mode_of "$SECRETS_DIR/$f"); if [ "$m" = 600 ] || [ "$m" = 400 ]; then pass "secret $f present (mode $m)"; else fail "secret $f has mode $m (must be 600 or 400, owner root)"; fi
      else fail "secret file $SECRETS_DIR/$f missing or empty (create it: see docs/PRODUCTION-RHEL97.md)"; fi
    done
    for f in admin-password secret-key; do [ -s "$SECRETS_DIR/$f" ] && pass "secret $f present" || info "secret $f will be generated by install (never printed)"; done
  else
    fail "secrets directory $SECRETS_DIR does not exist (mkdir -m 0750; create zabbix-password and clickhouse-password, mode 0600)"
  fi

  step "TLS material"
  if [ "$GRAFANA_PROTOCOL" = https ]; then
    local crt=${GRAFANA_TLS_CERT_FILE:-} key=${GRAFANA_TLS_KEY_FILE:-}
    if [ -r "$crt" ] && [ -r "$key" ]; then
      if openssl x509 -in "$crt" -noout 2>/dev/null; then
        pass "certificate parses ($(openssl x509 -in "$crt" -noout -subject -enddate | tr '\n' ' '))"
        openssl x509 -in "$crt" -noout -checkend 0 >/dev/null && pass "certificate is not expired" || fail "certificate is expired"
        openssl x509 -in "$crt" -noout -checkend $((30*86400)) >/dev/null || warn "certificate expires within 30 days"
        if [ "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null | sha256sum | cut -d' ' -f1)" = "$(openssl pkey -in "$key" -pubout 2>/dev/null | sha256sum | cut -d' ' -f1)" ]; then pass "private key matches the certificate"; else fail "private key does not match the certificate"; fi
        if openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -qiE "DNS:${GRAFANA_DOMAIN//./\\.}(,|$| )|DNS:\\*\\.${GRAFANA_DOMAIN#*.}"; then pass "certificate covers $GRAFANA_DOMAIN"; else fail "certificate subjectAltName does not cover $GRAFANA_DOMAIN"; fi
        local cab; cab=$(mktemp); cat /etc/pki/tls/certs/ca-bundle.crt ${GRAFANA_TLS_CA_FILE:+"$GRAFANA_TLS_CA_FILE"} > "$cab" 2>/dev/null || true
        if openssl verify -CAfile "$cab" -untrusted "$crt" "$crt" >/dev/null 2>&1; then pass "certificate chain validates against the system trust store${GRAFANA_TLS_CA_FILE:+ + GRAFANA_TLS_CA_FILE}"; else fail "certificate does not validate (add its CA as GRAFANA_TLS_CA_FILE, include intermediates in the certificate file)"; fi
        rm -f "$cab"
      else fail "GRAFANA_TLS_CERT_FILE is not a PEM certificate"; fi
    else fail "GRAFANA_TLS_CERT_FILE / GRAFANA_TLS_KEY_FILE not readable"; fi
  else info "TLS checks skipped (http)"; fi
  local f; for f in "${ZABBIX_CA_FILE:-}" "${CLICKHOUSE_CA_FILE:-}" "${GRAFANA_TLS_CA_FILE:-}"; do
    [ -z "$f" ] && continue; openssl x509 -in "$f" -noout 2>/dev/null && pass "CA file $f parses" || fail "CA file $f is not a PEM certificate"
  done

  step "Packages and tooling"
  if [ "$PACKAGE_SOURCE" = repo ]; then
    curl -sSI -m 15 "$GRAFANA_RPM_REPO_URL/repodata/repomd.xml" >/dev/null 2>&1 && pass "Grafana RPM repository reachable" || fail "cannot reach $GRAFANA_RPM_REPO_URL (use PACKAGE_SOURCE=bundle for an isolated server)"
    curl -sSI -m 15 "https://grafana.com/api/plugins/alexanderzobnin-zabbix-app" >/dev/null 2>&1 && pass "grafana.com plugin API reachable" || fail "cannot reach grafana.com (plugin downloads)"
  else
    if [ -f "$BUNDLE_DIR/MANIFEST.sha256" ]; then (cd "$BUNDLE_DIR" && sha256sum -c --quiet MANIFEST.sha256 >/dev/null 2>&1) && pass "offline bundle checksums verify ($BUNDLE_DIR)" || fail "offline bundle fails its SHA-256 manifest"; else fail "offline bundle not found: $BUNDLE_DIR/MANIFEST.sha256"; fi
  fi
  [ "$(dnf -q repolist 2>/dev/null | wc -l)" -gt 0 ] && pass "dnf has enabled repositories" || fail "dnf has no enabled repositories (RHEL BaseOS/AppStream are required for prerequisites)"
  local p; for p in curl tar unzip openssl sqlite policycoreutils-python-utils python3 python3-dnf-plugin-versionlock; do
    if rpm -q "$p" >/dev/null 2>&1; then pass "prerequisite $p installed"; elif check_pkg_installable "$p"; then info "prerequisite $p will be installed from your repositories"; else fail "prerequisite $p is neither installed nor available from the enabled repositories"; fi
  done
  if [ -n "$(node_bin)" ] && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then pass "Node.js $(node -v) available"; elif [ "$PACKAGE_SOURCE" = bundle ] && [ -x "$BUNDLE_DIR/node/bin/node" ]; then pass "Node.js from the offline bundle"; elif check_pkg_installable nodejs; then info "Node.js will be installed from your repositories (AppStream nodejs)"; else fail "Node.js >= 18 is required (AppStream nodejs or the offline bundle)"; fi

  step "NOC dashboards: Zabbix item map"
  if [ -f "$ZABBIX_ITEM_MAP_FILE" ]; then
    if python3 -c "import json,sys; m=json.load(open(sys.argv[1])); assert isinstance(m,dict) and all(k.isdigit() and str(v).isdigit() for k,v in m.items())" "$ZABBIX_ITEM_MAP_FILE" 2>/dev/null; then
      local need missing; read -r need missing < <(python3 - "$RELEASE_DIR" "$ZABBIX_ITEM_MAP_FILE" <<'PY'
import json, glob, re, sys
ids = set()
for f in glob.glob(sys.argv[1] + "/dashboards/noc/*.json"):
    for s in re.findall(r'"itemids":\s*"([0-9,\s]+)"', open(f).read()):
        ids.update(i.strip() for i in s.split(',') if i.strip())
m = json.load(open(sys.argv[2]))
print(len(ids), len([i for i in ids if i not in m]))
PY
)
      [ "$missing" = 0 ] && pass "item map covers all $need Zabbix items used by the NOC dashboards" || fail "item map misses $missing of $need Zabbix item ids (tools/zabbix-item-map.mjs lists them)"
    else fail "$ZABBIX_ITEM_MAP_FILE is not a valid item map"; fi
  elif [ "$ALLOW_NOC_WITHOUT_ITEM_MAP" = yes ]; then warn "no item map: only the 5 NetFlow dashboards will be deployed (ALLOW_NOC_WITHOUT_ITEM_MAP=yes)"
  else fail "no Zabbix item map at $ZABBIX_ITEM_MAP_FILE (the NOC dashboards address Zabbix items by id; see docs/ZABBIX-ITEM-MAP.md), or set ALLOW_NOC_WITHOUT_ITEM_MAP=yes"; fi

  step "Storage and ports"
  mkdir -p "$GRAFANA_VAR" 2>/dev/null || true
  local avail; avail=$(df -Pk "$(dirname "$GRAFANA_VAR")" | awk 'NR==2{print int($4/1024)}')
  [ "${avail:-0}" -ge 2048 ] && pass "free space for Grafana data: ${avail} MiB" || fail "less than 2 GiB free for /var/lib/grafana (${avail} MiB)"
  [ "$(df -P "$GRAFANA_VAR" | awk 'NR==2{print $1}')" != "$(df -P / | awk 'NR==2{print $1}')" ] && pass "/var/lib/grafana is on its own filesystem" || warn "/var/lib/grafana shares the root filesystem (a separate LV is recommended for the database)"
  local owner; owner=$(ss -ltnpH "sport = :$GRAFANA_HTTP_PORT" 2>/dev/null | head -1)
  if [ -z "$owner" ]; then pass "port $GRAFANA_HTTP_PORT is free"; elif echo "$owner" | grep -q grafana; then pass "port $GRAFANA_HTTP_PORT is used by grafana (managed)"; else fail "port $GRAFANA_HTTP_PORT is in use by another process"; fi

  step "Existing installation"
  if rpm -q grafana >/dev/null 2>&1 && [ ! -f "$RELEASE_JSON" ] && [ -f "$ETC/.install-started" ]; then PLATFORM_STATE=MANAGED; warn "an earlier install did not finish (marker $ETC/.install-started): it will be resumed"
  elif rpm -q grafana >/dev/null 2>&1 && [ ! -f "$RELEASE_JSON" ]; then PLATFORM_STATE=CONFLICT; fail "Grafana is already installed and was not installed by grafana-platform (no $RELEASE_JSON): refusing to touch it"
  elif [ -f "$RELEASE_JSON" ]; then PLATFORM_STATE=MANAGED; pass "managed installation detected ($(python3 -c 'import json;d=json.load(open("'"$RELEASE_JSON"'"));print("platform",d.get("platform_version"),"grafana",d.get("grafana_version"))'))"
  else PLATFORM_STATE=FRESH; pass "fresh host (no Grafana installed)"; fi
  [ "$mode" = "read-only" ] && summary "PREFLIGHT"
  [ "$mode" = "read-only" ] && return $? || true
}
