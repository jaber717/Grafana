# shellcheck shell=bash
# Helpers shared by the acceptance drivers (run from a workstation with ssh access to ISOLATED test machines).
#   SSH_KEY=~/.ssh/key SSH_USER=qual     ssh identity / unprivileged user (needs passwordless sudo on the targets)
# Each check prints one line:  [PASS] / [FAIL] / [INFO]  and is counted; the driver exits non-zero if any check failed.

SSH_USER=${SSH_USER:-qual}; SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
ACC_PASS=0; ACC_FAIL=0; ACC_LOG=${ACC_LOG:-/dev/null}
_ssh() { local h=$1; shift; ssh -n -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$SSH_USER@$h" "$@" 2>&1 | grep -av -e '^\*\* ' -e 'post-quantum' -e 'store now' -e 'openssh.com/pq' || true; }
_scp_to() { scp -q -i "$SSH_KEY" -o BatchMode=yes "$1" "$SSH_USER@$2:$3" 2>&1 | grep -av -e '^\*\*' || true; }
section() { printf '\n##### %s\n' "$*" | tee -a "$ACC_LOG"; }
ok()   { ACC_PASS=$((ACC_PASS+1)); printf '[PASS] %s\n' "$*" | tee -a "$ACC_LOG"; }
bad()  { ACC_FAIL=$((ACC_FAIL+1)); printf '[FAIL] %s\n' "$*" | tee -a "$ACC_LOG"; }
note() { printf '[INFO] %s\n' "$*" | tee -a "$ACC_LOG"; }
check() { # check "description" <exit status of the condition>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}
ERRPAT='No such file|FATAL|command not found|Connection (timed out|reset|refused)|^ssh: |Permission denied'
expect_eq() { if grep -qaE "$ERRPAT" <<<"$2"; then bad "$1: the command itself failed: ${2:0:140}"; elif [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', expected '$3'"; fi; }
expect_ge() { if [ "${2:-0}" -ge "$3" ] 2>/dev/null; then ok "$1 ($2 >= $3)"; else bad "$1: got '$2', expected >= $3"; fi; }
expect_match() { if grep -qaE -- "$3" <<<"$2"; then ok "$1"; else bad "$1: '${2:0:120}' does not match /$3/"; fi; }
acc_summary() { printf '\nACCEPTANCE: %d PASS, %d FAIL\n' "$ACC_PASS" "$ACC_FAIL" | tee -a "$ACC_LOG"; [ "$ACC_FAIL" -eq 0 ]; }
