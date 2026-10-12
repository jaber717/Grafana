// Zabbix JSON-RPC stand-in for ISOLATED validation of the Grafana Zabbix datasource plugin against the dashboards (inventory + metrics).
// Dummy credentials, deterministic SYNTHETIC data (tests/mocks/zabbix-data.mjs). Never real data.
//   node tests/mocks/zabbix-mock.mjs [--port 18080] [--log /tmp/zbx.log] [--gap SITE-B]   (listens on 127.0.0.1)
// --gap HOST drops 06:00-07:30 Riyadh of that host's samples (PARTIAL path).
// Admin (loopback test control, plain HTTP, NOT Zabbix API):  POST /admin/add-host {host, group?, type?, mode?, interfaces?}   POST /admin/remove-host {host}
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { GROUPS, HOSTS, ITEMS, history, currentFields, addHost, removeHost } from './zabbix-data.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 18080));
const LOG = opt('log', null);
const GAP_HOST = opt('gap', null);
const arr = (v) => [].concat(v);
const gid = (name) => GROUPS.find((g) => g.name === name)?.groupid;

const hostOut = (h, p) => ({
  hostid: h.id, host: h.host, name: h.host, status: '0',
  ...(p.selectHostGroups || p.selectGroups ? { [p.selectHostGroups ? 'hostgroups' : 'groups']: h.groups.map((n) => ({ groupid: gid(n), name: n })) } : {}),
  ...(p.selectTags ? { tags: h.tags } : {}),
  ...(p.selectInterfaces ? { interfaces: [{ interfaceid: `i${h.id}`, ip: h.ip, type: '2', main: '1' }] } : {}),
  ...(p.selectInventory ? { inventory: { location: h.groups.find((g) => g.startsWith('Site/'))?.slice(5) || '', type: h.groups.find((g) => g.startsWith('Type/'))?.slice(5) || '' } } : {}),
});

function handle(m, p) {
  switch (m) {
    case 'apiinfo.version': return '7.0.0';
    case 'user.login': return 'mock-session-token';
    case 'user.logout': case 'user.checkAuthentication': return true;
    case 'hostgroup.get': return GROUPS.filter((g) => !p.groupids || arr(p.groupids).includes(g.groupid)).map((g) => ({ groupid: g.groupid, name: g.name, internal: '0' }));
    case 'host.get': {
      let r = HOSTS;
      if (p.groupids) { const names = arr(p.groupids).map((id) => GROUPS.find((g) => g.groupid === id)?.name); r = r.filter((h) => h.groups.some((g) => names.includes(g))); }
      if (p.hostids) r = r.filter((h) => arr(p.hostids).includes(h.id));
      if (p.filter?.host) r = r.filter((h) => arr(p.filter.host).includes(h.host));
      if (p.search?.name) r = r.filter((h) => h.host.includes(arr(p.search.name)[0]));
      return r.map((h) => hostOut(h, p));
    }
    case 'item.get': {
      let r = ITEMS;
      if (p.hostids) r = r.filter((i) => arr(p.hostids).includes(i.hostid));
      if (p.groupids) { const names = arr(p.groupids).map((id) => GROUPS.find((g) => g.groupid === id)?.name); const ids = HOSTS.filter((h) => h.groups.some((g) => names.includes(g))).map((h) => h.id); r = r.filter((i) => ids.includes(i.hostid)); }
      if (p.itemids) r = r.filter((i) => arr(p.itemids).includes(i.itemid));
      if (p.search?.name) r = r.filter((i) => i.name.includes(arr(p.search.name)[0]));
      if (p.search?.key_) r = r.filter((i) => i.key_.includes(arr(p.search.key_)[0]));
      if (p.filter?.name) r = r.filter((i) => arr(p.filter.name).includes(i.name));
      if (p.filter?.key_) r = r.filter((i) => arr(p.filter.key_).includes(i.key_));
      if (p.monitored) r = r.filter((i) => i.status === '0');
      return r.map(({ speed, frac, seed, mode, host, kind, noisy, ifname, ...i }) => ({ ...i, ...currentFields({ ...i, mode, kind, speed, seed, noisy }) }));
    }
    case 'history.get': {
      const ids = arr(p.itemids || []);
      const till = p.time_till || Math.floor(Date.now() / 1000);
      return ITEMS.filter((i) => ids.includes(i.itemid)).flatMap((i) => (String(p.history ?? i.value_type) === i.value_type || p.history == null ? history(i, p.time_from || 0, till, GAP_HOST) : []));
    }
    case 'trend.get': {
      // hourly trends aggregated from the same deterministic history (what the plugin asks for beyond its trends threshold)
      const ids = arr(p.itemids || []);
      const till = p.time_till || Math.floor(Date.now() / 1000);
      const out = [];
      for (const i of ITEMS.filter((x) => ids.includes(x.itemid))) {
        const byHour = new Map();
        for (const h of history(i, p.time_from || 0, till, GAP_HOST)) { const k = Math.floor(h.clock / 3600) * 3600; const v = Number(h.value); const e = byHour.get(k) || { n: 0, min: v, max: v, sum: 0 }; e.n++; e.min = Math.min(e.min, v); e.max = Math.max(e.max, v); e.sum += v; byHour.set(k, e); }
        for (const [clock, e] of byHour) out.push({ itemid: i.itemid, clock: String(clock), num: String(e.n), value_min: String(e.min), value_avg: String(e.sum / e.n), value_max: String(e.max) });
      }
      return out;
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
    const send = (code, o) => { const out = JSON.stringify(o); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) }); res.end(out); };
    if (req.url.startsWith('/admin/')) {
      try {
        if (req.url === '/admin/add-host') return send(200, { added: addHost(j).host });
        if (req.url === '/admin/remove-host') return send(200, { removed: removeHost(j.host) });
        return send(404, { error: 'unknown admin call' });
      } catch (e) { return send(400, { error: e.message }); }
    }
    const result = handle(j.method, j.params || {});
    if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${j.method} ${JSON.stringify(j.params || {}).slice(0, 300)} -> ${Array.isArray(result) ? result.length + ' rows' : JSON.stringify(result).slice(0, 40)}\n`);
    send(200, { jsonrpc: '2.0', result, id: j.id });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`zabbix mock on 127.0.0.1:${PORT}${GAP_HOST ? `, gap on ${GAP_HOST}` : ''}`));
