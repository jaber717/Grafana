// DEMO datasets for layout review, tests and the example PDFs. Deterministic, synthetic, and ALWAYS labelled DEMO by the renderer.
// IP addresses are RFC 5737 documentation ranges, names are fictitious. These fixtures are never read by an operational report run.
import { mulberry32 } from './demo.mjs';
import { BUCKET_S } from './coverage.mjs';
import { loadInterfaceConfig } from './config.mjs';

const N = 288;
const SHAPE = (k, rnd, peak) => {
  const hour = k / 12;
  const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
  const peaks = Math.exp(-((hour - 11) ** 2) / 3) * 0.25 + Math.exp(-((hour - 20.5) ** 2) / 4) * 0.2;
  const night = hour < 5 ? 0.35 : 1;
  return Math.max(0, (diurnal + peaks) * night) * peak * (0.93 + 0.14 * rnd());
};

// 288 values for one day; buckets in `gap` [from,to) are null (absent), never zero.
function dayValues(seed, peak, gap) {
  const rnd = mulberry32(seed);
  return Array.from({ length: N }, (_, k) => (gap && k >= gap[0] && k < gap[1] ? (rnd(), null) : SHAPE(k, rnd, peak)));
}

const bytesOf = (vals) => vals.reduce((a, v) => a + (v == null ? 0 : (v * BUCKET_S) / 8), 0);

export function netflowFixture(win, { scenario = 'normal' } = {}) {
  const none = scenario === 'nodata';
  const gap = scenario === 'partial' ? [150, 188] : null;
  const rowsOf = (vals) => vals.map((v, k) => ({ time: win.startMs + k * BUCKET_S * 1000, v }));
  const inV = dayValues(11, 640e6, gap), outV = dayValues(23, 215e6, gap);
  const inP = dayValues(31, 603e6, null), outP = dayValues(47, 221e6, null);
  const empty = { totals: [{}], totals_prev: [{}], trend: [], trend_total: [], trend_prev: [], hourly: [], protocols: [], exporters: [], top_src: [], top_dst: [], top_conv: [], top_ports: [], by_site: [], by_isp: [], newest_flow: [{}] };
  if (none) return empty;
  const trend = inV.map((v, k) => ({ time: win.startMs + k * BUCKET_S * 1000, Inbound: v, Outbound: outV[k] }));
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    time: win.startMs + h * 3600e3,
    Inbound: bytesOf(inV.slice(h * 12, h * 12 + 12)), Outbound: bytesOf(outV.slice(h * 12, h * 12 + 12)),
  }));
  const inB = bytesOf(inV), outB = bytesOf(outV), edge = inB + outB;
  const observed = inV.filter((v) => v != null).length;
  const lastFlow = Math.floor((win.endMs - BUCKET_S * 1000) / 1000);
  const pct = (p) => Math.round(edge * p);
  const talkers = (ips, parts) => ips.map((ip, i) => ({ IP: ip[0], Network: ip[1], Bytes: pct(parts[i]) }));
  return {
    totals: [{ InboundBytes: inB, OutboundBytes: outB, TransitBytes: pct(0.012), UnclassifiedBytes: pct(0.004), MaxSamplingRate: 1000, Buckets: observed, Exporters: 3, LastFlow: lastFlow }],
    totals_prev: [{ InboundBytes: bytesOf(inP), OutboundBytes: bytesOf(outP), Buckets: N }],
    trend,
    trend_total: trend.map((r) => ({ time: r.time, 'Report day': r.Inbound == null ? null : r.Inbound + r.Outbound })),
    trend_prev: inP.map((v, k) => ({ time: win.startMs + k * BUCKET_S * 1000, 'Previous day': v + outP[k] })),
    hourly,
    protocols: [{ Protocol: 'TCP', Bytes: pct(0.712) }, { Protocol: 'UDP', Bytes: pct(0.241) }, { Protocol: 'ICMP', Bytes: pct(0.011) }, { Protocol: 'Other', Bytes: pct(0.036) }],
    exporters: [
      { Exporter: 'demo-edge-01', Site: 'DEMO-HQ', InboundBytes: Math.round(inB * 0.58), OutboundBytes: Math.round(outB * 0.55), MaxSamplingRate: 1000, Buckets: observed, LastSeen: lastFlow },
      { Exporter: 'demo-edge-02', Site: 'DEMO-DC', InboundBytes: Math.round(inB * 0.31), OutboundBytes: Math.round(outB * 0.35), MaxSamplingRate: 1000, Buckets: observed, LastSeen: lastFlow },
      { Exporter: 'demo-branch-01', Site: 'DEMO-BRANCH', InboundBytes: Math.round(inB * 0.11), OutboundBytes: Math.round(outB * 0.10), MaxSamplingRate: 1000, Buckets: Math.round(observed * 0.97), LastSeen: lastFlow },
    ],
    top_src: talkers([['203.0.113.10', 'DEMO-CDN-A'], ['198.51.100.24', 'DEMO-CLOUD-B'], ['203.0.113.77', 'DEMO-CDN-A'], ['192.0.2.45', 'DEMO-SAAS'], ['198.51.100.200', '-'], ['203.0.113.130', 'DEMO-CDN-C'], ['192.0.2.9', 'DEMO-DNS'], ['198.51.100.61', 'DEMO-CLOUD-B'], ['203.0.113.201', '-'], ['192.0.2.150', 'DEMO-SAAS']], [0.118, 0.094, 0.071, 0.058, 0.044, 0.039, 0.031, 0.027, 0.022, 0.018]),
    top_dst: talkers([['10.20.4.15', 'DEMO-LAN-HQ'], ['10.20.4.88', 'DEMO-LAN-HQ'], ['10.30.1.20', 'DEMO-LAN-DC'], ['10.20.9.4', 'DEMO-LAN-HQ'], ['10.40.2.31', 'DEMO-LAN-BR'], ['10.30.1.45', 'DEMO-LAN-DC'], ['10.20.4.120', 'DEMO-LAN-HQ'], ['10.30.5.2', 'DEMO-LAN-DC'], ['10.40.2.77', 'DEMO-LAN-BR'], ['10.20.7.19', 'DEMO-LAN-HQ']], [0.102, 0.083, 0.067, 0.055, 0.047, 0.036, 0.029, 0.024, 0.02, 0.016]),
    top_conv: [
      ['203.0.113.10', '10.20.4.15', 'TCP/443', 0.061], ['198.51.100.24', '10.20.4.88', 'TCP/443', 0.048], ['10.30.1.20', '192.0.2.45', 'TCP/443', 0.037], ['203.0.113.77', '10.30.1.20', 'TCP/443', 0.033], ['198.51.100.200', '10.20.9.4', 'UDP/443', 0.029],
      ['203.0.113.130', '10.40.2.31', 'TCP/80', 0.024], ['10.20.4.120', '192.0.2.9', 'UDP/53', 0.019], ['198.51.100.61', '10.30.5.2', 'TCP/22', 0.016], ['10.40.2.77', '203.0.113.201', 'TCP/443', 0.014], ['192.0.2.150', '10.20.7.19', 'TCP/443', 0.012],
    ].map(([s, d, v, p]) => ({ Source: s, Destination: d, Service: v, Bytes: pct(p) })),
    top_ports: [['TCP/443 (HTTPS)', 0.562], ['UDP/443', 0.131], ['UDP/53 (DNS)', 0.044], ['TCP/80 (HTTP)', 0.039], ['TCP/22 (SSH)', 0.021], ['UDP/123 (NTP)', 0.006], ['TCP/445 (SMB)', 0.019], ['TCP/3389 (RDP)', 0.011], ['TCP/8443', 0.009], ['UDP/5060 (SIP)', 0.007]].map(([s, p]) => ({ Service: s, Bytes: pct(p) })),
    by_site: [['DEMO-HQ', 0.56, 0.52], ['DEMO-DC', 0.31, 0.37], ['DEMO-BRANCH', 0.13, 0.11]].map(([s, a, b]) => ({ Site: s, InboundBytes: Math.round(inB * a), OutboundBytes: Math.round(outB * b) })),
    by_isp: [['DEMO-ISP-ALPHA', 0.52, 0.49], ['DEMO-ISP-BETA', 0.36, 0.4], ['DEMO-ISP-GAMMA', 0.12, 0.11]].map(([s, a, b]) => ({ Provider: s, InboundBytes: Math.round(inB * a), OutboundBytes: Math.round(outB * b) })),
    newest_flow: [{ LastFlow: lastFlow }],
  };
}

export const DEMO_INTERFACE_YAML = `
groups:
  - id: wan
    title: WAN uplinks
  - id: dc
    title: Data centre links
interfaces:
  - site: DEMO-HQ
    device: DEMO-HQ-R1
    interface: Gi0/0
    description: ISP-ALPHA
    speed: 1G
    group: wan
    boundary: DEMO-HQ-WAN
    include: true
  - site: DEMO-HQ
    device: DEMO-HQ-R1
    interface: Gi0/1
    description: ISP-BETA
    speed: 1G
    group: wan
    boundary: DEMO-HQ-WAN
    include: true
  - site: DEMO-BRANCH-1
    device: DEMO-BR1-R1
    interface: Gi0/0
    description: ISP-ALPHA
    speed: 100M
    group: wan
    include: true
  - site: DEMO-BRANCH-2
    device: DEMO-BR2-R1
    interface: Gi0/0
    description: ISP-GAMMA
    speed: 500M
    group: wan
    include: true
  - site: DEMO-DC
    device: DEMO-DC-R1
    interface: Te0/1
    description: ISP-ALPHA
    speed: 10G
    group: dc
    include: true
  - site: DEMO-DC
    device: DEMO-DC-R1
    interface: Te0/2
    description: ISP-BETA
    group: dc
    include: true
`;

export function demoInterfaceConfig() {
  return loadInterfaceConfig(DEMO_INTERFACE_YAML);
}

// scenario: 'normal' | 'partial' (one interface has a 90 minute gap) | 'nodata'
export function interfaceFixture(win, cfg, { scenario = 'normal' } = {}) {
  const plan = {
    'DEMO-HQ-R1:Gi0/0': { seed: 3, inPeak: 0.72, outPeak: 0.31 },
    'DEMO-HQ-R1:Gi0/1': { seed: 5, inPeak: 0.41, outPeak: 0.18 },
    'DEMO-BR1-R1:Gi0/0': { seed: 8, inPeak: 0.88, outPeak: 0.46 },
    'DEMO-BR2-R1:Gi0/0': { seed: 13, inPeak: 0.35, outPeak: 0.2, gap: [60, 78] },
    'DEMO-DC-R1:Te0/1': { seed: 17, inPeak: 0.28, outPeak: 0.34 },
    'DEMO-DC-R1:Te0/2': { seed: 19, inPeak: 0.0, outPeak: 0.0, absolute: [420e6, 160e6] },
  };
  const series = {}, prevSeries = {}, byKey = {};
  for (const it of cfg.interfaces) {
    const p = plan[it.key];
    if (scenario === 'nodata' || !p) { series[it.key] = { inbound: [], outbound: [] }; byKey[it.key] = []; continue; }
    const sp = it.speedBps;
    // SHAPE overshoots its nominal peak by ~20 %: normalise so the design fractions are the real peaks
    const peakIn = (p.absolute ? p.absolute[0] : sp * p.inPeak) / 1.22, peakOut = (p.absolute ? p.absolute[1] : sp * p.outPeak) / 1.22;
    const gap = scenario === 'partial' ? p.gap || null : null;
    const gapAlways = p.gap && scenario !== 'normal' ? p.gap : null;
    const iv = dayValues(p.seed, peakIn, gap || gapAlways), ov = dayValues(p.seed + 100, peakOut, gap || gapAlways);
    const pv = dayValues(p.seed + 200, peakIn * 0.93, null), pov = dayValues(p.seed + 300, peakOut * 1.05, null);
    const toSamples = (vals, start) => vals.map((v, k) => (v == null ? null : { t: start + k * BUCKET_S * 1000, bps: v })).filter(Boolean);
    series[it.key] = { inbound: toSamples(iv, win.startMs), outbound: toSamples(ov, win.startMs) };
    prevSeries[it.key] = { inbound: toSamples(pv, win.startMs - 86400e3), outbound: toSamples(pov, win.startMs - 86400e3) };
    byKey[it.key] = iv.map((v, k) => ({ time: win.startMs + k * BUCKET_S * 1000, Inbound: v, Outbound: ov[k] }));
  }
  return { series, prevSeries, byKey };
}

// ---- Network Health (Report C) DEMO fixture ---------------------------------------------------------------------------------------------
// Eight fictitious devices covering every state: UP, a short outage, ping-only switch (no CPU / memory: still UP), CPU alert, DOWN at the end of
// the day, NO DATA (stopped reporting), UNKNOWN (SNMP availability only) and NOT MONITORED.
export const DEMO_HEALTH_DEVICES = [
  { host: 'DEMO-HQ-R1', sites: ['DEMO-HQ'], types: ['Router'] },
  { host: 'DEMO-HQ-R2', sites: ['DEMO-HQ'], types: ['Router'] },
  { host: 'DEMO-HQ-SW1', sites: ['DEMO-HQ'], types: ['Switch'] },
  { host: 'DEMO-DC-R1', sites: ['DEMO-DC'], types: ['Router'] },
  { host: 'DEMO-BR1-R1', sites: ['DEMO-BRANCH-1'], types: ['Router'] },
  { host: 'DEMO-BR2-R1', sites: ['DEMO-BRANCH-2'], types: ['Router'] },
  { host: 'DEMO-BR2-AP1', sites: ['DEMO-BRANCH-2'], types: ['Switch'] },
  { host: 'DEMO-BR2-SW1', sites: ['DEMO-BRANCH-2'], types: ['Switch'] },
];

// scenario: 'normal' | 'partial' (DEMO-HQ-R1 has a 100 minute gap) | 'nodata'
export function healthFixture(win, { scenario = 'normal' } = {}) {
  const devices = DEMO_HEALTH_DEVICES;
  const seen = new Set(devices.filter((d) => d.host !== 'DEMO-BR2-SW1' || scenario === 'nodata').map((d) => d.host));
  const out = { devices, series: { ping: {}, snmp: {}, cpu: {}, mem: {} }, fresh: {}, seen, byHost: {} };
  if (scenario === 'nodata') return out;
  const at = (k) => win.startMs + k * BUCKET_S * 1000;
  const plan = {
    'DEMO-HQ-R1': { cpu: [34, 71, 5], mem: [52, 6, 6], gap: scenario === 'partial' ? [150, 170] : null },
    'DEMO-HQ-R2': { cpu: [29, 55, 8], mem: [47, 5, 9], down: [38, 46] },
    'DEMO-HQ-SW1': { ping: true },
    'DEMO-DC-R1': { cpu: [58, 93, 11], mem: [66, 6, 12] },
    'DEMO-BR1-R1': { cpu: [24, 49, 14], mem: [41, 4, 15], down: [246, 288], cpuUntilDown: true },
    'DEMO-BR2-R1': { cpu: [31, 62, 17], mem: [55, 5, 18], stopAt: 252 },
    'DEMO-BR2-AP1': { snmpOnly: true },
  };
  for (const d of devices) {
    const p = plan[d.host];
    if (!p) continue;
    const ping = [], snmp = [], cpu = [], mem = [];
    const rnd = mulberry32(d.host.length * 131 + 7);
    const stop = p.stopAt ?? 288;
    for (let k = 0; k < stop; k++) {
      if (p.gap && k >= p.gap[0] && k < p.gap[1]) { rnd(); continue; }
      const isDown = p.down && k >= p.down[0] && k < p.down[1];
      if (p.snmpOnly) { snmp.push({ t: at(k), v: 0 }); continue; }
      ping.push({ t: at(k), v: isDown ? 0 : 1 });
      if (!p.ping) {
        if (!isDown) {
          cpu.push({ t: at(k), v: Math.min(99, SHAPE(k, rnd, p.cpu[0] * 0.8 + (k === 132 ? p.cpu[1] - p.cpu[0] : 0))) });
          mem.push({ t: at(k), v: p.mem[0] + 3 * Math.sin(k / 40 + p.mem[2]) + rnd() });
        } else rnd(), rnd();
      }
    }
    out.series.ping[d.host] = ping; out.series.snmp[d.host] = snmp; out.series.cpu[d.host] = cpu; out.series.mem[d.host] = mem;
    const last = (a) => (a.length && a[a.length - 1].t >= win.endMs - 10 * 60e3 ? a[a.length - 1].v : null);
    out.fresh[d.host] = { ping: last(ping), snmp: p.snmpOnly ? last(snmp) : (last(ping) == null ? null : 1) };
    if (p.snmpOnly) out.fresh[d.host].ping = null;
    // peak value pinned to the design number so the demo text is predictable (bucket 132 = 11:00)
    if (p.cpu && !p.down) { const c = cpu.find((x) => x.t === at(132)); if (c) c.v = p.cpu[1]; }
    out.byHost[d.host] = { ping: ping.map((x) => x.v), cpu: cpu.map((x) => x.v), mem: mem.map((x) => x.v) };
  }
  return out;
}
