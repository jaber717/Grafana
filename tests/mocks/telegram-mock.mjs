// Local Telegram Bot API mock. Validates the bot token in the URL, parses multipart bodies and records every call.
// script: array consumed one entry per request, each {status, body?, headers?}; when empty requests succeed.
import http from 'node:http';
import { Readable } from 'node:stream';

export function startTelegramMock({ token = 'TEST:token-not-real', script = [] } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const reply = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (!m) return reply(404, { ok: false, description: 'Not Found' });
    let fields = {}, file = null;
    try {
      const fd = await new Request('http://mock/', { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }).formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else file = { field: k, filename: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
      }
    } catch { /* malformed body is recorded as empty */ }
    calls.push({ method: m[2], tokenOk: m[1] === token, fields, file });
    if (m[1] !== token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const next = script.shift();
    if (next) return reply(next.status, next.body || { ok: false, description: 'scripted failure' }, next.headers);
    reply(200, { ok: true, result: { message_id: calls.length } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    apiBase: `http://127.0.0.1:${server.address().port}`, token, calls, script, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
