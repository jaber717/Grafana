// Daily NetFlow Traffic Report: page composition. Slot sizes (mm) are shared with the renderer so each Grafana panel image is rendered
// at exactly the size it is printed (no scaling artefacts): see NETFLOW_SLOTS.
import { esc, fmtBytes, fmtBps, fmtPct, fmtChange, fmtClock, fmtAge, fmtDateTime } from './format.mjs';
import { kpi, table, page, img, document_, emptyRow } from './html.mjs';

const PX = 96 / 25.4;
export const mmToPx = (mm) => Math.round(mm * PX);
export const NETFLOW_SLOTS = {
  trend: { panelId: 1, w: 180, h: 118 },
  cmp: { panelId: 2, w: 134, h: 76 },
  hourly: { panelId: 3, w: 134, h: 76 },
  protocols: { panelId: 4, w: 88, h: 76 },
  site: { panelId: 5, w: 88, h: 76 },
  isp: { panelId: 6, w: 88, h: 76 },
};
export const NETFLOW_FILE = (date) => `Daily-NetFlow-${date}.pdf`;
const FOOT = 'Source: Akvorado NetFlow in ClickHouse, charts rendered by Grafana (dashboard rpt-netflow-daily)';

const chg = (v) => (v == null ? null : `${v > 0 ? '▲' : v < 0 ? '▼' : '●'} ${fmtChange(v).replace(/^[+-]/, '')} vs prev. day`);

function card(im, w, h, alt) {
  return `<div class="card" style="width:${w}mm;height:${h}mm">${im ? img(im, alt) : `<div class="cb">${emptyRow(`${alt}: panel image not available`)}</div>`}</div>`;
}

function noteCard(title, msg, w, h) {
  return `<div class="card" style="width:${w}mm;height:${h}mm"><div class="ch"><h3>${esc(title)}</h3></div><div class="cb">${emptyRow(msg)}</div></div>`;
}

export function buildNetflowHtml(model, images = {}) {
  return model.status === 'NO_DATA' ? noDataHtml(model) : fullHtml(model, images);
}

function fullHtml(m, im) {
  const k = m.kpis;
  const est = k.sampled ? ' (est.)' : '';
  const total = 3;
  const kp = `<div class="kpis" style="grid-template-columns:repeat(6,1fr)">
${kpi({ cls: 'in', label: `Inbound${est}`, value: fmtBytes(k.inboundBytes), sub: `Average ${esc(fmtBps(k.avgInBps))}`, change: chg(k.change.inbound) })}
${kpi({ cls: 'out', label: `Outbound${est}`, value: fmtBytes(k.outboundBytes), sub: `Average ${esc(fmtBps(k.avgOutBps))}`, change: chg(k.change.outbound) })}
${kpi({ cls: 'in', label: 'Peak inbound', value: fmtBps(k.peakIn?.bps), sub: k.peakIn ? `at ${fmtClock(k.peakIn.at)} · 5-min average` : '' })}
${kpi({ cls: 'out', label: 'Peak outbound', value: fmtBps(k.peakOut?.bps), sub: k.peakOut ? `at ${fmtClock(k.peakOut.at)} · 5-min average` : '' })}
${kpi({ cls: 'neutral', label: `Total${est}`, value: fmtBytes(k.totalBytes), sub: k.previousAvailable ? 'Inbound + outbound' : k.comparisonSuppressed ? 'Comparison not shown (incomplete day)' : 'No previous-day data', change: chg(k.change.total) })}
${kpi({ cls: m.status === 'COMPLETE' ? 'ok' : 'warn', label: 'Data coverage', value: fmtPct(m.coverage.coverage * 100, 0), sub: `${m.coverage.observed} of ${m.coverage.expected} five-minute intervals` })}
</div>`;
  const fresh = m.coverage.freshnessS == null ? 'N/A' : fmtAge(m.coverage.freshnessS);
  const side = `<div style="display:flex;flex-direction:column;gap:4.5mm;width:88.5mm;min-height:0">
<div class="sec" style="flex:1 1 auto"><h3>Key observations</h3><ul class="obs">${m.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></div>
<div class="sec"><h3>Collection &amp; completeness</h3><table class="t"><tbody>
<tr><td>Status</td><td class="r"><span class="st ${m.status}">${m.status === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL'}</span></td></tr>
<tr><td>Intervals with data</td><td class="r">${m.coverage.observed} / ${m.coverage.expected}</td></tr>
${m.scope && m.scope.id !== 'all' ? `<tr><td>Scope</td><td class="r" title="${esc(m.scope.text)}">${esc(m.scope.title)}</td></tr>` : ''}
<tr><td>Exporters reporting</td><td class="r">${m.tables.exporters.length}</td></tr>
<tr><td>Newest flow record</td><td class="r">${esc(fresh)}</td></tr>
<tr><td>Volume basis</td><td class="r">${k.sampled ? 'Estimated (sampled)' : 'Observed'}</td></tr></tbody></table></div></div>`;
  const p1 = page({
    n: 1, total, kicker: 'NOC · Network traffic', title: 'Daily NetFlow Traffic Report', model: m, left: FOOT, extra: `Data coverage ${Math.round(m.coverage.coverage * 100)}% · ${m.coverage.observed}/${m.coverage.expected} intervals`,
    body: `${kp}<div style="display:flex;gap:4.5mm;min-height:0">${card(im.trend, 180, 118, 'Traffic by direction')}${side}</div>`,
  });

  const second = (a, b, c) => `${a}${b}${c}`;
  const row1 = `<div style="display:flex;gap:4.5mm">${card(im.hourly, 134.25, 76, 'Hourly volume')}${card(im.cmp, 134.25, 76, 'Report day vs previous day')}</div>`;
  const siteCard = m.available.site ? card(im.site, 88.5, 76, 'Traffic by site') : noteCard('Traffic by site', 'No site metadata is configured on the exporters, so no per-site breakdown is shown.', 88.5, 76);
  const ispCard = m.available.isp ? card(im.isp, 88.5, 76, 'Traffic by ISP / provider') : noteCard('Traffic by ISP / provider', 'No provider metadata is configured on the external interfaces, so no per-ISP breakdown is shown.', 88.5, 76);
  const row2 = `<div style="display:flex;gap:4.5mm">${m.available.protocols ? card(im.protocols, 88.5, 76, 'Protocol mix') : noteCard('Protocol mix', 'No protocol data.', 88.5, 76)}${siteCard}${ispCard}</div>`;
  const p2 = page({ n: 2, total, kicker: 'NOC · Network traffic', title: 'Traffic Analysis', model: m, left: FOOT, body: second(row1, row2, ''), extra: `Data coverage ${Math.round(m.coverage.coverage * 100)}%` });

  const share = (r) => `${esc(fmtPct(r.Share))}`;
  const vol = (r) => esc(fmtBytes(r.Bytes));
  const T = m.tables;
  const raw = T.rawExpired ? emptyRow('Raw flow records are kept for 14 days; this day is older, so per-IP tables are not available.') : null;
  const topTable = (title, rows, cols, id) => `<div class="sec"><h3>${esc(title)}</h3>${raw || (T.unavailable?.[id] ? emptyRow(`Not available: the query on the raw flow table failed (${T.unavailable[id].slice(0, 80)}).`) : rows.length ? table(cols, rows, { index: true }) : emptyRow('No data'))}</div>`;
  const ip = (key) => ({ key, label: 'IP address' });
  const t1 = topTable('Top 10 source IPs', T.top_src, [ip('IP'), { key: 'Network', label: 'Network' }, { label: 'Volume', align: 'r', fmt: vol }, { label: 'Share', align: 'r', fmt: share }], 'top_src');
  const t2 = topTable('Top 10 destination IPs', T.top_dst, [ip('IP'), { key: 'Network', label: 'Network' }, { label: 'Volume', align: 'r', fmt: vol }, { label: 'Share', align: 'r', fmt: share }], 'top_dst');
  const t3 = topTable('Top 10 conversations', T.top_conv, [{ label: 'Source → destination', fmt: (r) => `${esc(r.Source)} → ${esc(r.Destination)}` }, { key: 'Service', label: 'Service' }, { label: 'Volume', align: 'r', fmt: vol }], 'top_conv');
  const t4 = topTable('Top 10 protocols / ports', T.top_ports, [{ key: 'Service', label: 'Protocol / port' }, { label: 'Volume', align: 'r', fmt: vol }, { label: 'Share', align: 'r', fmt: share }], 'top_ports');
  const exp = `<div class="sec"><h3>Exporters (each listed separately - not additive)</h3>${T.exporters.length ? table([
    { key: 'Exporter', label: 'Exporter' }, { key: 'Site', label: 'Site', fmt: (r) => esc(r.Site || '-') },
    { label: 'Inbound', align: 'r', fmt: (r) => esc(fmtBytes(r.InboundBytes)) }, { label: 'Outbound', align: 'r', fmt: (r) => esc(fmtBytes(r.OutboundBytes)) },
    { label: 'Sampling', align: 'r', fmt: (r) => (r.Sampled ? `1:${r.MaxSamplingRate}` : 'none') }, { label: 'Coverage', align: 'r', fmt: (r) => `<span class="st ${r.Coverage >= 0.95 ? 'COMPLETE' : 'PARTIAL'}">${esc(fmtPct(r.Coverage * 100, 0))}</span>` },
    { label: 'Last record', align: 'r', fmt: (r) => esc(fmtClock(Number(r.LastSeen) * 1000)) },
  ], T.exporters) : emptyRow('No exporter data')}</div>`;
  const notes = `<div class="sec" style="flex:1 1 auto"><h3>Data quality &amp; methodology</h3><ul class="obs note" style="gap:1.6mm">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  const t5 = `<div style="grid-column:span 2;display:flex;flex-direction:column;gap:3.6mm;min-height:0">${exp}${notes}</div>`;
  const p3 = page({ n: 3, total, kicker: 'NOC · Network traffic', title: 'Technical Details', model: m, left: FOOT, extra: `Data coverage ${Math.round(m.coverage.coverage * 100)}%`, body: `<div class="cols" style="grid-template-columns:repeat(3,1fr)">${t1}${t2}${t3}${t4}${t5}</div>` });
  return { html: document_({ title: `Daily NetFlow Traffic ${m.window.date}`, pages: [p1, p2, p3] }), pages: total };
}

function noDataHtml(m) {
  const total = 2;
  const cov = m.coverage;
  const last = cov.lastSampleMs ? `${fmtDateTime(cov.lastSampleMs)} (${fmtAge(cov.freshnessS)})` : 'no flow record found';
  const body1 = `<div class="nodata"><div class="big">NO DATA</div><div class="sub">No NetFlow records were received for ${esc(m.window.date)}</div>
<div class="exp">Traffic figures are intentionally not shown: a day without data is not the same as a day with zero traffic.<br>This is expected in environments where no router exports flows.</div></div>
<div class="kpis" style="grid-template-columns:repeat(4,1fr)">
${kpi({ cls: 'nodata', label: 'Data coverage', value: '0%', sub: `0 of ${cov.expected} five-minute intervals` })}
${kpi({ cls: 'nodata', label: 'Newest flow record on file', value: cov.lastSampleMs ? fmtAge(cov.freshnessS) : 'None', sub: esc(last) })}
${kpi({ cls: 'nodata', label: 'Exporters reporting', value: '0', sub: 'for the reporting day' })}
${kpi({ cls: 'nodata', label: 'Previous-day comparison', value: 'N/A', sub: 'not shown without data' })}</div>`;
  const p1 = page({ n: 1, total, kicker: 'NOC · Network traffic', title: 'Daily NetFlow Traffic Report', model: m, left: FOOT, body: body1, extra: `Data coverage 0% · 0/${cov.expected} intervals` });
  const checked = `<div class="sec"><h3>What was checked</h3><table class="t"><tbody>
<tr><td>Reporting window</td><td class="r">${esc(m.window.date)} 00:00 – 24:00 ${esc(m.window.timezone)}</td></tr>
<tr><td>Datasource</td><td class="r">ClickHouse (Akvorado), 5-minute rollup, via Grafana</td></tr>
<tr><td>Intervals expected / found</td><td class="r">${cov.expected} / 0</td></tr>
<tr><td>Newest flow record on file</td><td class="r">${esc(last)}</td></tr></tbody></table></div>`;
  const notes = `<div class="sec"><h3>Data quality &amp; methodology</h3><div class="note" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4mm">${m.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div></div>`;
  const p2 = page({ n: 2, total, kicker: 'NOC · Network traffic', title: 'Technical Details', model: m, left: FOOT, body: `${checked}${notes}`, extra: 'Data coverage 0%' });
  return { html: document_({ title: `Daily NetFlow Traffic ${m.window.date} (no data)`, pages: [p1, p2] }), pages: total };
}
