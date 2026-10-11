// Zabbix JSON-RPC stand-in for ISOLATED validation of the Grafana Zabbix datasource plugin against the report dashboards.
// Dummy credentials, deterministic SYNTHETIC interface rates (bit/s, 60 s samples). Never real data.
//   node tests/mocks/zabbix-mock.mjs [--port 18080] [--log /tmp/zbx.log] [--gap SITE-B]   (listens on 127.0.0.1)
// --gap HOST drops 90 minutes of that host's samples to exercise the PARTIAL path.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { HOSTS, ITEMS, history } from './zabbix-data.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 18080));
const LOG = opt('log', null);
const GAP_HOST = opt('gap', null);

function handle(m, p) {
  switch (m) {
    case 'apiinfo.version': return '7.0.0';
    case 'user.login': return 'mock-session-token';
    case 'user.logout': case 'user.checkAuthentication': return true;
    case 'hostgroup.get': return [{ groupid: '1', name: 'Network', internal: '0' }];
    case 'host.get': {
      const f = p.filter?.host;
      return HOSTS.filter((h) => !f || f.includes(h.host)).map((h) => ({ hostid: h.id, host: h.host, name: h.host, status: '0' }));
    }
    case 'item.get': {
      let r = ITEMS;
      if (p.hostids) r = r.filter((i) => [].concat(p.hostids).includes(i.hostid));
      if (p.itemids) r = r.filter((i) => [].concat(p.itemids).includes(i.itemid));
      if (p.search?.name) r = r.filter((i) => i.name.includes([].concat(p.search.name)[0]));
      if (p.filter?.name) r = r.filter((i) => [].concat(p.filter.name).includes(i.name));
      if (p.filter?.key_) r = r.filter((i) => [].concat(p.filter.key_).includes(i.key_));
      return r.map(({ speed, frac, seed, ...i }) => i);
    }
    case 'history.get': {
      const ids = [].concat(p.itemids || []);
      return ITEMS.filter((i) => ids.includes(i.itemid)).flatMap((i) => (i.value_type === '0' ? history(i, p.time_from || 0, p.time_till || Math.floor(Date.now() / 1000), GAP_HOST) : []));
    }
    default: return [];
  }
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const result = handle(j.method, j.params || {});
    if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${j.method} ${JSON.stringify(j.params || {}).slice(0, 300)} -> ${Array.isArray(result) ? result.length + ' rows' : JSON.stringify(result).slice(0, 40)}\n`);
    const out = JSON.stringify({ jsonrpc: '2.0', result, id: j.id });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
    res.end(out);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`zabbix mock on 127.0.0.1:${PORT}${GAP_HOST ? `, gap on ${GAP_HOST}` : ''}`));
