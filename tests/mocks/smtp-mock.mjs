// Scriptable SMTP test server (a Mailpit stand-in with failure injection). Records every accepted message.
//   opts.rejectRcpt      Set of addresses answered 550
//   opts.tempRcpt        Set of addresses answered 451 (transient)
//   opts.failData        number of DATA transactions to answer 451 before accepting
//   opts.requireAuth     {user, pass}: MAIL is refused (530) until AUTH PLAIN succeeds
//   opts.tls             {key, cert, implicit}: offers STARTTLS (default) or, with implicit:true, speaks TLS from the first byte
// state: connections, authAttempts, failData, tlsHandshakes, ehloSecure (per EHLO: was the connection encrypted?)
import net from 'node:net';
import tls from 'node:tls';

export function startSmtpMock(opts = {}) {
  const messages = [];
  const state = { failData: opts.failData || 0, connections: 0, authAttempts: 0, tlsHandshakes: 0, ehloSecure: [] };
  const onConnection = (first) => {
    state.connections++;
    let sock = first, secure = !!opts.tls?.implicit;
    let buf = '', data = null, from = null, rcpts = [], authed = !opts.requireAuth;
    const send = (s) => sock.write(s + '\r\n');
    const wire = (sk) => {
      sk.setEncoding('utf8');
      sk.on('error', () => {});
      sk.on('data', (d) => {
        buf += d;
        for (;;) {
          if (data !== null) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            const raw = buf.slice(0, end).replace(/^\.\./gm, '.');
            buf = buf.slice(end + 5);
            data = null;
            if (state.failData > 0) { state.failData--; send('451 temporary local problem'); rcpts = []; from = null; continue; }
            messages.push({ from, rcpts: [...rcpts], raw, secure });
            send('250 2.0.0 queued');
            rcpts = []; from = null;
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const u = line.toUpperCase();
          if (u.startsWith('EHLO') || u.startsWith('HELO')) {
            state.ehloSecure.push(secure);
            sock.write(`250-mock-smtp\r\n${opts.tls && !secure ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`);
          } else if (u === 'STARTTLS' && opts.tls && !secure) {
            send('220 ready to start TLS');
            const t = new tls.TLSSocket(sock, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
            t.on('secure', () => { state.tlsHandshakes++; });
            sock = t; secure = true; buf = '';
            wire(t);
            return;
          } else if (u.startsWith('AUTH PLAIN')) {
            state.authAttempts++;
            const [, user, pass] = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0');
            if (opts.requireAuth && user === opts.requireAuth.user && pass === opts.requireAuth.pass) { authed = true; send('235 2.7.0 authenticated'); }
            else send('535 5.7.8 authentication failed');
          } else if (u.startsWith('MAIL FROM')) {
            if (!authed) send('530 5.7.0 authentication required'); else { from = line.match(/<(.*)>/)?.[1]; send('250 ok'); }
          } else if (u.startsWith('RCPT TO')) {
            const a = line.match(/<(.*)>/)?.[1];
            if (opts.rejectRcpt?.has(a)) send('550 5.1.1 no such user');
            else if (opts.tempRcpt?.has(a)) send('451 4.2.0 try later');
            else { rcpts.push(a); send('250 ok'); }
          } else if (u === 'DATA') { data = ''; send('354 end with <CRLF>.<CRLF>'); }
          else if (u === 'QUIT') { send('221 bye'); sock.end(); return; }
          else send('250 ok');
        }
      });
    };
    wire(sock);
    send('220 mock-smtp ready');
  };
  const server = opts.tls?.implicit ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (s) => { state.tlsHandshakes++; onConnection(s); }) : net.createServer(onConnection);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, messages, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
