// SMTP over TLS: STARTTLS upgrade, implicit TLS, certificate verification and credential handling, against a mock with a throwaway
// self-signed certificate (generated with the openssl CLI; skipped when openssl is not available).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSmtpMock } from '../mocks/smtp-mock.mjs';
import { sendMail } from '../../reports/lib/mail.mjs';

let pki = null;
try {
  const d = mkdtempSync(join(tmpdir(), 'rpt-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', join(d, 'k.pem'), '-out', join(d, 'c.pem')], { stdio: 'ignore' });
  const other = mkdtempSync(join(tmpdir(), 'rpt-tls2-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=other-ca', '-keyout', join(other, 'k.pem'), '-out', join(other, 'c.pem')], { stdio: 'ignore' });
  pki = { key: readFileSync(join(d, 'k.pem')), cert: readFileSync(join(d, 'c.pem')), otherCert: readFileSync(join(other, 'c.pem')), cleanup: () => { rmSync(d, { recursive: true }); rmSync(other, { recursive: true }); } };
} catch { /* no openssl */ }
const opts = { skip: pki ? false : 'openssl not available' };
const msg = { from: 'NOC <noc@example.test>', to: ['a@example.test'], subject: 'TLS test', text: 't', html: '<p>t</p>', attachments: [] };

test('STARTTLS: the connection is upgraded before MAIL, the certificate is verified, and credentials travel only inside TLS', opts, async () => {
  const smtp = await startSmtpMock({ tls: { key: pki.key, cert: pki.cert }, requireAuth: { user: 'u', pass: 'right-password' } });
  const r = await sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', username: 'u', password: 'right-password', tlsOptions: { ca: pki.cert } }, msg);
  assert.deepEqual(r.accepted, ['a@example.test']);
  assert.equal(smtp.state.tlsHandshakes, 1);
  assert.deepEqual(smtp.state.ehloSecure, [false, true], 'EHLO again after the upgrade; the first EHLO was in clear');
  assert.equal(smtp.messages[0].secure, true, 'the message itself was submitted over TLS');
  assert.equal(smtp.state.authAttempts, 1);
  await smtp.close();
});

test('STARTTLS with an untrusted certificate is refused and nothing is sent (no credentials, no message)', opts, async () => {
  const smtp = await startSmtpMock({ tls: { key: pki.key, cert: pki.cert }, requireAuth: { user: 'u', pass: 'p' } });
  await assert.rejects(sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', username: 'u', password: 'p', tlsOptions: { ca: pki.otherCert } }, msg), (e) => /certificate|self.signed|unable to verify/i.test(e.message) || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(smtp.state.authAttempts, 0, 'the password was never sent to an unverified server');
  assert.equal(smtp.messages.length, 0);
  await smtp.close();
});

test('implicit TLS (port 465 style) delivers the message over an encrypted connection', opts, async () => {
  const smtp = await startSmtpMock({ tls: { key: pki.key, cert: pki.cert, implicit: true } });
  const r = await sendMail({ host: '127.0.0.1', port: smtp.port, security: 'tls', tlsOptions: { ca: pki.cert } }, msg);
  assert.deepEqual(r.accepted, ['a@example.test']);
  assert.equal(smtp.messages[0].secure, true);
  await smtp.close();
});

test('a server that does not offer STARTTLS fails the starttls mode instead of silently sending in clear', opts, async () => {
  const smtp = await startSmtpMock({});
  await assert.rejects(sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', tlsOptions: { ca: pki.cert } }, msg), /starttls|500|502|STARTTLS/i);
  assert.equal(smtp.messages.length, 0);
  await smtp.close();
});

test.after?.(() => pki?.cleanup());
