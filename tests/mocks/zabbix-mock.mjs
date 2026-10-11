// Zabbix JSON-RPC stand-in for ISOLATED validation of the Grafana Zabbix datasource plugin against the report dashboards.
// Dummy credentials, deterministic SYNTHETIC interface rates (bit/s, 60 s samples). Never real data.
//   node tests/mocks/zabbix-mock.mjs [--port 18080] [--log /tmp/zbx.log] [--gap SITE-B]   (listens on 127.0.0.1)
// --gap HOST drops 90 minutes of that host's samples to exercise the PARTIAL path.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { mulberry32 } from '../../reports/lib/demo.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 18080));
const LOG = opt('log', null);
const GAP_HOST = opt('gap', null);

// host, id, interfaces: [name, description, speed bit/s, in peak fraction, out peak fraction]
const HOSTS = [
  { host: 'SITE-A', id: '10001', ifs: [['Gi0/0', 'TO-SAIX-A-Gi0/1', 1e9, 0.62, 0.27]] },
  { host: 'SITE-B', id: '10002', ifs: [['Gi0/0', 'TO-SAIX-B-Gi0/1', 1e9, 0.48, 0.2]] },
  { host: 'STC', id: '10003', ifs: [['Gi0/0', 'TO-INT-CORE-Gi0/0', 1e9, 0.1, 0.05]] },
];
const ITEMS = [];
let nextId = 90000;
for (const h of HOSTS) {
  for (const [name, desc, speed, fin, fout] of h.ifs) {
    for (const [dir, key, frac] of [['received', `net.if.in[ifHCInOctets.1]`, fin], ['sent', `net.if.out[ifHCOutOctets.1]`, fout]]) {
      ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: `Interface ${name}(${desc}): Bits ${dir}`, key_: key, value_type: '0', units: 'bps', status: '0', state: '0', delay: '60s', history: '7d', trends: '365d', lastvalue: '0', lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }], speed, frac, seed: nextId });
    }
    ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: `Interface ${name}(${desc}): Speed`, key_: 'net.if.speed[ifHighSpeed.1]', value_type: '3', units: 'bps', status: '0', state: '0', delay: '1h', history: '7d', trends: '365d', lastvalue: String(speed), lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }] });
  }
  ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: 'ICMP ping', key_: 'icmpping', value_type: '3', units: '', status: '0', state: '0', delay: '1m', history: '7d', trends: '365d', lastvalue: '1', lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }] });
}

function rateAt(item, tSec) {
  const dayStart = Math.floor((tSec + 3 * 3600) / 86400) * 86400 - 3 * 3600;       // Riyadh midnight
  const hour = (tSec - dayStart) / 3600;
  const rnd = mulberry32(item.seed * 100003 + Math.floor(tSec / 60));
  const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
  const peaks = Math.exp(-((hour - 11) ** 2) / 3) * 0.25 + Math.exp(-((hour - 20.5) ** 2) / 4) * 0.2;
  const night = hour < 5 ? 0.35 : 1;
  return Math.max(0, (diurnal + peaks) * night) * (item.speed * item.frac / 1.22) * (0.94 + 0.12 * rnd());
}

function history(item, from, till) {
  const out = [];
  const host = HOSTS.find((h) => h.id === item.hostid).host;
  const gapStart = Math.floor(from / 86400) * 86400 + 6 * 3600, gapEnd = gapStart + 90 * 60;
  for (let t = Math.ceil(from / 60) * 60; t <= till; t += 60) {
    if (GAP_HOST === host && t >= gapStart && t < gapEnd) continue;
    out.push({ itemid: item.itemid, clock: String(t), value: String(Math.round(rateAt(item, t))), ns: '0' });
  }
  return out;
}

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
      return ITEMS.filter((i) => ids.includes(i.itemid)).flatMap((i) => (i.value_type === '0' ? history(i, p.time_from || 0, p.time_till || Math.floor(Date.now() / 1000)) : []));
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
