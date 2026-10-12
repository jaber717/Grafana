// Daily Network Health Report: page composition (A4 landscape).
//   page 1  Executive summary: KPIs, devices requiring attention, key observations, scope and completeness
//   page 2  Availability & load: the Grafana panels (availability timeline, availability by device, CPU, memory)
//   page 3+ Technical details: every device with state / availability / CPU / memory, methodology
import { esc, fmtPct, fmtClock } from './format.mjs';
import { kpi, table, page, img, document_, emptyRow } from './html.mjs';
import { STATE_LABEL } from './health-report.mjs';

export const HEALTH_SLOTS = {
  timeline: { panelId: 1, w: 273, h: 62 },
  avail: { panelId: 2, w: 88.5, h: 76 },
  cpu: { panelId: 3, w: 88.5, h: 76 },
  mem: { panelId: 4, w: 88.5, h: 76 },
};
export const HEALTH_FILE = (date) => `Daily-Network-Health-${date}.pdf`;
const FOOT = 'Source: Zabbix availability, CPU and memory items, charts rendered by Grafana (dashboard rpt-health-daily)';
const SUMMARY_FIRST = 9;
const SUMMARY_CONT = 16;

const CLS = { UP: 'ok', DOWN: 'crit', UNKNOWN: 'warn', NO_DATA: 'NO_DATA', NOT_MONITORED: 'NO_DATA' };
const pill = (state) => `<span class="st ${CLS[state]}">${esc(STATE_LABEL[state])}</span>`;
const st = (s) => `<span class="st ${s}">${s === 'NO_DATA' ? 'NO DATA' : s}</span>`;
const pct = (v, d = 0) => (v == null ? 'N/A' : `${v.toFixed(d)}%`);
const metric = (m, which) => (m == null ? 'not in scope' : !m.monitored ? 'N/A' : which === 'avg' ? pct(m.avg) : pct(m.peak));
const availCls = (a) => (a == null ? 'nodata' : a >= 99.9 ? 'ok' : a >= 99 ? 'warn' : 'crit');

function card(im, w, h, alt) {
  return `<div class="card" style="width:${w}mm;height:${h}mm">${im ? img(im, alt) : `<div class="cb">${emptyRow(`${alt}: panel image not available`)}</div>`}</div>`;
}
function noteCard(title, msg, w, h) {
  return `<div class="card" style="width:${w}mm;height:${h}mm"><div class="ch"><h3>${esc(title)}</h3></div><div class="cb">${emptyRow(msg)}</div></div>`;
}

export function buildHealthHtml(model, images = {}) {
  return model.status === 'NO_DATA' ? noDataHtml(model) : fullHtml(model, images);
}

const devCols = (m) => [
  { key: 'host', label: 'Device' }, { key: 'site', label: 'Site' }, { key: 'type', label: 'Type' },
  { label: 'State at end of day', fmt: (d) => pill(d.state) }, { label: 'Basis', fmt: (d) => esc(d.basis || '-') }, { label: 'Availability', align: 'r', fmt: (d) => esc(pct(d.availability, 2)) },
  { label: 'Down time', align: 'r', fmt: (d) => esc(d.availability == null ? 'N/A' : `${d.downMinutes} min`) }, { label: 'Coverage', align: 'r', fmt: (d) => esc(d.hasData ? pct(d.coverage * 100) : 'N/A') },
  ...(m.scope.metrics.includes('cpu') ? [{ label: 'CPU avg', align: 'r', fmt: (d) => esc(metric(d.cpu, 'avg')) }, { label: 'CPU peak', align: 'r', fmt: (d) => esc(metric(d.cpu, 'peak')) }] : []),
  ...(m.scope.metrics.includes('memory') ? [{ label: 'Memory avg', align: 'r', fmt: (d) => esc(metric(d.mem, 'avg')) }, { label: 'Memory peak', align: 'r', fmt: (d) => esc(metric(d.mem, 'peak')) }] : []),
];

function fullHtml(m, im) {
  const k = m.kpis, list = m.devices;
  const reporting = list.filter((d) => d.hasData).length;
  const extra = `${reporting} of ${list.length} devices reporting`;
  const notUp = k.down + k.unknown;
  const kp = `<div class="kpis" style="grid-template-columns:repeat(6,1fr)">
${kpi({ cls: 'neutral', label: 'Devices in scope', value: String(k.devices), sub: esc(m.scope.title) })}
${kpi({ cls: k.up === k.devices ? 'ok' : 'neutral', label: 'UP at end of day', value: String(k.up), sub: `${k.devices ? Math.round((100 * k.up) / k.devices) : 0}% of devices` })}
${kpi({ cls: k.down ? 'crit' : notUp ? 'warn' : 'ok', label: 'DOWN / UNKNOWN', value: `${k.down} / ${k.unknown}`, sub: k.down ? esc(m.devices.filter((d) => d.state === 'DOWN').map((d) => d.host).slice(0, 3).join(', ')) : 'none down' })}
${kpi({ cls: k.noData + k.notMonitored ? 'neutral' : 'ok', label: 'NO DATA / NOT MONITORED', value: `${k.noData} / ${k.notMonitored}`, sub: 'not the same as down' })}
${kpi({ cls: availCls(k.avgAvailability), label: 'Average availability', value: k.avgAvailability == null ? 'N/A' : fmtPct(k.avgAvailability, 2), sub: `${k.withOutage} device${k.withOutage === 1 ? '' : 's'} with down time` })}
${kpi({ cls: k.peakCpu?.value >= 90 ? 'warn' : 'in', label: 'Highest CPU peak', value: k.peakCpu ? pct(k.peakCpu.value) : 'N/A', sub: k.peakCpu ? `${esc(k.peakCpu.host)} at ${esc(fmtClock(k.peakCpu.at))}` : m.scope.metrics.includes('cpu') ? 'no CPU data' : 'CPU not in scope' })}
</div>`;
  const att = m.attention.slice(0, 5);
  const attTable = `<div class="sec" style="min-width:0"><h3>Devices requiring attention</h3>${att.length ? table([
    { key: 'host', label: 'Device' }, { label: 'State', fmt: (a) => pill(a.state) }, { label: 'Why', fmt: (a) => esc(a.reasons.join('; ')) },
  ], att) : `<div class="note" style="padding:2mm 0">No device needs attention: every device in scope was UP at the end of the day with no down time and no load alert.</div>`}${m.attention.length > 5 ? emptyRow(`+ ${m.attention.length - 5} more: see Technical Details`) : ''}</div>`;
  const RANK = { DOWN: 0, UNKNOWN: 1, NO_DATA: 2, NOT_MONITORED: 3, UP: 4 };
  const overview = [...list].sort((a, b) => RANK[a.state] - RANK[b.state] || a.host.localeCompare(b.host, undefined, { numeric: true })).slice(0, 10);
  const devTable = `<div class="sec" style="min-width:0"><h3>Device status at end of day</h3>${table([
    { key: 'host', label: 'Device' }, { key: 'site', label: 'Site' }, { label: 'State', fmt: (d) => pill(d.state) }, { label: 'Availability', align: 'r', fmt: (d) => esc(pct(d.availability, 2)) },
    ...(m.scope.metrics.includes('cpu') ? [{ label: 'CPU peak', align: 'r', fmt: (d) => esc(metric(d.cpu, 'peak')) }] : []), ...(m.scope.metrics.includes('memory') ? [{ label: 'Memory peak', align: 'r', fmt: (d) => esc(metric(d.mem, 'peak')) }] : []),
  ], overview)}${list.length > overview.length ? emptyRow(`+ ${list.length - overview.length} more devices: see Technical Details`) : ''}</div>`;
  const side = `<div style="display:flex;flex-direction:column;gap:4.5mm;width:88.5mm;min-height:0">
<div class="sec" style="flex:1 1 auto"><h3>Key observations</h3><ul class="obs">${m.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></div>
<div class="sec"><h3>Scope &amp; completeness</h3><table class="t"><tbody>
<tr><td>Scope</td><td class="r" title="${esc(m.scope.text)}">${esc(m.scope.title)}</td></tr>
<tr><td>Status</td><td class="r">${st(m.status)}</td></tr>
<tr><td>Devices reporting</td><td class="r">${reporting} / ${list.length}</td></tr>
<tr><td>Metrics</td><td class="r">${esc(m.scope.metrics.join(', '))}</td></tr></tbody></table></div></div>`;
  const p1 = page({ n: 1, total: 0, kicker: 'NOC · Network health', title: 'Daily Network Health Report', model: m, left: FOOT, extra, body: `${kp}<div style="display:flex;gap:4.5mm;min-height:0"><div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4.5mm">${attTable}${devTable}</div>${side}</div>` });

  const wantCpu = m.scope.metrics.includes('cpu'), wantMem = m.scope.metrics.includes('memory');
  const row = `<div style="display:flex;gap:4.5mm">${card(im.avail, 88.5, 76, 'Availability by device')}${wantCpu ? card(im.cpu, 88.5, 76, 'CPU utilisation') : noteCard('CPU utilisation', 'CPU is not part of the saved scope for this report.', 88.5, 76)}${wantMem ? card(im.mem, 88.5, 76, 'Memory utilisation') : noteCard('Memory utilisation', 'Memory is not part of the saved scope for this report.', 88.5, 76)}</div>`;
  const p2 = page({ n: 2, total: 0, kicker: 'NOC · Network health', title: 'Availability & Load', model: m, left: FOOT, extra, body: `${card(im.timeline, 273, 62, 'Availability timeline')}${row}` });

  const first = list.slice(0, SUMMARY_FIRST);
  const rest = list.slice(SUMMARY_FIRST);
  const contPages = Math.ceil(rest.length / SUMMARY_CONT);
  const notes = `<div class="sec"><h3>Data quality &amp; methodology</h3><ul class="obs note" style="gap:1.4mm">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  const pages = [p1, p2, page({ n: 3, total: 0, kicker: 'NOC · Network health', title: 'Technical Details', model: m, left: FOOT, extra, body: `<div class="sec"><h3>Devices</h3>${table(devCols(m), first)}</div>${notes}` })];
  for (let c = 0; c < contPages; c++) pages.push(page({ n: 4 + c, total: 0, kicker: 'NOC · Network health', title: 'Technical Details (continued)', model: m, left: FOOT, extra, body: `<div class="sec"><h3>Devices (continued)</h3>${table(devCols(m), rest.slice(c * SUMMARY_CONT, (c + 1) * SUMMARY_CONT))}</div>` }));
  const total = pages.length;
  return { html: document_({ title: `Daily Network Health ${m.window.date}`, pages: pages.map((p) => p.replace(/Page (\d+) of 0/, `Page $1 of ${total}`)) }), pages: total };
}

function noDataHtml(m) {
  const k = m.kpis, list = m.devices;
  const empty = list.length === 0;
  const body1 = `<div class="nodata"><div class="big">NO DATA</div><div class="sub">${empty ? 'The saved scope matches no monitored device' : `No availability data was received for ${esc(m.window.date)}`}</div>
<div class="exp">${empty ? 'Check the site / device type / device selection of the scope and the Zabbix host groups.' : 'Availability and load figures are intentionally not shown: a day without data is not the same as a healthy network, and silence is not proof that devices were up or down.'}</div></div>
<div class="kpis" style="grid-template-columns:repeat(4,1fr)">
${kpi({ cls: 'nodata', label: 'Devices in scope', value: String(k.devices), sub: esc(m.scope.title) })}
${kpi({ cls: 'nodata', label: 'Devices reporting', value: '0', sub: 'for the reporting day' })}
${kpi({ cls: 'nodata', label: 'NO DATA / NOT MONITORED', value: `${k.noData} / ${k.notMonitored}`, sub: 'state at the end of the day' })}
${kpi({ cls: 'nodata', label: 'Average availability', value: 'N/A', sub: 'not shown without data' })}</div>`;
  const p1 = page({ n: 1, total: 2, kicker: 'NOC · Network health', title: 'Daily Network Health Report', model: m, left: FOOT, body: body1, extra: `0 of ${list.length} devices reporting` });
  const t = `<div class="sec"><h3>Devices in scope</h3>${list.length ? table([{ key: 'host', label: 'Device' }, { key: 'site', label: 'Site' }, { key: 'type', label: 'Type' }, { label: 'State at end of day', fmt: (d) => pill(d.state) }], list.slice(0, 14)) : emptyRow('No device matches the scope.')}${list.length > 14 ? emptyRow(`+ ${list.length - 14} more`) : ''}</div>`;
  const notes = `<div class="sec"><h3>Data quality &amp; methodology</h3><ul class="obs note" style="gap:1.4mm">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  const p2 = page({ n: 2, total: 2, kicker: 'NOC · Network health', title: 'Technical Details', model: m, left: FOOT, body: `${t}${notes}`, extra: `0 of ${list.length} devices reporting` });
  return { html: document_({ title: `Daily Network Health ${m.window.date} (no data)`, pages: [p1, p2] }), pages: 2 };
}

