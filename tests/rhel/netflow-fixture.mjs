// Synthetic NetFlow rows for the ClickHouse validation + their EXPECTED report values, computed by an independent aggregation of the same
// rows (the business rules are applied here directly in JS: window filter, demo-exporter exclusion, boundary-based direction, x SamplingRate).
// A mismatch between a report query and these expectations is a defect in the query. Nothing here is real traffic.
import { windowForDate } from '../../reports/lib/window.mjs';

const BUCKET = 300;
export const DEMO_ADDR = '::ffff:247.16.14.11';
const E1 = { addr: '::ffff:10.0.0.1', name: 'edge-01', site: 'HQ', rate: 1000 };
const E2 = { addr: '::ffff:10.0.0.2', name: 'edge-02', site: 'DC', rate: 1 };
const DEMO = { addr: DEMO_ADDR, name: 'demo-exporter', site: 'DEMO', rate: 1000 };
const v4 = (a) => `::ffff:${a}`;

function rowsForBucket(t, { inBytes, outBytes }) {
  const R = (e, o) => ({ t, rate: e.rate, exporter: e.addr, exporterName: e.name, site: e.site, srcNet: '', dstNet: '', inProv: '', outProv: '', proto: 6, srcPort: 40000, dstPort: 443, packets: 1, ...o });
  return [
    R(E1, { src: v4('203.0.113.10'), dst: v4('10.20.4.15'), inIf: 'Gi0/0', outIf: 'Gi0/1', inB: 'external', outB: 'internal', inProv: 'ISP-A', bytes: inBytes, srcNet: 'CDN-A' }),
    R(E1, { src: v4('198.51.100.24'), dst: v4('10.20.4.88'), inIf: 'Gi0/0', outIf: 'Gi0/1', inB: 'external', outB: 'internal', inProv: 'ISP-A', bytes: 90, dstPort: 80 }),
    R(E1, { src: v4('10.20.4.15'), dst: v4('203.0.113.10'), inIf: 'Gi0/1', outIf: 'Gi0/0', inB: 'internal', outB: 'external', outProv: 'ISP-A', bytes: outBytes }),
    R(E1, { src: v4('203.0.113.77'), dst: v4('198.51.100.9'), inIf: 'Gi0/0', outIf: 'Gi0/2', inB: 'external', outB: 'external', bytes: 10 }),
    R(E1, { src: v4('10.20.4.15'), dst: v4('10.20.4.200'), inIf: 'Gi0/1', outIf: 'Gi0/3', inB: 'internal', outB: 'internal', bytes: 5 }),
    R(E2, { src: v4('192.0.2.45'), dst: v4('10.30.1.20'), inIf: 'Te0/1', outIf: 'Te0/2', inB: 'external', outB: 'internal', inProv: 'ISP-X', bytes: 1000, proto: 17, dstPort: 443 }),
    R(E2, { src: v4('10.30.1.20'), dst: v4('192.0.2.45'), inIf: 'Te0/2', outIf: 'Te0/1', inB: 'internal', outB: 'external', outProv: 'ISP-X', bytes: 400, proto: 17, dstPort: 443 }),
    R(DEMO, { src: v4('203.0.113.200'), dst: v4('10.99.0.1'), inIf: 'Gi0/0', outIf: 'Gi0/1', inB: 'external', outB: 'internal', bytes: 999999 }),
  ];
}

// date: the report day; E1 inbound is 100 bytes per record on the report day and 50 on the day before (so the comparison is not trivial).
export function buildFixture(date = '2026-10-11', { gapBuckets = [] } = {}) {
  const win = windowForDate(date);
  const prev = windowForDate(new Date(win.startMs - 86400e3 + 3 * 3600e3).toISOString().slice(0, 10));
  const rows = [];
  for (let k = 0; k < 288; k++) {
    if (!gapBuckets.includes(k)) rows.push(...rowsForBucket(win.startMs / 1000 + k * BUCKET + 17, { inBytes: 100, outBytes: 50 }));
    rows.push(...rowsForBucket(prev.startMs / 1000 + k * BUCKET + 17, { inBytes: 50, outBytes: 50 }));
  }
  // the first second AFTER the window must not be counted (the window is half-open)
  rows.push(...rowsForBucket(win.endMs / 1000, { inBytes: 1e9, outBytes: 1e9 }));
  return { win, prev, rows };
}

const dir = (r) => (r.inB === 'external' && r.outB !== 'external' ? 'inbound' : r.outB === 'external' && r.inB !== 'external' ? 'outbound' : r.inB === 'external' && r.outB === 'external' ? 'transit' : 'unclassified');
const est = (r) => r.bytes * r.rate;
const inWin = (r, w) => r.t >= w.startMs / 1000 && r.t < w.endMs / 1000 && r.exporter !== DEMO_ADDR;
const bucketOf = (t) => Math.floor(t / BUCKET) * BUCKET;
const hourOf = (t) => Math.floor(t / 3600) * 3600;
const group = (rows, keyFn, valFn) => { const m = new Map(); for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + valFn(r)); return m; };
const stripV4 = (a) => a.replace(/^::ffff:/, '');

export function expected({ win, prev, rows }) {
  const day = rows.filter((r) => inWin(r, win));
  const pday = rows.filter((r) => inWin(r, prev));
  const sum = (rs, d) => rs.filter((r) => dir(r) === d).reduce((a, r) => a + est(r), 0);
  const edge = day.filter((r) => ['inbound', 'outbound'].includes(dir(r)));
  const top = (rs, keyFn, n = 10) => [...group(rs, keyFn, est).entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
  const buckets = new Set(day.map((r) => bucketOf(r.t)));
  return {
    totals: { InboundBytes: sum(day, 'inbound'), OutboundBytes: sum(day, 'outbound'), TransitBytes: sum(day, 'transit'), UnclassifiedBytes: sum(day, 'unclassified'), MaxSamplingRate: Math.max(...day.map((r) => r.rate)), Buckets: buckets.size, Exporters: new Set(day.map((r) => r.exporter)).size, LastFlow: Math.max(...buckets) },
    totals_prev: { InboundBytes: sum(pday, 'inbound'), OutboundBytes: sum(pday, 'outbound'), Buckets: new Set(pday.map((r) => bucketOf(r.t))).size },
    trend: [...buckets].sort((a, b) => a - b).map((b) => ({ t: b, Inbound: (sum(day.filter((r) => bucketOf(r.t) === b), 'inbound') * 8) / BUCKET, Outbound: (sum(day.filter((r) => bucketOf(r.t) === b), 'outbound') * 8) / BUCKET })),
    hourly: [...new Set(day.map((r) => hourOf(r.t)))].sort((a, b) => a - b).map((h) => ({ t: h, Inbound: sum(day.filter((r) => hourOf(r.t) === h), 'inbound'), Outbound: sum(day.filter((r) => hourOf(r.t) === h), 'outbound') })),
    protocols: top(edge, (r) => (r.proto === 6 ? 'TCP' : r.proto === 17 ? 'UDP' : r.proto === 1 ? 'ICMP' : 'Other')),
    top_src: top(edge, (r) => stripV4(r.src)),
    top_dst: top(edge, (r) => stripV4(r.dst)),
    top_conv: top(edge, (r) => `${stripV4(r.src)}>${stripV4(r.dst)}>${r.proto === 6 ? 'TCP' : r.proto === 17 ? 'UDP' : 'proto ' + r.proto}/${r.dstPort}`),
    top_ports: top(edge, (r) => `${r.proto === 6 ? 'TCP' : r.proto === 17 ? 'UDP' : 'proto ' + r.proto}/${r.dstPort}`),
    exporters: [...new Set(day.map((r) => r.exporterName))].map((n) => { const rs = day.filter((r) => r.exporterName === n); return { Exporter: n, InboundBytes: sum(rs, 'inbound'), OutboundBytes: sum(rs, 'outbound'), MaxSamplingRate: Math.max(...rs.map((r) => r.rate)), Buckets: new Set(rs.map((r) => bucketOf(r.t))).size }; }).sort((a, b) => b.InboundBytes + b.OutboundBytes - a.InboundBytes - a.OutboundBytes),
    by_site: [...new Set(day.map((r) => r.site))].map((s) => { const rs = day.filter((r) => r.site === s); return { Site: s, InboundBytes: sum(rs, 'inbound'), OutboundBytes: sum(rs, 'outbound') }; }).sort((a, b) => b.InboundBytes + b.OutboundBytes - a.InboundBytes - a.OutboundBytes),
    by_isp: [...new Set(edge.map((r) => (r.inB === 'external' ? r.inProv : r.outProv)).filter(Boolean))].map((p) => { const rs = edge.filter((r) => (r.inB === 'external' ? r.inProv : r.outProv) === p); return { Provider: p, InboundBytes: sum(rs, 'inbound'), OutboundBytes: sum(rs, 'outbound') }; }).sort((a, b) => b.InboundBytes + b.OutboundBytes - a.InboundBytes - a.OutboundBytes),
  };
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const COLS = ['TimeReceived', 'SamplingRate', 'ExporterAddress', 'ExporterName', 'ExporterSite', 'SrcAddr', 'DstAddr', 'SrcNetName', 'DstNetName', 'InIfName', 'OutIfName', 'InIfBoundary', 'OutIfBoundary', 'InIfProvider', 'OutIfProvider', 'EType', 'Proto', 'SrcPort', 'DstPort', 'Bytes', 'Packets'];
export function insertSql(rows) {
  const vals = rows.map((r) => `(${[`toDateTime(${r.t})`, r.rate, `toIPv6(${q(r.exporter)})`, q(r.exporterName), q(r.site), `toIPv6(${q(r.src)})`, `toIPv6(${q(r.dst)})`, q(r.srcNet), q(r.dstNet), q(r.inIf), q(r.outIf), q(r.inB), q(r.outB), q(r.inProv), q(r.outProv), 2048, r.proto, r.srcPort, r.dstPort, r.bytes, r.packets].join(',')})`);
  return `INSERT INTO default.flows (${COLS.join(',')}) VALUES ${vals.join(',')}`;
}
