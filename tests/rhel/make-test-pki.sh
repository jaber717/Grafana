#!/usr/bin/env bash
# Creates a throw-away CA and server certificates for ISOLATED acceptance tests.  Nothing here is for production use.
#   make-test-pki.sh <outdir> <name>:<ip> [<name>:<ip> ...]
set -euo pipefail
out=${1:?outdir}; shift
mkdir -p "$out"; cd "$out"; umask 077
[ -f ca.key ] || { openssl genrsa -out ca.key 3072 2>/dev/null; openssl req -x509 -new -key ca.key -sha256 -days 90 -subj "/CN=Acceptance Test CA (NOT FOR PRODUCTION)" -out ca.pem; }
for spec in "$@"; do
  n=${spec%%:*}; ip=${spec##*:}
  [ -f "$n.key" ] && continue
  openssl genrsa -out "$n.key" 3072 2>/dev/null
  openssl req -new -key "$n.key" -subj "/CN=$n" -out "$n.csr"
  printf 'subjectAltName=DNS:%s,IP:%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' "$n" "$ip" > "$n.ext"
  openssl x509 -req -in "$n.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 90 -sha256 -extfile "$n.ext" -out "$n.crt" 2>/dev/null
  rm -f "$n.csr" "$n.ext"
done
chmod 644 ./*.pem ./*.crt 2>/dev/null || true; ls -l
