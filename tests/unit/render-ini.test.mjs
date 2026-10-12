// grafana.ini rendering: the optional [rendering] block is absent by default, present and secret-free when configured, and refuses a
// half-configuration. render_grafana_ini() is extracted from lib/install.sh and run in isolation (bash required; skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fwd = (p) => p.split('\\').join('/');                 // bash on Windows (Git Bash) wants forward slashes
const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
const opts = { skip: bash.status === 0 ? false : 'bash not available' };
const ROOT = fwd(fileURLToPath(new URL('../../', import.meta.url)));

function render(env) {
  const d = mkdtempSync(join(tmpdir(), 'rpt-ini-'));
  writeFileSync(join(d, 'grafana.ini'), '# packaged\n');
  const script = `
set -euo pipefail
die() { echo "DIE: $*" >&2; exit 1; }
pass() { :; }
install() { cp "\${@: -2:1}" "\${@: -1}"; }
restorecon() { :; }
export GRAFANA_ETC='${fwd(d)}' GRAFANA_VAR=/var/lib/grafana GRAFANA_PROTOCOL=http GRAFANA_HTTP_PORT=3000 RELEASE_DIR='${ROOT}'
export GRAFANA_DOMAIN=grafana.example.test GRAFANA_ROOT_URL=http://grafana.example.test GRAFANA_ADMIN_USER=admin SECRETS_DIR=/etc/grafana-platform/secrets
eval "$(sed -n '/^render_grafana_ini()/,/^}/p' '${ROOT}lib/install.sh')"
CONFIG_CHANGED=0
render_grafana_ini
cat "$GRAFANA_ETC/grafana.ini"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  rmSync(d, { recursive: true, force: true });
  return r;
}

test('grafana.ini: no [rendering] section unless an external renderer is configured', opts, () => {
  const r = render({ RENDERING_SERVER_URL: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('[rendering]'));
});

test('grafana.ini: the renderer is configured with the token read from a FILE, never written into the ini', opts, () => {
  const d = mkdtempSync(join(tmpdir(), 'rpt-tok-'));
  const tok = fwd(join(d, 'renderer.token'));
  writeFileSync(tok, 'shared-secret-value-123456789');
  const r = render({ RENDERING_SERVER_URL: 'http://renderer.example.test:8081/render', RENDERING_CALLBACK_URL: 'https://grafana.example.test/', RENDERING_TOKEN_FILE: tok });
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[rendering]\nserver_url = http://renderer.example.test:8081/render\ncallback_url = https://grafana.example.test/\nrenderer_token = $__file{'), r.stdout.slice(-400));
  assert.ok(r.stdout.includes('renderer.token}'));
  assert.ok(!r.stdout.includes('shared-secret-value'), 'the secret itself is never in grafana.ini');
});

test('grafana.ini: a half configuration is refused', opts, () => {
  assert.notEqual(render({ RENDERING_SERVER_URL: 'http://r:8081/render' }).status, 0);
  const r = render({ RENDERING_SERVER_URL: 'http://r:8081/render', RENDERING_CALLBACK_URL: 'https://g/', RENDERING_TOKEN_FILE: '/nonexistent/token' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RENDERING_TOKEN_FILE does not exist/);
});
