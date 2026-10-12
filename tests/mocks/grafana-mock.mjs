// Mock Grafana for the report-job tests: /api/health, /api/ds/query (ClickHouse + Zabbix targets answered from fixtures) and
// /render/d-solo (a valid PNG of the requested pixel size). Checks the bearer token and can inject failures.
// It validates the request/response PLUMBING of the job; the real datasource plugins' semantics are validated on a real Grafana.
import http from 'node:http';
import zlib from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(w, h, rgb = [251, 251, 251]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function frameOfRows(rows) {
  if (!rows.length) return { schema: { fields: [] }, data: { values: [] } };
  const names = Object.keys(rows[0]);
  return { schema: { fields: names.map((n) => ({ name: n, type: n === 'time' ? 'time' : typeof rows[0][n] === 'number' ? 'number' : 'string' })) }, data: { values: names.map((n) => rows.map((r) => r[n])) } };
}

// Health (Report C): opts.inventory = host.get rows for POST /api/datasources/uid/zabbix-lab/resources/zabbix-api, opts.health = {series:{ping|snmp|cpu|mem:{host:[{t,v}]}}};
//   Zabbix targets using the health item filters are answered per host (frames labelled host) for the requested time span.
// opts: {token, netflowRows:{id:[rows]}, ifaceSeries:{key:{inbound:[{t,bps}],outbound:[...]}}, cfg, fail503:n, tokenRequired:true,
//        duplicateItems:Set(keys), missingItems:Set(keys), renderSizeOverride:{w,h}}
export function startGrafanaMock(opts = {}) {
  const token = opts.token || 'test-token';
  const stats = { dsQueries: 0, renders: 0, unauthorized: 0, lastRender: null, queryBodies: [] };
  const state = { fail503: opts.fail503 || 0 };
  const byItem = new Map();
  for (const it of opts.cfg?.interfaces || []) { byItem.set(`${it.device}|${it.inboundItem}`, { key: it.key, dir: 'inbound' }); byItem.set(`${it.device}|${it.outboundItem}`, { key: it.key, dir: 'outbound' }); }
  const server = http.createServer((req, res) => {
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    if (req.url === '/api/health') return reply(200, { database: 'ok', version: '13.2.3' });
    if (req.headers.authorization !== `Bearer ${token}`) { stats.unauthorized++; return reply(401, { message: 'Unauthorized' }); }
    if (state.fail503 > 0) { state.fail503--; return reply(503, { message: 'unavailable' }); }
    if (req.method === 'POST' && req.url === '/api/ds/query') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        stats.dsQueries++;
        const q = JSON.parse(body);
        stats.queryBodies.push(q);
        const results = {};
        for (const t of q.queries) {
          if (t.datasource?.type === 'grafana-clickhouse-datasource') {
            if (opts.failQuery === t.refId) { results[t.refId] = { error: 'Code: 60. DB::Exception: Table default.flows does not exist' }; continue; }
            results[t.refId] = { frames: [frameOfRows(opts.netflowRows?.[t.refId] || [])] };
          } else if (t.datasource?.type === 'alexanderzobnin-zabbix-datasource') {
            const hk = { '/^ICMP ping$/': 'ping', '/^SNMP agent availability$/': 'snmp', '/CPU utilization/': 'cpu', '/Memory utilization/': 'mem' }[t.item?.filter];
            if (hk && opts.health) {
              const from = Number(q.from), to = Number(q.to);
              const frames = Object.entries(opts.health.series[hk] || {}).filter(([h]) => (t.host?.filter || '').includes(h)).map(([h, ser]) => {
                const sel = ser.filter((x) => x.t >= from && x.t <= to);
                return { schema: { name: `${h}: ${hk}`, fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number', labels: { host: h, item: hk } }] }, data: { values: [sel.map((x) => x.t), sel.map((x) => x.v)] } };
              }).filter((fr) => fr.data.values[0].length);
              results[t.refId] = { frames };
              continue;
            }
            const hit = byItem.get(`${t.host?.filter}|${t.item?.filter}`);
            if (!hit || opts.missingItems?.has(hit.key)) { results[t.refId] = { frames: [] }; continue; }
            const ser = opts.ifaceSeries?.[hit.key]?.[hit.dir] || [];
            const frame = { schema: { fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] }, data: { values: [ser.map((s) => s.t), ser.map((s) => s.bps)] } };
            results[t.refId] = { frames: opts.duplicateItems?.has(hit.key) ? [frame, frame] : [frame] };
          } else results[t.refId] = { error: 'unknown datasource' };
        }
        reply(200, { results });
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/datasources\/uid\/[^/]+\/resources\/zabbix-api$/.test(req.url)) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { stats.inventoryCalls = (stats.inventoryCalls || 0) + 1; reply(200, { result: opts.inventory || [] }); });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/render/d-solo/')) {
      const u = new URL(req.url, 'http://x');
      const w = Number(u.searchParams.get('width')), h = Number(u.searchParams.get('height')), s = Number(u.searchParams.get('scale') || 1);
      stats.renders++;
      stats.lastRender = Object.fromEntries(u.searchParams);
      const ov = opts.renderSizeOverride;
      return reply(200, makePng(ov ? ov.w : w * s, ov ? ov.h : h * s), 'image/png');
    }
    if (req.method === 'GET' && req.url.startsWith('/api/dashboards/uid/')) {
      const uid = req.url.split('/').pop();
      const dash = opts.dashboards?.[uid];
      return dash ? reply(200, { dashboard: dash }) : reply(404, { message: 'not found' });
    }
    reply(404, { message: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, token, stats, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}
