// Turns the NetFlow query results (rows per query id, see queries.mjs) into the report model. Pure function: the same code builds the
// operational report and the DEMO report, only the rows differ.
//   rows = {totals:[{...}], totals_prev:[...], trend:[{time, Inbound, Outbound}], hourly, protocols, exporters, top_src, top_dst,
//           top_conv, top_ports, by_site, by_isp, newest_flow:[{LastFlow}]}   (time = epoch ms, byte/bit values are numbers)
import { classify, expectedBuckets } from './coverage.mjs';
import { averageBps, changePct } from './netflow-math.mjs';
import { fmtBytes, fmtBps, fmtChange, fmtClock, fmtPct } from './format.mjs';

const RAW_RETENTION_DAYS = 14;   // Akvorado raw `flows` table TTL; per-IP Top-N needs it

const num = (v) => (v == null ? 0 : Number(v));
const share = (v, total) => (total > 0 ? (100 * v) / total : null);

function peakOf(trend, col) {
  let best = null;
  for (const r of trend) if (r[col] != null && (best == null || r[col] > best.bps)) best = { bps: r[col], at: r.time };
  return best;
}

export function buildNetflowModel({ win, rows, nowMs = Date.now(), demo = false }) {
  const t = rows.totals?.[0] || {};
  const observed = num(t.Buckets);
  const lastFlowMs = rows.newest_flow?.[0]?.LastFlow ? num(rows.newest_flow[0].LastFlow) * 1000 : t.LastFlow ? num(t.LastFlow) * 1000 : null;
  const cov = classify({ windowSeconds: win.seconds, observedBuckets: observed, lastSampleMs: lastFlowMs, nowMs });
  const hasTraffic = cov.status !== 'NO_DATA' && (num(t.InboundBytes) + num(t.OutboundBytes)) > 0;
  const status = hasTraffic ? cov.status : 'NO_DATA';
  const model = { kind: 'netflow', window: win, demo, status, coverage: cov, generatedAt: nowMs, tables: {}, kpis: null, observations: [], notes: [], available: {} };
  const rawExpired = win.startMs < nowMs - RAW_RETENTION_DAYS * 86400e3;
  model.notes.push('Volumes are derived from NetFlow records scaled by the exporter sampling rate: sampled exporters give ESTIMATED traffic, unsampled exporters give observed volume.');
  model.notes.push('Direction comes from interface boundary metadata (external to internal = inbound). Transit and unclassified flows are not part of inbound or outbound.');
  model.notes.push('Top-10 shares are relative to inbound plus outbound volume; per-IP and per-service tables use flow records classified as inbound or outbound only.');
  model.notes.push('Exporters are listed separately and are not added together; a flow seen by two exporters appears in each exporter row.');
  if (status === 'NO_DATA') {
    model.observations.push('No NetFlow records were received for this reporting day. No traffic figures are shown, and absence of data is not reported as zero traffic.');
    return model;
  }
  const inB = num(t.InboundBytes);
  const outB = num(t.OutboundBytes);
  const prev = rows.totals_prev?.[0] || {};
  const prevHasData = num(prev.Buckets) > 0 && (num(prev.InboundBytes) + num(prev.OutboundBytes)) > 0;
  // a day with gaps is not comparable with a complete day: no percentage is shown, and the report says why
  const comparable = status === 'COMPLETE';
  const prevOk = prevHasData && comparable;
  const trend = rows.trend || [];
  const pin = peakOf(trend, 'Inbound');
  const pout = peakOf(trend, 'Outbound');
  const sampled = num(t.MaxSamplingRate) > 1;
  model.kpis = {
    inboundBytes: inB, outboundBytes: outB, totalBytes: inB + outB,
    avgInBps: averageBps(inB, win.seconds), avgOutBps: averageBps(outB, win.seconds),
    peakIn: pin, peakOut: pout, sampled,
    transitBytes: num(t.TransitBytes), unclassifiedBytes: num(t.UnclassifiedBytes),
    change: prevOk
      ? { inbound: changePct(inB, num(prev.InboundBytes)), outbound: changePct(outB, num(prev.OutboundBytes)), total: changePct(inB + outB, num(prev.InboundBytes) + num(prev.OutboundBytes)) }
      : { inbound: null, outbound: null, total: null },
    previousAvailable: prevOk, comparisonSuppressed: prevHasData && !comparable,
  };
  const topTotal = (list) => list.reduce((s, r) => s + num(r.Bytes), 0);
  const withShare = (list, total) => list.map((r) => ({ ...r, Bytes: num(r.Bytes), Share: share(num(r.Bytes), total) }));
  const edgeBytes = inB + outB;
  model.tables.rawExpired = rawExpired;
  for (const k of ['top_src', 'top_dst', 'top_conv', 'top_ports']) model.tables[k] = rawExpired ? [] : withShare(rows[k] || [], edgeBytes);
  model.tables.protocols = withShare(rows.protocols || [], topTotal(rows.protocols || []));
  model.tables.exporters = (rows.exporters || []).map((e) => ({
    ...e, InboundBytes: num(e.InboundBytes), OutboundBytes: num(e.OutboundBytes), Coverage: Math.min(1, num(e.Buckets) / expectedBuckets(win.seconds)),
    Sampled: num(e.MaxSamplingRate) > 1,
  }));
  model.tables.bySite = (rows.by_site || []).map((r) => ({ ...r, InboundBytes: num(r.InboundBytes), OutboundBytes: num(r.OutboundBytes) }));
  model.tables.byIsp = (rows.by_isp || []).map((r) => ({ ...r, InboundBytes: num(r.InboundBytes), OutboundBytes: num(r.OutboundBytes) }));
  model.available = { site: model.tables.bySite.length > 0, isp: model.tables.byIsp.length > 0, protocols: model.tables.protocols.length > 0, rawTables: !rawExpired };
  // observations: only statements that follow directly from the numbers
  const k = model.kpis;
  model.observations.push(`Inbound ${fmtBytes(inB)} and outbound ${fmtBytes(outB)} (${k.sampled ? 'estimated from sampled flows' : 'observed volume'}); average ${fmtBps(k.avgInBps)} in and ${fmtBps(k.avgOutBps)} out.`);
  if (pin) model.observations.push(`Inbound peaked at ${fmtBps(pin.bps)} at ${fmtClock(pin.at)}${pout ? `; outbound peaked at ${fmtBps(pout.bps)} at ${fmtClock(pout.at)}` : ''} (5-minute averages, Asia/Riyadh).`);
  if (k.previousAvailable) model.observations.push(`Total volume ${fmtChange(k.change.total)} against the previous day (inbound ${fmtChange(k.change.inbound)}, outbound ${fmtChange(k.change.outbound)}).`);
  else if (k.comparisonSuppressed) model.observations.push(`Previous-day comparison is not shown: this day is incomplete (coverage ${fmtPct(cov.coverage * 100, 0)}), so it is not comparable with a full day.`);
  else model.observations.push('No previous-day data is available, so no comparison is shown.');
  const ts = model.tables.top_src[0];
  if (ts) model.observations.push(`Largest source: ${ts.IP} with ${fmtPct(ts.Share)} of inbound plus outbound volume.`);
  if (status === 'PARTIAL') model.observations.push(`Data coverage is ${fmtPct(cov.coverage * 100, 0)} (${cov.observed} of ${cov.expected} five-minute intervals): the volumes above understate real traffic.`);
  if (k.sampled) model.observations.push(`Volumes are estimates: exporters sample 1 in ${num(t.MaxSamplingRate)} packets and each record is scaled by its sampling rate.`);
  if (rawExpired) model.notes.push(`Per-IP tables are not available: raw flow records are kept ${RAW_RETENTION_DAYS} days and this day is older.`);
  return model;
}
