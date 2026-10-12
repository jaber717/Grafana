import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, validateSettings } from '../../reports/lib/settings.mjs';

function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'rpt-set-'));
  const f = (name, v = 'secret-value\n') => { const p = join(d, name); writeFileSync(p, v); chmodSync(p, 0o600); return p; };
  return { d, f, done: () => rmSync(d, { recursive: true }) };
}
const base = (f, extra = {}) => ({ GRAFANA_URL: 'https://grafana.example.test/', GRAFANA_TOKEN_FILE: f('gf.token'), INTERFACES_FILE: '/etc/x/interfaces.yaml', CHROMIUM_CMD: '/usr/bin/chromium', ...extra });

test('env parser: comments, quotes and inline comments', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="x y"  \nC=z # tail\n\nD='), { A: '1', B: 'x y', C: 'z', D: '' });
  assert.throws(() => parseEnv('not a setting'), /expected KEY=VALUE/);
});

test('settings: minimal valid configuration, channels OFF by default, secrets read from files', () => {
  const s = sandbox();
  const r = validateSettings(base(s.f));
  assert.deepEqual(r.problems, []);
  assert.equal(r.settings.email.enabled, false);
  assert.equal(r.settings.telegram.enabled, false);
  assert.equal(r.settings.grafana.token, 'secret-value');
  assert.equal(r.settings.grafana.url, 'https://grafana.example.test');
  assert.deepEqual(r.settings.kinds, ['netflow', 'interface', 'health']);
  assert.equal(r.settings.retry.attempts, 4);
  s.done();
});

test('settings: an enabled email channel needs host, sender and valid unique recipients', () => {
  const s = sandbox();
  const r = validateSettings(base(s.f, { EMAIL_ENABLED: 'true', EMAIL_TO: 'a@example.test, bad-address, A@example.test' }));
  assert.ok(r.problems.some((p) => /SMTP_HOST is required/.test(p)));
  assert.ok(r.problems.some((p) => /EMAIL_FROM/.test(p)));
  assert.ok(r.problems.some((p) => /'bad-address'/.test(p)));
  assert.ok(r.problems.some((p) => /same recipient twice/.test(p)));
  const ok = validateSettings(base(s.f, { EMAIL_ENABLED: 'true', SMTP_HOST: 'smtp.test', EMAIL_FROM: 'NOC <noc@example.test>', EMAIL_TO: 'a@example.test,b@example.test' }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.settings.email.to, ['a@example.test', 'b@example.test']);
  s.done();
});

test('settings: SMTP credentials require an encrypted connection and a password file', () => {
  const s = sandbox();
  const r = validateSettings(base(s.f, { EMAIL_ENABLED: 'true', SMTP_HOST: 'smtp.test', EMAIL_FROM: 'noc@example.test', EMAIL_TO: 'a@example.test', SMTP_USER: 'u' }));
  assert.ok(r.problems.some((p) => /SMTP_PASSWORD_FILE is required/.test(p)));
  assert.ok(r.problems.some((p) => /never sent unencrypted/.test(p)));
  const ok = validateSettings(base(s.f, { EMAIL_ENABLED: 'true', SMTP_HOST: 'smtp.test', EMAIL_FROM: 'noc@example.test', EMAIL_TO: 'a@example.test', SMTP_USER: 'u', SMTP_SECURITY: 'starttls', SMTP_PASSWORD_FILE: s.f('smtp.pw', 'pw\n') }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.settings.email.smtp.password, 'pw');
  s.done();
});

test('settings: telegram needs a token file and chat id; missing or empty files are reported, not ignored', () => {
  const s = sandbox();
  const r = validateSettings(base(s.f, { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN_FILE: join(s.d, 'missing') }));
  assert.ok(r.problems.some((p) => /does not exist/.test(p)));
  assert.ok(r.problems.some((p) => /TELEGRAM_CHAT_ID/.test(p)));
  const empty = validateSettings(base(s.f, { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN_FILE: s.f('empty', '\n'), TELEGRAM_CHAT_ID: '1' }));
  assert.ok(empty.problems.some((p) => /is empty/.test(p)));
  s.done();
});

test('settings: unknown keys are warned, bad values are rejected', () => {
  const s = sandbox();
  const r = validateSettings(base(s.f, { SMTP_PASWORD: 'oops', RETRY_ATTEMPTS: '99', REPORT_KINDS: 'netflow,traffic', GRAFANA_URL: 'ftp://x' }));
  assert.ok(r.warnings.some((w) => /SMTP_PASWORD/.test(w)));
  assert.ok(r.problems.some((p) => /RETRY_ATTEMPTS/.test(p)));
  assert.ok(r.problems.some((p) => /unknown report 'traffic'/.test(p)));
  assert.ok(r.problems.some((p) => /GRAFANA_URL must start/.test(p)));
  s.done();
});
