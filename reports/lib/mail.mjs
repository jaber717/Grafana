// Dependency-free SMTP client + MIME builder for the daily reports.
// Security modes: 'none' (plain, for relays on a trusted network and for the test server), 'starttls', 'tls' (implicit TLS).
// Authentication (PLAIN) only when a username is configured; the password comes from a file, never from the command line.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

export class SmtpError extends Error {
  constructor(message, { code = null, transient = true, stage = null } = {}) { super(message); this.name = 'SmtpError'; this.code = code; this.transient = transient; this.stage = stage; }
}

const CRLF = '\r\n';
const b64 = (buf, wrap = 76) => Buffer.from(buf).toString('base64').replace(new RegExp(`(.{${wrap}})`, 'g'), `$1${CRLF}`).replace(/\r\n$/, '');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const addrOnly = (a) => (a.match(/<([^>]+)>/) || [null, a])[1].trim();
const noCrlf = (s) => { if (/[\r\n]/.test(s)) throw new Error('header value contains a line break'); return s; };

// message: {from, to[], subject, text, html, attachments:[{filename, contentType, data:Buffer}], messageId?, date?}
export function buildMime(m) {
  const id = m.messageId || `<${randomBytes(12).toString('hex')}@grafana-report>`;
  const mixed = `=_mixed_${randomBytes(8).toString('hex')}`;
  const alt = `=_alt_${randomBytes(8).toString('hex')}`;
  const head = [
    `From: ${noCrlf(m.from)}`,
    `To: ${m.to.map(noCrlf).join(', ')}`,
    `Subject: ${encWord(noCrlf(m.subject))}`,
    `Date: ${(m.date ? new Date(m.date) : new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const body = [];
  body.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '');
  body.push(`--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(m.text || ''));
  body.push(`--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(m.html || ''), `--${alt}--`);
  for (const a of m.attachments || []) {
    const fn = noCrlf(a.filename).replace(/"/g, '');
    body.push(`--${mixed}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fn}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fn}"`, '', b64(a.data));
  }
  body.push(`--${mixed}--`, '');
  return { raw: head.join(CRLF) + CRLF + CRLF + body.join(CRLF), messageId: id };
}

function dotStuff(s) { return s.replace(/^\./gm, '..'); }

class Conn {
  constructor(sock) { this.sock = sock; this.buf = ''; this.waiters = []; this.err = null; this.attach(sock); }
  attach(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d) => { this.buf += d; this.pump(); });
    sock.on('error', (e) => { this.err = e; this.flush(); });
    sock.on('close', () => { this.err = this.err || new Error('connection closed by server'); this.flush(); });
  }
  flush() { for (const w of this.waiters.splice(0)) w.reject(this.err); }
  pump() {
    for (;;) {
      if (!this.waiters.length) return;
      const lines = this.buf.split(CRLF);
      // a reply is complete when a line looks like "250 text" (code + space)
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const reply = lines.slice(0, end + 1);
      this.buf = lines.slice(end + 1).join(CRLF);
      this.waiters.shift().resolve({ code: Number(reply[end].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
    }
  }
  read(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.err) return reject(this.err);
      const w = { resolve, reject };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('SMTP timeout')); }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      this.waiters.push(w);
      this.pump();
    });
  }
  write(s) { this.sock.write(s); }
}

function open({ host, port, security, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(new SmtpError(`cannot connect to ${host}:${port}: ${e.message}`, { transient: true, stage: 'connect' }));
    const sock = security === 'tls' ? tls.connect({ host, port, servername: host, ...tlsOptions }, () => resolve(sock)) : net.connect({ host, port }, () => resolve(sock));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('connect timeout')));
    sock.once('error', onErr);
  });
}

// Sends one message. Returns {accepted:[], rejected:[{address, code, text}], messageId, response}.
// Per-recipient rejections do not abort the transaction; if NO recipient is accepted it throws.
export async function sendMail(cfg, message) {
  const { host, port = 25, security = 'none', username = null, password = null, timeoutMs = 20000, tlsOptions = {}, helo = 'grafana-report' } = cfg;
  const sock = await open({ host, port, security, timeoutMs, tlsOptions });
  sock.setTimeout(0);
  const c = new Conn(sock);
  const cmd = async (line, expect, stage) => {
    if (line != null) c.write(line + CRLF);
    const r = await c.read(timeoutMs);
    if (!expect.includes(r.code)) throw new SmtpError(`${stage}: server replied ${r.code} ${r.lines.join(' ')}`, { code: r.code, transient: r.code >= 400 && r.code < 500, stage });
    return r;
  };
  try {
    await cmd(null, [220], 'greeting');
    let ehlo = await cmd(`EHLO ${helo}`, [250], 'ehlo');
    if (security === 'starttls') {
      await cmd('STARTTLS', [220], 'starttls');
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: host, ...tlsOptions }, () => resolve(s));
        s.once('error', reject);
      });
      c.buf = '';
      c.attach(secure);
      ehlo = await cmd(`EHLO ${helo}`, [250], 'ehlo-tls');
    }
    if (username) {
      if (security === 'none') throw new SmtpError('refusing to send credentials over an unencrypted connection (set security to starttls or tls)', { transient: false, stage: 'auth' });
      const token = Buffer.from(`\0${username}\0${password || ''}`).toString('base64');
      await cmd(`AUTH PLAIN ${token}`, [235], 'auth').catch((e) => { if (e.code && e.code >= 500) e.transient = false; throw e; });
    }
    const { raw, messageId } = buildMime(message);
    await cmd(`MAIL FROM:<${addrOnly(message.from)}>`, [250], 'mail-from');
    const accepted = [], rejected = [];
    for (const to of message.to) {
      c.write(`RCPT TO:<${addrOnly(to)}>${CRLF}`);
      const r = await c.read(timeoutMs);
      if (r.code === 250 || r.code === 251) accepted.push(to);
      else rejected.push({ address: to, code: r.code, text: r.lines.join(' '), transient: r.code >= 400 && r.code < 500 });
    }
    if (!accepted.length) throw new SmtpError(`no recipient accepted: ${rejected.map((r) => `${r.address} ${r.code}`).join(', ')}`, { code: rejected[0]?.code, transient: rejected.every((r) => r.transient), stage: 'rcpt' });
    await cmd('DATA', [354], 'data');
    c.write(dotStuff(raw) + CRLF + '.' + CRLF);
    const done = await cmd(null, [250], 'data-end');
    try { await cmd('QUIT', [221], 'quit'); } catch { /* the message is already accepted */ }
    return { accepted, rejected, messageId, response: done.lines.join(' ') };
  } finally {
    c.sock.destroy();
  }
}
