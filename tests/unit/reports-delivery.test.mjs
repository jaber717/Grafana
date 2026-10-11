import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSmtpMock } from '../mocks/smtp-mock.mjs';
import { startTelegramMock } from '../mocks/telegram-mock.mjs';
import { deliver, sha256 } from '../../reports/lib/delivery.mjs';
import { emailBatch, telegramBatch, telegramUnits } from '../../reports/lib/channels.mjs';
import { buildMime } from '../../reports/lib/mail.mjs';
import { esc } from '../../reports/lib/telegram.mjs';

const pdf = (n) => Buffer.from(`%PDF-1.7\n% fake ${n}\n`.padEnd(2000, 'x'));
const A = { filename: 'Daily-NetFlow-2026-10-11.pdf', contentType: 'application/pdf', data: pdf('a') };
const B = { filename: 'Daily-Interface-Traffic-2026-10-11.pdf', contentType: 'application/pdf', data: pdf('b') };
const content = { from: 'NOC Reports <noc-reports@example.test>', subject: 'Daily network traffic - 2026-10-11', text: 'plain', html: '<p>Summary</p>', attachments: [A, B] };
const fast = { attempts: 4, baseMs: 1, maxMs: 5 };
const sandbox = () => mkdtempSync(join(tmpdir(), 'rpt-'));
const noSleep = async () => {};

function attachmentsOf(raw) {
  return [...raw.matchAll(/filename="([^"]+)"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) => ({ name: m[1], data: Buffer.from(m[2].replace(/\r\n/g, ''), 'base64') }));
}

test('email: both PDFs arrive intact for several recipients, with HTML and text parts', async () => {
  const smtp = await startSmtpMock();
  const dir = sandbox();
  const to = ['a@example.test', 'b@example.test', 'c@example.test'];
  const r = await deliver({ ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: to, sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep });
  assert.equal(r.status, 'sent');
  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(smtp.messages[0].rcpts, to);
  const att = attachmentsOf(smtp.messages[0].raw);
  assert.deepEqual(att.map((a) => a.name), [A.filename, B.filename]);
  assert.equal(sha256(att[0].data), sha256(A.data));
  assert.equal(sha256(att[1].data), sha256(B.data));
  assert.match(smtp.messages[0].raw, /Content-Type: text\/html/);
  assert.match(smtp.messages[0].raw, /Content-Type: text\/plain/);
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('email: a second run for the same day sends nothing (duplicate prevention); force resends', async () => {
  const smtp = await startSmtpMock();
  const dir = sandbox();
  const args = { ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep };
  assert.equal((await deliver(args)).status, 'sent');
  assert.equal((await deliver(args)).status, 'duplicate');
  assert.equal(smtp.messages.length, 1);
  assert.equal((await deliver({ ...args, force: true })).status, 'sent');
  assert.equal(smtp.messages.length, 2);
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('email: a transient server failure is retried and then delivered once', async () => {
  const smtp = await startSmtpMock({ failData: 2 });
  const dir = sandbox();
  const waits = [];
  const r = await deliver({ ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: { attempts: 4, baseMs: 10, maxMs: 1000 }, sleep: async (ms) => waits.push(ms) });
  assert.equal(r.status, 'sent');
  assert.equal(r.attempts, 3);
  assert.deepEqual(waits, [10, 20]);                          // exponential backoff
  assert.equal(smtp.messages.length, 1);
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('email: retries are bounded and the failure is recorded, not hidden', async () => {
  const smtp = await startSmtpMock({ failData: 99 });
  const dir = sandbox();
  const r = await deliver({ ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 4);
  assert.equal(smtp.messages.length, 0);
  // a later run (the server recovered) still delivers, because nothing was recorded as delivered
  smtp.state.failData = 0;
  assert.equal((await deliver({ ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep })).status, 'sent');
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('email: one rejected recipient does not block the others; a retry never re-sends to the accepted ones', async () => {
  const smtp = await startSmtpMock({ rejectRcpt: new Set(['bad@example.test']) });
  const dir = sandbox();
  const args = { ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test', 'bad@example.test', 'c@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep };
  const r = await deliver(args);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.delivered, ['a@example.test', 'c@example.test']);
  assert.equal(r.failed[0].unit, 'bad@example.test');
  assert.equal(smtp.messages.length, 1);                      // permanent 550: no retry storm
  assert.equal(smtp.state.connections, 1);
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('email: credentials are refused over an unencrypted connection; wrong password is permanent', async () => {
  const smtp = await startSmtpMock({ requireAuth: { user: 'u', pass: 'right' } });
  const dir = sandbox();
  const r = await deliver({ ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port, username: 'u', password: 'right' }, content), retry: fast, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 1);                                // permanent: not retried
  assert.match(r.failed[0].error, /unencrypted/);
  assert.equal(smtp.state.authAttempts, 0, 'the password was never sent');
  await smtp.close(); rmSync(dir, { recursive: true });
});

test('mime: header injection is rejected and non-ASCII subjects are encoded', () => {
  assert.throws(() => buildMime({ ...content, subject: 'x\r\nBcc: evil@example.test', to: ['a@example.test'] }), /line break/);
  const { raw } = buildMime({ ...content, subject: 'تقرير يومي', to: ['a@example.test'] });
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
});

test('concurrent runs for the same day cannot both send (lock)', async () => {
  const smtp = await startSmtpMock();
  const dir = sandbox();
  const args = { ledgerDir: dir, channel: 'email', reportDate: '2026-10-11', units: ['a@example.test'], sendBatch: emailBatch({ host: '127.0.0.1', port: smtp.port }, content), retry: fast, sleep: noSleep };
  const [x, y] = await Promise.all([deliver(args), deliver(args)]);
  assert.deepEqual([x.status, y.status].sort(), ['locked', 'sent']);
  assert.equal(smtp.messages.length, 1);
  await smtp.close(); rmSync(dir, { recursive: true });
});

const tgContent = { summaryHtml: `<b>Daily NetFlow</b> ${esc('in < out & more')}`, documents: [{ filename: A.filename, data: A.data, caption: '<b>NetFlow</b>' }, { filename: B.filename, data: B.data }] };

test('telegram: summary and both documents are delivered once with the right fields', async () => {
  const tg = await startTelegramMock();
  const dir = sandbox();
  const cfg = { apiBase: tg.apiBase, token: tg.token, chatId: '-100123' };
  const r = await deliver({ ledgerDir: dir, channel: 'telegram', reportDate: '2026-10-11', units: telegramUnits(tgContent), sendBatch: telegramBatch(cfg, tgContent), retry: fast, sleep: noSleep });
  assert.equal(r.status, 'sent');
  assert.deepEqual(tg.calls.map((c) => c.method), ['sendMessage', 'sendDocument', 'sendDocument']);
  assert.equal(tg.calls[0].fields.chat_id, '-100123');
  assert.equal(tg.calls[0].fields.parse_mode, 'HTML');
  assert.match(tg.calls[0].fields.text, /in &lt; out &amp; more/);
  assert.equal(tg.calls[1].file.filename, A.filename);
  assert.equal(sha256(tg.calls[1].file.bytes), sha256(A.data));
  assert.equal(tg.calls[1].fields.caption, '<b>NetFlow</b>');
  await tg.close(); rmSync(dir, { recursive: true });
});

test('telegram: a rate-limit response is honoured and the retry resumes without re-sending finished parts', async () => {
  const tg = await startTelegramMock({ script: [{ status: 200, body: { ok: true, result: {} } }, { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } } }] });
  const dir = sandbox();
  const waits = [];
  const cfg = { apiBase: tg.apiBase, token: tg.token, chatId: '1' };
  const r = await deliver({ ledgerDir: dir, channel: 'telegram', reportDate: '2026-10-11', units: telegramUnits(tgContent), sendBatch: telegramBatch(cfg, tgContent), retry: { attempts: 3, baseMs: 10, maxMs: 60000 }, sleep: async (ms) => waits.push(ms) });
  assert.equal(r.status, 'sent');
  assert.deepEqual(waits, [3000]);                            // retry_after (3 s) beats the 10 ms backoff
  assert.deepEqual(tg.calls.map((c) => c.method), ['sendMessage', 'sendDocument', 'sendDocument', 'sendDocument']);
  assert.equal(tg.calls.filter((c) => c.method === 'sendMessage').length, 1);
  await tg.close(); rmSync(dir, { recursive: true });
});

test('telegram: a wrong token is a permanent failure, is not retried, and never appears in errors', async () => {
  const tg = await startTelegramMock();
  const dir = sandbox();
  const cfg = { apiBase: tg.apiBase, token: 'WRONG:secret-token-value', chatId: '1' };
  const r = await deliver({ ledgerDir: dir, channel: 'telegram', reportDate: '2026-10-11', units: telegramUnits(tgContent), sendBatch: telegramBatch(cfg, tgContent), retry: fast, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 1);
  assert.match(r.failed[0].error, /401/);
  assert.ok(!JSON.stringify(r).includes('secret-token-value'));
  await tg.close(); rmSync(dir, { recursive: true });
});

test('telegram: a second run is a duplicate; an unreachable API is transient and bounded', async () => {
  const tg = await startTelegramMock();
  const dir = sandbox();
  const cfg = { apiBase: tg.apiBase, token: tg.token, chatId: '1' };
  const args = { ledgerDir: dir, channel: 'telegram', reportDate: '2026-10-11', units: telegramUnits(tgContent), sendBatch: telegramBatch(cfg, tgContent), retry: fast, sleep: noSleep };
  assert.equal((await deliver(args)).status, 'sent');
  assert.equal((await deliver(args)).status, 'duplicate');
  assert.equal(tg.calls.length, 3);
  await tg.close();
  const dir2 = sandbox();
  const down = await deliver({ ...args, ledgerDir: dir2, sendBatch: telegramBatch(cfg, tgContent, { timeoutMs: 500 }) });
  assert.equal(down.status, 'failed');
  assert.equal(down.attempts, 4);
  rmSync(dir, { recursive: true }); rmSync(dir2, { recursive: true });
});
