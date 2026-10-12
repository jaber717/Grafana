// Live data for the reports, fetched THROUGH Grafana (/api/ds/query) with exactly the queries/targets the dashboards use.
// Nothing here talks to ClickHouse or Zabbix directly: Grafana owns the datasource credentials.
import { NETFLOW_QUERIES, bind } from './queries.mjs';
import { DS_CH, DS_ZBX, zbxTarget } from './dashboards.mjs';

// ---- NetFlow ----------------------------------------------------------------------------------------------------------------------
// The four per-IP / per-service tables read the RAW flow table (a full day of records) and can exceed the datasource query timeout on a busy
// network. They are OPTIONAL: when one fails with a query error the report is still produced, that table says it is unavailable and why
// (rows._failed), and the observations say so. A network/Grafana error (transient) still aborts and is retried by the caller.
export const OPTIONAL_QUERIES = ['top_src', 'top_dst', 'top_conv', 'top_ports'];
const chQuery = (id, win) => ({ refId: id, datasource: DS_CH, editorType: 'sql', format: 0, rawSql: bind(NETFLOW_QUERIES[id].sql, win, { macro: true }) });

export async function fetchNetflowRows(g, win) {
  const span = { fromMs: win.startMs, toMs: win.endMs };
  const rows = await g.query(Object.keys(NETFLOW_QUERIES).filter((id) => !OPTIONAL_QUERIES.includes(id)).map((id) => chQuery(id, win)), span);
  const failed = {};
  for (const id of OPTIONAL_QUERIES) {
    try { Object.assign(rows, await g.query([chQuery(id, win)], span)); } catch (e) {
      if (e.transient) throw e;
      failed[id] = String(e.message).replace(/^query w+: /, '').slice(0, 160);
    }
  }
  for (const id of Object.keys(NETFLOW_QUERIES)) if (!rows[id]) rows[id] = [];
  rows._failed = failed;
  return rows;
}

// ---- Interfaces -------------------------------------------------------------------------------------------------------------------
// One Zabbix target per interface and direction. The item filter is an exact item NAME on an exact host; a filter that matches
// zero or several items is reported as an issue for that interface (never guessed, never summed).
function targetsFor(cfg) {
  const t = [];
  cfg.interfaces.forEach((it, i) => {
    t.push({ ...zbxTarget(it.device, it.inboundItem, `i${i}`, null, 'Inbound'), _key: it.key, _dir: 'inbound' });
    t.push({ ...zbxTarget(it.device, it.outboundItem, `o${i}`, null, 'Outbound'), _key: it.key, _dir: 'outbound' });
  });
  return t;
}

function samplesOf(frame) {
  const [times, values] = frame.data.values;
  return times.map((t, i) => ({ t, bps: values[i] })).filter((s) => s.bps != null);
}

// Returns {series: {key: {inbound:[{t,bps}], outbound:[...]}}, issues: {key: reason}}
export async function fetchInterfaceSeries(g, cfg, win) {
  const targets = targetsFor(cfg);
  const body = targets.map(({ _key, _dir, ...t }) => t);
  const out = await g.json('POST', '/api/ds/query', { queries: body.map((q) => ({ intervalMs: 300000, maxDataPoints: 1000, ...q })), from: String(win.startMs), to: String(win.endMs) });
  const series = {}, issues = {};
  for (const it of cfg.interfaces) series[it.key] = { inbound: [], outbound: [] };
  for (const t of targets) {
    const r = out.results?.[t.refId];
    if (!r) { issues[t._key] = `no result for ${t._dir}`; continue; }
    if (r.error) { issues[t._key] = `datasource error: ${String(r.error).slice(0, 160)}`; continue; }
    const frames = r.frames || [];
    if (frames.length > 1) { issues[t._key] = `${t._dir} item filter matched ${frames.length} items (must match exactly one)`; continue; }
    if (frames.length === 1) series[t._key][t._dir] = samplesOf(frames[0]);
  }
  return { series, issues };
}
