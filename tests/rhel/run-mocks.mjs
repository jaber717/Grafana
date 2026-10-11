// Starts the SMTP and Telegram mocks as standalone processes for the RHEL service tests and writes everything they receive to files.
//   node tests/rhel/run-mocks.mjs [--dir /tmp/mock-out] [--smtp 2525] [--telegram 8099] [--token TEST:token-not-real]
// <dir>/mail-N.eml   every accepted message (raw)      <dir>/telegram.jsonl   one JSON line per Bot API call (files summarised, token check result)
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSmtpMock } from '../mocks/smtp-mock.mjs';
import { startTelegramMock } from '../mocks/telegram-mock.mjs';
import net from 'node:net';
import http from 'node:http';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
const dir = opt('dir', '/tmp/mock-out');
mkdirSync(dir, { recursive: true });
const smtp = await startSmtpMock();
const tg = await startTelegramMock({ token: opt('token', 'TEST:token-not-real') });
// the mocks listen on random ports: expose them on fixed loopback ports with tiny TCP proxies, and dump what they recorded every second
const proxy = (listen, target) => net.createServer((c) => { const u = net.connect(target, '127.0.0.1'); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); }).listen(listen, '127.0.0.1');
proxy(Number(opt('smtp', 2525)), smtp.port);
proxy(Number(opt('telegram', 8099)), Number(new URL(tg.apiBase).port));
let nm = 0, nt = 0;
setInterval(() => {
  while (nm < smtp.messages.length) { nm++; writeFileSync(join(dir, `mail-${nm}.eml`), smtp.messages[nm - 1].raw); }
  while (nt < tg.calls.length) { const c = tg.calls[nt++]; appendFileSync(join(dir, 'telegram.jsonl'), JSON.stringify({ method: c.method, tokenOk: c.tokenOk, fields: c.fields, file: c.file ? { name: c.file.filename, bytes: c.file.bytes.length, pdf: c.file.bytes.subarray(0, 5).toString() } : null }) + '\n'); }
}, 500);
console.log(`mocks up: smtp 127.0.0.1:${opt('smtp', 2525)}, telegram 127.0.0.1:${opt('telegram', 8099)}, output ${dir}`);
http.createServer((_, r) => r.end('ok')).listen(0, '127.0.0.1');   // keeps the process alive
