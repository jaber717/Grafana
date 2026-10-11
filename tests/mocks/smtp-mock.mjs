// Scriptable SMTP test server (a Mailpit stand-in with failure injection). Records every accepted message.
//   opts.rejectRcpt      Set of addresses answered 550
//   opts.tempRcpt        Set of addresses answered 451 (transient)
//   opts.failData        number of DATA transactions to answer 451 before accepting
//   opts.requireAuth     {user, pass}: MAIL is refused (530) until AUTH PLAIN succeeds
import net from 'node:net';

export function startSmtpMock(opts = {}) {
  const messages = [];
  const state = { failData: opts.failData || 0, connections: 0, authAttempts: 0 };
  const server = net.createServer((sock) => {
    state.connections++;
    sock.setEncoding('utf8');
    let buf = '', data = null, from = null, rcpts = [], authed = !opts.requireAuth;
    const send = (s) => sock.write(s + '\r\n');
    send('220 mock-smtp ready');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) { return; }
          const raw = buf.slice(0, end).replace(/^\.\./gm, '.');
          buf = buf.slice(end + 5);
          data = null;
          if (state.failData > 0) { state.failData--; send('451 temporary local problem'); rcpts = []; from = null; continue; }
          messages.push({ from, rcpts: [...rcpts], raw });
          send('250 2.0.0 queued');
          rcpts = []; from = null;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) { sock.write('250-mock-smtp\r\n250 AUTH PLAIN\r\n'); }
        else if (u.startsWith('AUTH PLAIN')) {
          state.authAttempts++;
          const [, user, pass] = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0');
          if (opts.requireAuth && user === opts.requireAuth.user && pass === opts.requireAuth.pass) { authed = true; send('235 2.7.0 authenticated'); }
          else send('535 5.7.8 authentication failed');
        } else if (u.startsWith('MAIL FROM')) { if (!authed) send('530 5.7.0 authentication required'); else { from = line.match(/<(.*)>/)?.[1]; send('250 ok'); } }
        else if (u.startsWith('RCPT TO')) {
          const a = line.match(/<(.*)>/)?.[1];
          if (opts.rejectRcpt?.has(a)) send('550 5.1.1 no such user');
          else if (opts.tempRcpt?.has(a)) send('451 4.2.0 try later');
          else { rcpts.push(a); send('250 ok'); }
        } else if (u === 'DATA') { data = ''; send('354 end with <CRLF>.<CRLF>'); }
        else if (u === 'QUIT') { send('221 bye'); sock.end(); return; }
        else send('250 ok');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, messages, state, close: () => new Promise((r) => server.close(r)),
  })));
}
