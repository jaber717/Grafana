// Live data for the reports, fetched THROUGH Grafana (/api/ds/query) with exactly the queries/targets the dashboards use.
// Nothing here talks to ClickHouse or Zabbix directly: Grafana owns the datasource credentials.
import { NETFLOW_QUERIES, bind } from './queries.mjs';
import { DS_CH, DS_ZBX, zbxTarget } from './dashboards.mjs';
import { hostRegex } from './scope.mjs';
import { PATTERN, TIERS, pickTier } from './item-patterns.mjs';

// ---- NetFlow ----------------------------------------------------------------------------------------------------------------------
// The four per-IP / per-service tables read the RAW flow table (a full day of records) and can exceed the datasource query timeout on a busy
// network. They are OPTIONAL: when one fails with a query error the report is still produced, that table says it is unavailable and why
// (rows._failed), and the observations say so. A network/Grafana error (transient) still aborts and is retried by the caller.
export const OPTIONAL_QUERIES = ['top_src', 'top_dst', 'top_conv', 'top_ports'];
const chQuery = (id, win, exporters) => ({ refId: id, datasource: DS_CH, editorType: 'sql', format: 0, rawSql: bind(NETFLOW_QUERIES[id].sql, win, { macro: true, exporters }) });

// exporters: null = every exporter, else the ExporterName list of the report scope
export async function fetchNetflowRows(g, win, exporters = null) {
  const span = { fromMs: win.startMs, toMs: win.endMs };
  const rows = await g.query(Object.keys(NETFLOW_QUERIES).filter((id) => !OPTIONAL_QUERIES.includes(id)).map((id) => chQuery(id, win, exporters)), span);
  const failed = {};
  for (const id of OPTIONAL_QUERIES) {
    try { Object.assign(rows, await g.query([chQuery(id, win, exporters)], span)); } catch (e) {
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

// ---- Network health ---------------------------------------------------------------------------------------------------------------
// ICMP ping, SNMP availability, CPU and memory of the scope's devices through the Zabbix datasource, one query per metric over a host regex.
// Returns the shapes buildHealthModel expects: series per host (5-minute buckets), the last 10 minutes of the window (state at the end of the
// day) and the hosts that reported availability at all in the 8 days up to the end of the window (separates NO DATA from NOT MONITORED).
const FRESH_MS = 10 * 60e3, LOOKBACK_MS = 8 * 86400e3;
const ITEM = { ping: PATTERN.icmp, snmp: PATTERN.snmp, agent: PATTERN.agent };

function hostOf(frame) {
  const fld = frame.schema.fields[1] || {};
  return fld.labels?.host || String(frame.schema.name || fld.name || '').split(': ')[0];
}

// several items of one host (two CPU sensors): keep the highest value per bucket
function mergeFrames(frames) {
  const out = {};
  for (const f of frames) {
    const h = hostOf(f);
    const [times, values] = f.data.values;
    const m = out[h] || new Map();
    times.forEach((t, i) => { if (values[i] != null) m.set(t, m.has(t) ? Math.max(m.get(t), values[i]) : values[i]); });
    out[h] = m;
  }
  return Object.fromEntries(Object.entries(out).map(([h, m]) => [h, [...m].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t)]));
}

async function run(g, queries, fromMs, toMs) {
  const out = await g.json('POST', '/api/ds/query', { queries: queries.map((q) => ({ intervalMs: 300000, maxDataPoints: 1000, ...q })), from: String(fromMs), to: String(toMs) });
  const res = {};
  for (const q of queries) {
    const r = out.results?.[q.refId];
    if (!r) throw new Error(`health query ${q.refId}: no result`);
    if (r.error) throw Object.assign(new Error(`health query ${q.refId}: ${String(r.error).slice(0, 200)}`), { transient: false });
    res[q.refId] = mergeFrames(r.frames || []);
  }
  return res;
}

export async function fetchHealthSeries(g, hosts, win) {
  if (!hosts.length) return { series: { ping: {}, snmp: {}, agent: {}, cpu: {}, mem: {} }, fresh: {}, seen: new Set() };
  const hr = hostRegex(hosts.map((h) => h.host));
  const t = (refId, key, interval = '5m', pattern = ITEM[key]) => { const x = zbxTarget(hr, pattern, refId); x.functions[0].params = [interval, 'avg']; return x; };
  // CPU / memory: one query per configured name (precedence order); per device the FIRST name that has data is used, never a mix of two items
  const tierQ = (kind) => TIERS[kind].map((p, i) => t(`${kind}${i}`, null, '5m', p));
  const day = await run(g, [t('ping', 'ping'), t('snmp', 'snmp'), t('agent', 'agent'), ...tierQ('cpu'), ...tierQ('memory')], win.startMs, win.endMs);
  const tiers = { cpu: {}, mem: {} }, cpu = {}, mem = {};
  for (const h of hosts) {
    for (const [kind, out, key] of [['cpu', cpu, 'cpu'], ['memory', mem, 'mem']]) {
      const per = TIERS[kind].map((_, i) => day[`${kind}${i}`][h.host]);
      const idx = per.findIndex((s) => s && s.length);
      if (idx >= 0) { out[h.host] = pickTier(per); tiers[key][h.host] = idx; }
    }
  }
  const end = await run(g, [t('ping', 'ping'), t('snmp', 'snmp'), t('agent', 'agent')], win.endMs - FRESH_MS, win.endMs);
  const back = await run(g, [t('ping', 'ping', '1d'), t('snmp', 'snmp', '1d'), t('agent', 'agent', '1d')], win.endMs - LOOKBACK_MS, win.endMs);
  const last = (a) => (a && a.length ? a[a.length - 1].v : null);
  const fresh = {}, seen = new Set();
  for (const h of hosts) {
    const p = last(end.ping[h.host]), s = last(end.snmp[h.host]), a = last(end.agent[h.host]);
    fresh[h.host] = { ping: p, snmp: s == null ? null : Math.round(s), agent: a };
    if ((back.ping[h.host]?.length || 0) + (back.snmp[h.host]?.length || 0) + (back.agent[h.host]?.length || 0) + (day.ping[h.host]?.length || 0) + (day.snmp[h.host]?.length || 0) > 0) seen.add(h.host);
  }
  return { series: { ping: day.ping, snmp: day.snmp, agent: day.agent, cpu, mem }, fresh, seen, tiers };
}
