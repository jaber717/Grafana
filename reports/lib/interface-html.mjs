// Daily Interface Traffic Report: page composition.
//   page 1  Executive summary: KPIs (no grand total across interfaces - totals exist only per configured boundary), site overview, observations
//   page 2+ Traffic analysis: one Grafana panel per interface (6 per page)
//   page n  Technical details: interface summary, busiest interfaces, missing-data indicators, methodology
import { esc, fmtBytes, fmtBps, fmtPct, fmtChange, fmtClock, fmtDateTime } from './format.mjs';
import { kpi, table, page, img, document_, emptyRow } from './html.mjs';
import { interfacePanelId } from './dashboards.mjs';

// Panel size adapts to the number of interfaces so a small estate does not leave a mostly empty page: 1-2 interfaces get full-width panels,
// 3-4 a 2x2 grid, more a 2x3 grid. The renderer renders each panel at exactly this size (see generate.mjs), so there is no scaling.
export const slotFor = (n) => (n <= 2 ? { w: 273, h: 66, cols: 1, perPage: 2 } : n <= 4 ? { w: 134.25, h: 68, cols: 2, perPage: 4 } : { w: 134.25, h: 42, cols: 2, perPage: 6 });
const linkText = (n) => `${n} ${n === 1 ? 'link' : 'links'}`;
export const UTIL_SLOT = { panelId: 2, w: 180, h: 54 };
const SUMMARY_FIRST = 9;
const SUMMARY_CONT = 16;
export const INTERFACE_FILE = (date) => `Daily-Interface-Traffic-${date}.pdf`;
const FOOT = 'Source: Zabbix interface items, charts rendered by Grafana (dashboard rpt-interface-daily)';

const utilColor = (p) => (p == null ? '#8A94A3' : p >= 90 ? '#C53030' : p >= 70 ? '#D98E04' : '#2F6EBA');
const gauge = (p) => (p == null ? '<span class="note">N/A</span>' : `<span class="gauge"><i style="width:${Math.min(100, p)}%;background:${utilColor(p)}"></i></span> ${esc(fmtPct(p))}`);
const st = (s) => `<span class="st ${s}">${s === 'NO_DATA' ? 'NO DATA' : s}</span>`;
const covPct = (c) => (c == null ? 'N/A' : `${Math.round(c * 100)}%`);
const speed = (s) => (s ? fmtBps(s) : 'not set');

function pageCard(s, png, slot) {
  const cap = `<div style="display:flex;justify-content:space-between;align-items:center;padding:0 3.4mm;height:6mm;border-top:.2mm solid var(--line);font-size:7.2pt;color:var(--mut)">
<span>Link speed <b style="color:var(--ink);font-weight:500">${esc(speed(s.speedBps))}</b> &nbsp;·&nbsp; peak <b style="color:var(--ink);font-weight:500">${esc(fmtBps(s.peakBps))}</b> ${s.peakUtilPct != null ? `(${esc(fmtPct(s.peakUtilPct))})` : '(utilisation N/A)'}</span><span>${esc(covPct(s.coverage))} coverage &nbsp;${st(s.status)}</span></div>`;
  const body = s.status === 'NO_DATA'
    ? `<div class="nodata" style="margin:2mm;border-radius:2mm;height:${slot.h - 4}mm"><div class="sub" style="font-size:12pt">NO DATA</div><div class="exp" style="font-size:7.5pt">${esc(s.site)} ${esc(s.interface)}: no samples for this day</div></div>`
    : `<div style="height:${slot.h}mm">${png ? img(png, `${s.site} ${s.interface}`) : emptyRow('panel image not available')}</div>`;
  return `<div class="card" style="width:${slot.w}mm;height:${slot.h + 6}mm;display:flex;flex-direction:column">${body}${cap}</div>`;
}

export function buildInterfaceHtml(model, images = {}) {
  return model.status === 'NO_DATA' ? noDataHtml(model) : fullHtml(model, images);
}

function overviewRows(m) {
  const rows = [];
  const inBoundary = new Set();
  for (const b of m.boundaries) {
    b.members.forEach((k) => inBoundary.add(k));
    const t = b.total;
    rows.push(t
      ? { site: b.site, scope: `${b.boundary} (${linkText(b.members.length)})`, inB: t.inbound.bytes, outB: t.outbound.bytes, avgIn: t.inbound.avgBps, avgOut: t.outbound.avgBps, util: t.peakUtilPct, cov: t.coverage, status: t.coverage >= 0.95 ? 'COMPLETE' : t.coverage > 0 ? 'PARTIAL' : 'NO_DATA' }
      : { site: b.site || '-', scope: `${b.boundary} (${linkText(b.members.length)})`, inB: null, outB: null, avgIn: null, avgOut: null, util: null, cov: 0, status: 'NO_DATA' });
  }
  for (const s of m.interfaces) if (!inBoundary.has(s.key)) rows.push({ site: s.site, scope: `${s.interface}${s.description ? ` · ${s.description}` : ''}`, inB: s.inbound.bytes, outB: s.outbound.bytes, avgIn: s.inbound.avgBps, avgOut: s.outbound.avgBps, util: s.peakUtilPct, cov: s.coverage, status: s.status });
  return rows;
}

function fullHtml(m, im) {
  const list = m.interfaces;
  const slot = slotFor(list.length);
  const panelPages = Math.ceil(list.length / slot.perPage);
  const summaryRest = Math.max(0, list.length - SUMMARY_FIRST);
  const techPages = 1 + Math.ceil(summaryRest / SUMMARY_CONT);
  const total = 1 + panelPages + techPages;
  const k = m.kpis;
  const top = m.interfaces.find((s) => s.key === k.busiest[0]);
  const hot = list.filter((s) => s.peakUtilPct != null && s.peakUtilPct >= 80);
  const complete = list.filter((s) => s.status === 'COMPLETE').length;
  const kp = `<div class="kpis" style="grid-template-columns:repeat(5,1fr)">
${kpi({ cls: 'neutral', label: 'Interfaces reporting', value: `${k.interfacesReporting} / ${k.interfacesIncluded}`, sub: k.interfacesPartial ? `${k.interfacesPartial} with incomplete coverage` : 'all with full coverage' })}
${kpi({ cls: top?.peakUtilPct >= 80 ? 'warn' : 'in', label: 'Highest peak utilisation', value: top?.peakUtilPct != null ? fmtPct(top.peakUtilPct) : 'N/A', sub: top ? `${esc(top.site)} ${esc(top.interface)}` : 'no interface with a configured speed' })}
${kpi({ cls: 'in', label: 'Highest peak rate', value: top ? fmtBps(top.peakBps) : 'N/A', sub: top ? `at ${esc(fmtClock([...top.inSamples, ...top.outSamples].sort((a, b) => b.bps - a.bps)[0]?.t))} · 5-min average` : '' })}
${kpi({ cls: hot.length ? 'warn' : 'ok', label: 'Interfaces over 80% at peak', value: String(hot.length), sub: hot.length ? esc(hot.map((h) => `${h.site} ${h.interface}`).join(', ')) : 'none' })}
${kpi({ cls: m.status === 'COMPLETE' ? 'ok' : 'warn', label: 'Data completeness', value: `${complete} / ${list.length}`, sub: 'interfaces with ≥ 95% coverage' })}
</div>`;
  const rows = overviewRows(m).slice(0, 8);
  const ov = `<div class="sec" style="flex:1 1 auto;min-width:0"><h3>Site overview</h3>${table([
    { key: 'site', label: 'Site' }, { key: 'scope', label: 'Link / boundary' },
    { label: 'Inbound', align: 'r', fmt: (r) => esc(fmtBytes(r.inB)) }, { label: 'Outbound', align: 'r', fmt: (r) => esc(fmtBytes(r.outB)) },
    { label: 'Avg in', align: 'r', fmt: (r) => esc(fmtBps(r.avgIn)) }, { label: 'Avg out', align: 'r', fmt: (r) => esc(fmtBps(r.avgOut)) },
    { label: 'Peak util.', align: 'r', fmt: (r) => esc(fmtPct(r.util)) }, { label: 'Coverage', align: 'r', fmt: (r) => esc(covPct(r.cov)) }, { label: 'Status', fmt: (r) => st(r.status) },
  ], rows)}${overviewRows(m).length > 8 ? emptyRow(`+ ${overviewRows(m).length - 8} more rows: see Technical Details`) : ''}
<div class="note" style="margin-top:2mm">Volumes are shown per interface, or as a total only for a configured boundary. Interfaces are never added together across boundaries.</div></div>`;
  const side = `<div style="display:flex;flex-direction:column;gap:4.5mm;width:88.5mm;min-height:0"><div class="sec" style="flex:1 1 auto"><h3>Key observations</h3><ul class="obs">${m.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></div></div>`;
  const utilCard = list.some((s) => s.speedBps)
    ? `<div class="card" style="width:180mm;height:${UTIL_SLOT.h}mm">${im.__util ? img(im.__util, 'Peak utilisation by interface') : emptyRow('panel image not available')}</div>`
    : `<div class="card" style="width:180mm;height:${UTIL_SLOT.h}mm"><div class="ch"><h3>Peak utilisation by interface</h3></div><div class="cb">${emptyRow('No interface has a configured speed, so utilisation cannot be calculated.')}</div></div>`;
  const anomalies = list.reduce((a, s) => a + s.anomalies, 0);
  const coll = `<div class="sec" style="width:88.5mm"><h3>Collection &amp; completeness</h3><table class="t"><tbody>
<tr><td>Status</td><td class="r">${st(m.status)}</td></tr>
${m.scope && m.scope.id !== 'all' ? `<tr><td>Scope</td><td class="r" title="${esc(m.scope.text)}">${esc(m.scope.title)}</td></tr>` : ''}
<tr><td>Interfaces reporting</td><td class="r">${k.interfacesReporting} / ${k.interfacesIncluded}</td></tr>
<tr><td>Complete (≥ 95%)</td><td class="r">${complete} / ${list.length}</td></tr>
<tr><td>Excluded by configuration</td><td class="r">${m.excluded.length}</td></tr>
<tr><td>Samples excluded (over speed)</td><td class="r">${anomalies}</td></tr></tbody></table></div>`;
  const p1 = page({ n: 1, total, kicker: 'NOC · Interface traffic', title: 'Daily Interface Traffic Report', model: m, left: FOOT, extra: `Data coverage ${complete}/${list.length} interfaces complete`, body: `${kp}<div style="display:flex;gap:4.5mm;min-height:0">${ov}${side}</div><div style="display:flex;gap:4.5mm;min-height:0">${utilCard}${coll}</div>` });

  const pages = [p1];
  for (let pn = 0; pn < panelPages; pn++) {
    const chunk = list.slice(pn * slot.perPage, pn * slot.perPage + slot.perPage);
    const cards = chunk.map((s) => pageCard(s, im[s.key], slot));
    const rowsHtml = [];
    for (let i = 0; i < cards.length; i += slot.cols) rowsHtml.push(`<div style="display:flex;gap:4.5mm">${cards.slice(i, i + slot.cols).join('')}</div>`);
    pages.push(page({ n: 2 + pn, total, kicker: 'NOC · Interface traffic', title: `Traffic Analysis${panelPages > 1 ? ` (${pn + 1}/${panelPages})` : ''}`, model: m, left: FOOT, extra: `Data coverage ${complete}/${list.length} interfaces complete`, body: `<div style="display:flex;flex-direction:column;gap:3.6mm">${rowsHtml.join('')}</div>` }));
  }

  const sumCols = [
    { key: 'site', label: 'Site' }, { key: 'interface', label: 'Interface', title: (s) => `device ${s.device}` }, { label: 'Speed', align: 'r', fmt: (s) => esc(speed(s.speedBps)) },
    { label: 'In volume', align: 'r', fmt: (s) => esc(fmtBytes(s.inbound.bytes)) }, { label: 'Out volume', align: 'r', fmt: (s) => esc(fmtBytes(s.outbound.bytes)) },
    { label: 'Avg in', align: 'r', fmt: (s) => esc(fmtBps(s.inbound.avgBps)) }, { label: 'Avg out', align: 'r', fmt: (s) => esc(fmtBps(s.outbound.avgBps)) },
    { label: 'Peak in', align: 'r', fmt: (s) => esc(fmtBps(s.inbound.peakBps)) }, { label: 'Peak out', align: 'r', fmt: (s) => esc(fmtBps(s.outbound.peakBps)) },
    { label: 'Peak util.', align: 'r', fmt: (s) => gauge(s.peakUtilPct) },
    { label: 'Δ in', align: 'r', fmt: (s) => esc(fmtChange(s.change?.inbound)) }, { label: 'Δ out', align: 'r', fmt: (s) => esc(fmtChange(s.change?.outbound)) },
    { label: 'Cov.', align: 'r', fmt: (s) => esc(covPct(s.coverage)) }, { label: 'Status', fmt: (s) => st(s.status) },
  ];
  const first = list.slice(0, SUMMARY_FIRST);
  const busiest = k.busiest.map((key) => list.find((s) => s.key === key));
  const busTable = `<div class="sec"><h3>Top 10 busiest interfaces (by peak utilisation)</h3>${busiest.length ? table([
    { label: 'Interface', fmt: (s) => `${esc(s.site)} ${esc(s.interface)}` }, { label: 'Peak rate', align: 'r', fmt: (s) => esc(fmtBps(s.peakBps)) }, { label: 'Peak utilisation', fmt: (s) => gauge(s.peakUtilPct) },
  ], busiest, { index: true }) : emptyRow('No interface data')}</div>`;
  const missingTable = `<div class="sec"><h3>Missing-data indicators</h3>${m.missing.length ? table([
    { label: 'Interface', fmt: (r) => esc(r.key.replace(/^[^:]*:/, '') + ' · ' + r.key.split(':')[0]) }, { label: 'Coverage', align: 'r', fmt: (r) => esc(r.coverage == null ? '0%' : covPct(r.coverage)) }, { label: 'Missing', align: 'r', fmt: (r) => (r.missingMinutes == null ? (r.reason || 'whole day') : `${r.missingMinutes} min`) }, { label: 'Longest gap', align: 'r', fmt: (r) => (r.longestGapMinutes == null ? '-' : `${r.longestGapMinutes} min`) },
  ], m.missing.slice(0, 8)) : `<div class="note" style="padding:2mm 0">All ${list.length} interfaces reported with at least 95% coverage.</div>`}${m.missing.length > 8 ? emptyRow(`+ ${m.missing.length - 8} more`) : ''}
<div class="note" style="margin-top:1.5mm">Excluded interfaces (not reported): ${m.excluded.length ? esc(m.excluded.join(', ')) : 'none'}.</div></div>`;
  const notes = `<div class="sec"><h3>Data quality &amp; methodology</h3><ul class="obs note" style="gap:1.4mm">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  pages.push(page({ n: 2 + panelPages, total, kicker: 'NOC · Interface traffic', title: 'Technical Details', model: m, left: FOOT, extra: `Data coverage ${complete}/${list.length} interfaces complete`,
    body: `<div class="sec"><h3>Interface summary</h3>${table(sumCols, first)}</div><div class="cols" style="grid-template-columns:repeat(3,1fr)">${busTable}${missingTable}${notes}</div>` }));
  for (let c = 0; c < techPages - 1; c++) {
    const part = list.slice(SUMMARY_FIRST + c * SUMMARY_CONT, SUMMARY_FIRST + (c + 1) * SUMMARY_CONT);
    pages.push(page({ n: 3 + panelPages + c, total, kicker: 'NOC · Interface traffic', title: 'Technical Details (continued)', model: m, left: FOOT, extra: `Data coverage ${complete}/${list.length} interfaces complete`, body: `<div class="sec"><h3>Interface summary (continued)</h3>${table(sumCols, part)}</div>` }));
  }
  return { html: document_({ title: `Daily Interface Traffic ${m.window.date}`, pages }), pages: total };
}

function noDataHtml(m) {
  const total = 2;
  const list = m.interfaces;
  const body1 = `<div class="nodata"><div class="big">NO DATA</div><div class="sub">No interface samples were received for ${esc(m.window.date)}</div>
<div class="exp">Traffic and utilisation figures are intentionally not shown: a day without data is not the same as a day with zero traffic.</div></div>
<div class="kpis" style="grid-template-columns:repeat(3,1fr)">
${kpi({ cls: 'nodata', label: 'Interfaces configured', value: String(list.length), sub: 'selected in the interface configuration' })}
${kpi({ cls: 'nodata', label: 'Interfaces reporting', value: '0', sub: 'for the reporting day' })}
${kpi({ cls: 'nodata', label: 'Previous-day comparison', value: 'N/A', sub: 'not shown without data' })}</div>`;
  const p1 = page({ n: 1, total, kicker: 'NOC · Interface traffic', title: 'Daily Interface Traffic Report', model: m, left: FOOT, body: body1, extra: `0 of ${list.length} interfaces reporting` });
  const t = `<div class="sec"><h3>Configured interfaces</h3>${table([
    { key: 'site', label: 'Site' }, { key: 'device', label: 'Device' }, { key: 'interface', label: 'Interface' }, { label: 'Speed', align: 'r', fmt: (s) => esc(speed(s.speedBps)) }, { label: 'Result', fmt: () => st('NO_DATA') },
  ], list.slice(0, 14))}${list.length > 14 ? emptyRow(`+ ${list.length - 14} more`) : ''}</div>`;
  const notes = `<div class="sec"><h3>Data quality &amp; methodology</h3><ul class="obs note" style="gap:1.4mm">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  const p2 = page({ n: 2, total, kicker: 'NOC · Interface traffic', title: 'Technical Details', model: m, left: FOOT, body: `${t}${notes}`, extra: `0 of ${list.length} interfaces reporting` });
  return { html: document_({ title: `Daily Interface Traffic ${m.window.date} (no data)`, pages: [p1, p2] }), pages: total };
}
