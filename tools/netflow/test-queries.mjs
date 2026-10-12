// Runs every panel/variable query of every dashboard through Grafana's
// /api/ds/query with dashboard variables substituted, and reports
// errors, row counts and timings. Needs GRAFANA_URL and GRAFANA_TOKEN or GRAFANA_USER/GRAFANA_PASSWORD. Read-only SELECTs through /api/ds/query.
//   node test-queries.mjs [--scope real|demo|all] [--from ISO] [--to ISO]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const scope = arg('scope', 'all');
const OV = { exporter: arg('exporter', null), interface: arg('iface', null) };
// Zabbix-backed selectors cannot be evaluated here: --devices stands in for the inventory (the hosts selected by site / device type / device)
const DEVICES = arg('devices', 'SITE-A,SITE-B').split(',');
const quiet = process.argv.includes('--quiet');
const to = new Date(arg('to', new Date().toISOString())).getTime();
const from = new Date(arg('from', new Date(to - 6 * 3600e3).toISOString())).getTime();
const URL_ = (process.env.GRAFANA_URL || 'http://192.168.1.194:3000').replace(/\/$/, '');
const auth = process.env.GRAFANA_TOKEN ? `Bearer ${process.env.GRAFANA_TOKEN}` : 'Basic ' + Buffer.from(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_PASSWORD}`).toString('base64');
const range = to - from;
const res = range <= 43200000 ? ['flows_1m0s', 60] : range <= 604800000 ? ['flows_5m0s', 300] : ['flows_1h0m0s', 3600];

async function run(sql, format, maxPoints = 500) {
  const body = { from: String(from), to: String(to), queries: [{ refId: 'A', datasource: { type: 'grafana-clickhouse-datasource', uid: 'netflow-clickhouse' },
    rawSql: sql, editorType: 'sql', format, intervalMs: Math.max(60000, Math.floor(range / maxPoints)), maxDataPoints: maxPoints }] };
  const t0 = Date.now();
  const r = await fetch(URL_ + '/api/ds/query', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) });
  const j = await r.json(); const a = j.results?.A;
  const ms = Date.now() - t0;
  if (!a || a.error) return { err: (a?.error || j.message || 'no result').slice(0, 220), ms };
  const f = a.frames?.[0]; return { rows: f ? (f.data.values[0] || []).length : 0, first: f ? f.data.values.map((v) => v[0]) : [], ms };
}

const vals = { scope, direction: arg('direction', 'all'), proto: arg('proto', 'all'), src_ip: '', dst_ip: '', res: res[0], res_s: res[1] };
function sub(sql, lists = {}) {
  return sql.replace(/\$\{(\w+)(?::(\w+))?\}/g, (m, n, f) => {
    if (n === '__to') return String(to); if (n === '__from') return String(from);
    if (lists[n]) return f === 'csv' ? lists[n].join(',') : lists[n].map((x) => `'${x}'`).join(',');
    if (n in vals) return String(vals[n]);
    return m;
  });
}
let bad = 0, nq = 0, tms = 0, mx = 0;
for (const f of readdirSync(join(here, '..', '..', 'dashboards', 'netflow')).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(here, '..', '..', 'dashboards', 'netflow', f), 'utf8'));
  console.log(`\n=== ${d.title}  (scope=${scope}, ${res[0]})`);
  const lists = {};
  for (const v of d.templating.list.filter((v) => v.type === 'query')) {
    if (v.datasource?.type === 'alexanderzobnin-zabbix-datasource') { lists[v.name] = ['site', 'device_group'].includes(v.name) ? ['.*'] : DEVICES; continue; }
    const r = await run(sub(v.query, lists), 1);
    if (r.err) { console.log(`  VAR ${v.name}: ERR ${r.err}`); bad++; continue; }
    if (v.hide === 2 && ['res', 'res_s'].includes(v.name)) { vals[v.name] = r.first[0] ?? vals[v.name]; console.log(`  VAR ${v.name} -> ${vals[v.name]}`); continue; }
    const q = await (async () => { const rr = await fetch(URL_ + '/api/ds/query', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ from: String(from), to: String(to), queries: [{ refId: 'A', datasource: { type: 'grafana-clickhouse-datasource', uid: 'netflow-clickhouse' }, rawSql: sub(v.query, lists), editorType: 'sql', format: 1 }] }) }); return (await rr.json()).results.A.frames?.[0]?.data.values[0] || []; })();
    lists[v.name] = OV[v.name] ? [OV[v.name]] : q; if (!quiet) console.log(`  VAR ${v.name}: ${q.length} values [${q.slice(0, 3)}] ${r.ms}ms`);
  }
  for (const p of d.panels.filter((p) => p.targets)) {
    const t = p.targets[0]; const r = await run(sub(t.rawSql, lists), t.format);
    nq++; tms += r.ms; mx = Math.max(mx, r.ms);
    if (r.err) { bad++; console.log(`  FAIL  ${p.title}: ${r.err}`); }
    else if (!quiet) console.log(`  ok    ${p.title.padEnd(46)} rows=${String(r.rows).padEnd(4)} ${String(r.ms).padStart(5)}ms ${JSON.stringify(r.first).slice(0, 70)}`);
  }
}
console.log(`${bad ? bad + " FAILURES" : "ALL OK"} | queries=${nq} total=${tms}ms max=${mx}ms | scope=${scope} range=${Math.round((to - from) / 60000)}min exporter=${OV.exporter || "*"} interface=${OV.interface || "*"} proto=${vals.proto} dir=${vals.direction}`); process.exit(bad ? 1 : 0);
