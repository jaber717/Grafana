// Panel smoke test: runs every ClickHouse query of the deployed NetFlow dashboards through Grafana (POST /api/ds/query) with the dashboards'
// default variable values ("All"), over the last 30 days, and reports queries that fail. It reads dashboards from the LIVE Grafana, so it tests what
// is deployed. READ-ONLY (queries only). The data may be empty (an idle collector is normal): an empty result is PASS, a SQL/permission error is FAIL.
// Variable interpolation approximates Grafana's frontend (${var}, ${var:raw}, ${var:singlequote}, ${__from:raw}, ${__to:raw}, $__interval_s).
//   node tools/panel-smoke.mjs [--uid netflow-overview] [--range 30d] [--devices SITE-A,SITE-B]
// Environment: GRAFANA_URL, GRAFANA_USER, GRAFANA_PASSWORD (or GRAFANA_TOKEN), GRAFANA_CA_FILE / GRAFANA_CONNECT_ADDR as for the other tools.
import { get, api, parseArgs } from '../scripts/lib/grafana.mjs';

const args = parseArgs(process.argv.slice(2));
const range = args.range || '30d';
const rangeMs = Number(range.replace(/\D/g, '')) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[range.replace(/\d/g, '')] || 86400e3);
const to = Date.now(), from = to - rangeMs;
const uids = args.uid ? [args.uid] : (await get('/api/search?type=dash-db')).filter((d) => d.uid.startsWith('netflow-')).map((d) => d.uid);

const dsQuery = (queries) => api('POST', '/api/ds/query', { queries, from: String(from), to: String(to) });
const column = (r, ref) => (r?.results?.[ref]?.frames || []).flatMap((f) => f.data?.values?.[0] || []);

// Zabbix-backed selectors (site, device_group, site_hosts, device) are frontend-only: --devices stands in for the inventory (default: two names)
const DEVICES = (args.devices || 'SITE-A,SITE-B').split(',');
const fmtValues = (vals, fmt) => (fmt === 'csv' ? vals.join(',') : fmt === 'singlequote' ? vals.map((v) => `'${String(v).replace(/'/g, "\\'")}'`).join(',') : vals.join(','));
function interpolate(sql, vars) {
  const builtin = { __from: from, __to: to, __interval_s: 60, __interval: '60s' };
  return sql
    .replace(/\$\{(\w+)(?::(\w+))?\}/g, (m, name, fmt) => (name in builtin ? String(builtin[name]) : name in vars ? fmtValues(vars[name], fmt) : m))
    .replace(/\$(__interval_s|__from|__to|__interval)\b/g, (m, name) => String(builtin[name]));
}

let pass = 0, fail = 0, empty = 0;
for (const uid of uids) {
  const dash = (await get(`/api/dashboards/uid/${uid}`)).dashboard;
  const vars = {};
  for (const v of dash.templating?.list || []) {
    const cur = v.current?.value;
    if (v.datasource?.type === 'alexanderzobnin-zabbix-datasource') { vars[v.name] = ['site', 'device_group'].includes(v.name) ? ['.*'] : DEVICES; continue; }
    if (v.type === 'query' && v.datasource?.uid === 'netflow-clickhouse') {
      const sql = interpolate(typeof v.query === 'string' ? v.query : v.query?.query, vars);
      try {
        const r = await dsQuery([{ refId: 'V', datasource: v.datasource, rawSql: sql, format: 1, editorType: 'sql' }]);
        const vals = column(r, 'V').map(String);
        vars[v.name] = vals.length ? (v.multi ? vals : [vals[0]]) : [''];
        if (!vals.length && v.multi) vars[v.name] = ["'none'"].map(() => 'none');
      } catch (e) { vars[v.name] = ['']; console.log(`[WARN] ${uid}: variable ${v.name} could not be resolved: ${String(e.message).slice(0, 120)}`); }
    } else {
      vars[v.name] = [Array.isArray(cur) ? cur[0] : cur === undefined ? '' : String(cur)];
    }
  }
  const walk = (ps) => ps.flatMap((p) => [p, ...(p.panels ? walk(p.panels) : [])]);
  for (const p of walk(dash.panels || [])) {
    for (const t of p.targets || []) {
      if (!t.rawSql || (t.datasource?.uid || p.datasource?.uid) !== 'netflow-clickhouse') continue;
      const what = `${uid} | ${p.title || '(untitled)'} | ${t.refId}`;
      try {
        const r = await dsQuery([{ refId: t.refId, datasource: { type: 'grafana-clickhouse-datasource', uid: 'netflow-clickhouse' }, rawSql: interpolate(t.rawSql, vars), format: t.format ?? 1, editorType: 'sql', intervalMs: 60000, maxDataPoints: 500 }]);
        const err = r?.results?.[t.refId]?.error;
        if (err) { fail++; console.log(`[FAIL] ${what}: ${String(err).slice(0, 200)}`); continue; }
        const rows = (r?.results?.[t.refId]?.frames || []).reduce((n, f) => n + (f.data?.values?.[0]?.length || 0), 0);
        if (rows === 0) empty++;
        pass++;
        console.log(`[PASS] ${what}: ${rows} row(s)`);
      } catch (e) { fail++; console.log(`[FAIL] ${what}: ${String(e.message).slice(0, 200)}`); }
    }
  }
}
console.log(`\npanel-smoke: ${pass} PASS (${empty} with no rows), ${fail} FAIL`);
process.exit(fail ? 1 : 0);
