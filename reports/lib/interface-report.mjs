// Interface report model. series: {<interface key>: {inbound:[{t,bps}], outbound:[{t,bps}]}} for the reporting day, prevSeries for the
// day before (only used for volume comparison). Same builder for live and DEMO data.
import { summarizeRates, nonOverlappingTotal } from './interface-math.mjs';
import { BUCKET_S, classify, expectedBuckets, MIN_COVERAGE } from './coverage.mjs';
import { changePct } from './netflow-math.mjs';
import { fmtBytes, fmtBps, fmtPct, fmtChange, fmtClock } from './format.mjs';

function missingRuns(samples, win) {
  const have = new Set(samples.map((s) => s.t));
  const runs = [];
  let start = null;
  const n = expectedBuckets(win.seconds);
  for (let k = 0; k <= n; k++) {
    const t = win.startMs + k * BUCKET_S * 1000;
    const missing = k < n && !have.has(t);
    if (missing && start == null) start = t;
    if (!missing && start != null) { runs.push({ from: start, to: t, minutes: (t - start) / 60000 }); start = null; }
  }
  return runs;
}

// Snap samples to the 5-minute grid of the window so that buckets from different series line up.
const snap = (samples, win) => samples.map((s) => ({ t: win.startMs + Math.round((s.t - win.startMs) / (BUCKET_S * 1000)) * BUCKET_S * 1000, bps: s.bps })).filter((s) => s.t >= win.startMs && s.t < win.endMs);

function summarizeIface(it, ser, win) {
  const inS = snap(ser?.inbound || [], win);
  const outS = snap(ser?.outbound || [], win);
  const a = { speedBps: it.speedBps, expectedS: win.seconds, stepS: BUCKET_S };
  const inbound = summarizeRates(inS, a);
  const outbound = summarizeRates(outS, a);
  const any = inbound.buckets + outbound.buckets > 0;
  const cov = any ? Math.min(inbound.coverage ?? 0, outbound.coverage ?? 0) : 0;
  const status = !any ? 'NO_DATA' : cov >= MIN_COVERAGE ? 'COMPLETE' : 'PARTIAL';
  const runsIn = missingRuns(inS, win), runsOut = missingRuns(outS, win);
  const worst = (runs) => runs.reduce((m, r) => Math.max(m, r.minutes), 0);
  const peakBps = Math.max(inbound.peakBps ?? -1, outbound.peakBps ?? -1);
  return {
    key: it.key, site: it.site, device: it.device, interface: it.interface, description: it.description, group: it.group, boundary: it.boundary, speedBps: it.speedBps,
    inbound, outbound, status, coverage: cov, inSamples: inS, outSamples: outS,
    peakBps: peakBps >= 0 ? peakBps : null,
    peakUtilPct: it.speedBps && peakBps >= 0 ? Math.round((peakBps / it.speedBps) * 1000) / 10 : null,
    missingMinutes: Math.max(0, Math.round((1 - cov) * (win.seconds / 60))),
    longestGapMinutes: Math.max(worst(runsIn), worst(runsOut)),
    anomalies: inbound.anomalies + outbound.anomalies,
  };
}

// Totals only inside a boundary and only over buckets where EVERY member reported (a partly missing sum is not a total).
function boundaryTotal(cfgIfaces, summaries, win) {
  nonOverlappingTotal(cfgIfaces.map((i) => ({ key: i.key, overlapsWith: [], summary: {} })));
  const sums = cfgIfaces.map((i) => summaries.get(i.key));
  const common = (dir) => {
    const maps = sums.map((s) => new Map((dir === 'in' ? s.inSamples : s.outSamples).map((x) => [x.t, x.bps])));
    return [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).map((t) => ({ t, bps: maps.reduce((a, m) => a + m.get(t), 0) }));
  };
  const speed = cfgIfaces.every((i) => i.speedBps) ? cfgIfaces.reduce((a, i) => a + i.speedBps, 0) : null;
  const a = { speedBps: null, expectedS: win.seconds, stepS: BUCKET_S };
  const inbound = summarizeRates(common('in'), a);
  const outbound = summarizeRates(common('out'), a);
  const peak = Math.max(inbound.peakBps ?? -1, outbound.peakBps ?? -1);
  return { inbound, outbound, speedBps: speed, peakUtilPct: speed && peak >= 0 ? Math.round((peak / speed) * 1000) / 10 : null, coverage: Math.min(inbound.coverage ?? 0, outbound.coverage ?? 0) };
}

export function buildInterfaceModel({ win, cfg, series, prevSeries = {}, prevWin = null, nowMs = Date.now(), demo = false }) {
  const summaries = new Map(cfg.interfaces.map((it) => [it.key, summarizeIface(it, series[it.key], win)]));
  const list = cfg.interfaces.map((it) => summaries.get(it.key));
  const reporting = list.filter((s) => s.status !== 'NO_DATA');
  const status = !reporting.length ? 'NO_DATA' : list.every((s) => s.status === 'COMPLETE') ? 'COMPLETE' : 'PARTIAL';
  const model = { kind: 'interface', window: win, demo, status, generatedAt: nowMs, interfaces: list, groups: cfg.groups, boundaries: [], kpis: null, observations: [], notes: [], missing: [], excluded: cfg.excluded.map((e) => e.key) };
  model.notes.push('Rates come from the Zabbix interface items (Bits received / Bits sent), already converted from SNMP counters by Zabbix; a counter reset appears as a missing sample, never as zero or as a spike.');
  model.notes.push('Averages use the time actually covered by samples; coverage shows how much of the day that is. Utilisation = rate / configured interface speed and is N/A when no speed is configured.');
  model.notes.push('Samples above the configured interface speed (+5 %) are excluded as anomalies and counted in the data-quality table - they usually mean a wrong speed setting.');
  model.notes.push('Totals are shown only for explicitly configured boundaries and only over intervals where all member interfaces reported. Interfaces are never added together otherwise.');
  const cov = classify({ windowSeconds: win.seconds, observedBuckets: Math.round(list.reduce((m, s) => Math.max(m, s.coverage), 0) * expectedBuckets(win.seconds)), lastSampleMs: null, nowMs });
  model.coverage = { ...cov, status };
  if (status === 'NO_DATA') {
    model.observations.push('No interface samples were received for this reporting day. No traffic or utilisation figures are shown, and absence of data is not reported as zero traffic.');
    model.missing = list.map((s) => ({ key: s.key, reason: 'no samples' }));
    return model;
  }
  // boundaries
  for (const b of cfg.boundaries) {
    const members = cfg.interfaces.filter((i) => i.boundary === b);
    if (members.some((m) => summaries.get(m.key).status === 'NO_DATA')) { model.boundaries.push({ boundary: b, members: members.map((m) => m.key), total: null, reason: 'a member interface has no data' }); continue; }
    model.boundaries.push({ boundary: b, members: members.map((m) => m.key), site: members[0].site, total: boundaryTotal(members, summaries, win) });
  }
  const sum = (f) => reporting.reduce((a, s) => a + (f(s) || 0), 0);
  model.kpis = {
    interfacesIncluded: list.length, interfacesReporting: reporting.length, interfacesPartial: list.filter((s) => s.status === 'PARTIAL').length,
    // volume across reported interfaces: shown as "sum of listed interfaces" only when none overlap (the loader refuses overlaps in a boundary)
    inboundBytes: sum((s) => s.inbound.bytes), outboundBytes: sum((s) => s.outbound.bytes),
    busiest: [...reporting].filter((s) => s.peakBps != null).sort((a, b) => (b.peakUtilPct ?? -1) - (a.peakUtilPct ?? -1) || b.peakBps - a.peakBps).slice(0, 10).map((s) => s.key),
  };
  // previous day
  const prevBytes = (key) => { const p = prevSeries[key]; if (!p || !prevWin) return null; const a = { speedBps: cfg.interfaces.find((i) => i.key === key).speedBps, expectedS: prevWin.seconds, stepS: BUCKET_S };
    const i = summarizeRates(snap(p.inbound || [], prevWin), a), o = summarizeRates(snap(p.outbound || [], prevWin), a); return (i.bytes == null && o.bytes == null) ? null : { in: i.bytes, out: o.bytes }; };
  for (const s of list) { const p = prevBytes(s.key); s.change = p ? { inbound: changePct(s.inbound.bytes, p.in), outbound: changePct(s.outbound.bytes, p.out) } : { inbound: null, outbound: null }; }
  // missing-data indicators
  for (const s of list) {
    if (s.status === 'NO_DATA') model.missing.push({ key: s.key, reason: 'no samples for the whole day' });
    else if (s.status === 'PARTIAL') model.missing.push({ key: s.key, reason: `${fmtPct(s.coverage * 100, 0)} coverage - ${s.missingMinutes} min missing, longest gap ${s.longestGapMinutes} min` });
  }
  // observations (facts only)
  const top = model.kpis.busiest[0] && summaries.get(model.kpis.busiest[0]);
  model.observations.push(`${model.kpis.interfacesReporting} of ${model.kpis.interfacesIncluded} configured interfaces reported data; ${model.kpis.interfacesPartial} with incomplete coverage.`);
  if (top) model.observations.push(`Busiest interface: ${top.site} ${top.interface} peaked at ${fmtBps(top.peakBps)}${top.peakUtilPct != null ? ` (${fmtPct(top.peakUtilPct)} of ${fmtBps(top.speedBps)})` : ' (utilisation N/A: no interface speed configured)'}.`);
  const hot = list.filter((s) => s.peakUtilPct != null && s.peakUtilPct >= 80);
  if (hot.length) model.observations.push(`${hot.length} interface(s) exceeded 80 % utilisation at peak: ${hot.map((h) => `${h.site} ${h.interface} ${fmtPct(h.peakUtilPct)}`).join(', ')}.`);
  const chg = list.filter((s) => s.change?.inbound != null || s.change?.outbound != null);
  if (!chg.length) model.observations.push('No previous-day data is available, so no comparison is shown.');
  const an = list.reduce((a, s) => a + s.anomalies, 0);
  if (an) model.observations.push(`${an} sample(s) above the configured speed were excluded - check the interface speed configuration.`);
  if (model.status === 'PARTIAL') model.observations.push('Some interfaces have incomplete data: their volumes understate real traffic (see Technical Details).');
  return model;
}
