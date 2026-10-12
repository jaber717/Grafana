// Network Health report model (Report C). Same device-state semantics as the NOC "Device Health" dashboard, evaluated at the END of the
// reporting window, plus the day's availability and CPU / memory:
//
//   code = SEEN(1000 if any availability sample exists in the 8 days up to the window end) + PING(200 up / 100 down, last 10 min)
//          + SNMP(1 unknown / 2 available / 3 unavailable, last 10 min)
//   UP            ping up, or (no fresh ping) SNMP available            DOWN   ping down, or (no fresh ping) SNMP unavailable
//   UNKNOWN       no fresh ping, SNMP availability unknown               NO DATA  monitored but nothing in the last 10 minutes
//   NOT MONITORED no availability sample at all in 8 days
// A device that is reachable but has no CPU / memory data stays UP: those columns say "not monitored". Reachability comes from monitoring
// data only, never from NetFlow. Pure function: the same builder produces the operational and the DEMO report.
import { BUCKET_S, classify, expectedBuckets, MIN_COVERAGE } from './coverage.mjs';
import { fmtPct } from './format.mjs';

export const STATES = ['UP', 'DOWN', 'UNKNOWN', 'NO_DATA', 'NOT_MONITORED'];
export const STATE_LABEL = { UP: 'UP', DOWN: 'DOWN', UNKNOWN: 'UNKNOWN', NO_DATA: 'NO DATA', NOT_MONITORED: 'NOT MONITORED' };
const ATTENTION_RANK = { DOWN: 0, UNKNOWN: 1, NO_DATA: 2, NOT_MONITORED: 3, UP: 4 };
const SNMP_ENC ={ 0: 1, 1: 2, 2: 3 };                  // Zabbix: 0 unknown, 1 available, 2 unavailable

export function stateCode({ ping = null, snmp = null, seen = false }) {
  return (seen ? 1000 : 0) + (ping == null ? 0 : ping >= 0.5 ? 200 : 100) + (snmp == null ? 0 : SNMP_ENC[Math.round(snmp)] ?? 0);
}
export function stateOf(code) {
  if (code >= 1200) return 'UP';
  if (code >= 1100) return 'DOWN';
  if (code === 1002) return 'UP';
  if (code === 1003) return 'DOWN';
  if (code === 1001) return 'UNKNOWN';
  if (code === 1000) return 'NO_DATA';
  return 'NOT_MONITORED';
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const snap = (samples, win) => samples.map((s) => ({ t: win.startMs + Math.round((s.t - win.startMs) / (BUCKET_S * 1000)) * BUCKET_S * 1000, v: s.v })).filter((s) => s.v != null && s.t >= win.startMs && s.t < win.endMs);

function metricOf(samples, win) {
  const s = snap(samples || [], win);
  if (!s.length) return { monitored: false, avg: null, peak: null, peakAt: null, buckets: 0 };
  const peak = s.reduce((b, x) => (x.v > b.v ? x : b), s[0]);
  return { monitored: true, avg: mean(s.map((x) => x.v)), peak: peak.v, peakAt: peak.t, buckets: s.length };
}

function longestRun(flags) {
  let best = 0, run = 0;
  for (const f of flags) { run = f ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

function summarizeDevice(d, data, win, scope) {
  const { series, fresh, seen } = data;
  const ping = snap(series.ping?.[d.host] || [], win);
  const snmp = snap(series.snmp?.[d.host] || [], win);
  const hasAvail = ping.length + snmp.length > 0;
  const f = fresh[d.host] || {};
  const code = stateCode({ ping: f.ping ?? null, snmp: f.snmp ?? null, seen: seen.has(d.host) || hasAvail });
  const state = stateOf(code);
  // availability = share of ICMP samples that were up. A device without an ICMP item falls back to SNMP availability (1 = up, 2 = down);
  // SNMP "unknown" (0) carries no information, so those intervals are left out instead of being counted as down.
  const basisT = ping.length ? ping.map((x) => ({ t: x.t, up: x.v >= 0.5 })) : snmp.filter((x) => x.v === 1 || x.v === 2).map((x) => ({ t: x.t, up: x.v === 1 }));
  const availability = basisT.length ? Math.round(mean(basisT.map((x) => (x.up ? 1 : 0))) * 10000) / 100 : null;
  const grid = new Map(basisT.map((x) => [x.t, x.up]));
  const n = expectedBuckets(win.seconds);
  const downFlags = [];
  for (let k = 0; k < n; k++) downFlags.push(grid.get(win.startMs + k * BUCKET_S * 1000) === false);
  const downMinutes = downFlags.filter(Boolean).length * (BUCKET_S / 60);
  const coverage = n ? Math.min(1, basisT.length / n) : 0;
  const cpu = scope.metrics.includes('cpu') ? metricOf(series.cpu?.[d.host], win) : null;
  const mem = scope.metrics.includes('memory') ? metricOf(series.mem?.[d.host], win) : null;
  return {
    host: d.host, site: d.sites.join(', ') || '-', type: d.types.join(', ') || '-', state, code, availability, downMinutes, longestDownMinutes: longestRun(downFlags) * (BUCKET_S / 60),
    coverage, hasData: hasAvail, cpu, mem, icmp: ping.length > 0, snmp: snmp.length > 0,
  };
}

export function buildHealthModel({ win, scope, devices, series, fresh = {}, seen = new Set(), nowMs = Date.now(), demo = false, scopeText = '' }) {
  const list = devices.map((d) => summarizeDevice(d, { series, fresh, seen }, win, scope));
  const reporting = list.filter((d) => d.hasData);
  const lastSample = Math.max(0, ...devices.flatMap((d) => ['ping', 'snmp'].flatMap((k) => (series[k]?.[d.host] || []).map((s) => s.t))));
  const maxBuckets = Math.max(0, ...reporting.map((d) => Math.round(d.coverage * expectedBuckets(win.seconds))));
  const cov = classify({ windowSeconds: win.seconds, observedBuckets: maxBuckets, lastSampleMs: lastSample || null, nowMs });
  const everyoneComplete = reporting.length > 0 && reporting.every((d) => d.coverage >= MIN_COVERAGE) && !list.some((d) => d.state === 'NO_DATA');
  const status = reporting.length === 0 ? 'NO_DATA' : everyoneComplete ? 'COMPLETE' : 'PARTIAL';
  const count = (s) => list.filter((d) => d.state === s).length;
  const model = {
    kind: 'health', window: win, demo, status, coverage: { ...cov, status }, generatedAt: nowMs, scope: { id: scope.id, title: scope.title, text: scopeText, metrics: scope.metrics },
    devices: list, kpis: null, attention: [], observations: [], notes: [],
  };
  model.notes.push('Device state is evaluated at the end of the reporting day from monitoring data only (ICMP ping and SNMP availability reported to Zabbix); NetFlow traffic is never used to decide whether a device is up.');
  model.notes.push('UP / DOWN need a sample in the last 10 minutes of the day. NO DATA = monitored but silent at the end of the day (a stale collection, not proof of an outage). NOT MONITORED = no availability sample in the previous 8 days.');
  model.notes.push('A device that answers ping but has no CPU or memory item stays UP: those columns show N/A (not monitored). Nothing is invented for missing metrics.');
  model.notes.push('Availability = share of 5-minute ICMP intervals that were up (SNMP availability when a device has no ICMP item). Down time counts intervals below 50 % up. CPU and memory are 5-minute averages; a device with several CPU items shows its busiest one.');
  if (status === 'NO_DATA') {
    model.kpis = { devices: list.length, up: 0, down: 0, unknown: count('UNKNOWN'), noData: count('NO_DATA'), notMonitored: count('NOT_MONITORED') };
    model.observations.push(list.length
      ? 'No availability data was received from any device in scope for this reporting day. No availability or load figures are shown, and absence of data is not reported as a healthy network.'
      : `The saved scope${scopeText ? ` (${scopeText})` : ''} matches no monitored device, so there is nothing to report. Check the site / device type / device selection and the Zabbix host groups.`);
    return model;
  }
  const avail = reporting.filter((d) => d.availability != null);
  const peak = (key) => list.filter((d) => d[key]?.monitored).sort((a, b) => b[key].peak - a[key].peak)[0];
  const pc = peak('cpu'), pm = peak('mem');
  model.kpis = {
    devices: list.length, up: count('UP'), down: count('DOWN'), unknown: count('UNKNOWN'), noData: count('NO_DATA'), notMonitored: count('NOT_MONITORED'),
    avgAvailability: avail.length ? Math.round(mean(avail.map((d) => d.availability)) * 100) / 100 : null,
    withOutage: list.filter((d) => d.downMinutes > 0).length, longestOutage: list.reduce((m, d) => Math.max(m, d.longestDownMinutes), 0),
    peakCpu: pc ? { host: pc.host, value: pc.cpu.peak, at: pc.cpu.peakAt } : null, peakMem: pm ? { host: pm.host, value: pm.mem.peak, at: pm.mem.peakAt } : null,
  };
  const k = model.kpis;
  const why = (d) => {
    const w = [];
    if (d.state === 'DOWN') w.push('down at the end of the day');
    if (d.state === 'UNKNOWN') w.push('availability unknown at the end of the day');
    if (d.state === 'NO_DATA') w.push('no data in the last 10 minutes of the day');
    if (d.state === 'NOT_MONITORED') w.push('no availability monitoring');
    if (d.downMinutes > 0 && d.state !== 'DOWN') w.push(`${d.downMinutes} min down (longest ${d.longestDownMinutes} min)`);
    if (d.cpu?.monitored && d.cpu.peak >= 90) w.push(`CPU peaked at ${Math.round(d.cpu.peak)} %`);
    if (d.mem?.monitored && d.mem.peak >= 90) w.push(`memory peaked at ${Math.round(d.mem.peak)} %`);
    if (d.hasData && d.coverage < MIN_COVERAGE) w.push(`coverage ${Math.round(d.coverage * 100)} %`);
    return w;
  };
  model.attention = list.map((d) => ({ host: d.host, state: d.state, reasons: why(d) })).filter((a) => a.reasons.length)
    .sort((a, b) => ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state] || a.host.localeCompare(b.host, undefined, { numeric: true }));
  model.observations.push(`${k.up} of ${k.devices} devices were UP at the end of the day${k.down ? `, ${k.down} DOWN` : ''}${k.unknown ? `, ${k.unknown} UNKNOWN` : ''}${k.noData ? `, ${k.noData} with NO DATA` : ''}${k.notMonitored ? `, ${k.notMonitored} NOT MONITORED` : ''}.`);
  model.observations.push(k.avgAvailability == null ? 'No device reported availability.' : `Average availability of the ${avail.length} reporting device${avail.length === 1 ? '' : 's'} was ${fmtPct(k.avgAvailability, 2)}; ${k.withOutage} device${k.withOutage === 1 ? '' : 's'} had down time (longest ${k.longestOutage} min).`);
  if (pc) model.observations.push(`Highest CPU peak: ${pc.host} at ${Math.round(pc.cpu.peak)} %${pm ? `; highest memory peak: ${pm.host} at ${Math.round(pm.mem.peak)} %` : ''} (5-minute averages).`);
  const noLoad = list.filter((d) => d.state === 'UP' && ((scope.metrics.includes('cpu') && !d.cpu?.monitored) || (scope.metrics.includes('memory') && !d.mem?.monitored)));
  if (noLoad.length) model.observations.push(`${noLoad.length} device${noLoad.length === 1 ? ' is' : 's are'} reachable but ${noLoad.length === 1 ? 'has' : 'have'} no CPU or memory data (${noLoad.slice(0, 4).map((d) => d.host).join(', ')}${noLoad.length > 4 ? ', …' : ''}); they are not counted as down.`);
  if (status === 'PARTIAL') model.observations.push('Some devices have incomplete data for the day: their availability figures cover only the intervals that were collected (see Technical Details).');
  return model;
}
