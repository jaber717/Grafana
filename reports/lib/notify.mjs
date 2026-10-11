// Message content for e-mail and Telegram, built from the report models (facts only: a NO DATA day says so and shows no figures).
import { esc, fmtBytes, fmtBps, fmtPct, fmtChange, fmtClock, fmtLongDate } from './format.mjs';
import { DEMO_LABEL } from './demo.mjs';
import { esc as tgEsc } from './telegram.mjs';

const statusText = (s) => (s === 'NO_DATA' ? 'NO DATA' : s);
const STATUS_COLOR = { COMPLETE: '#2E8B57', PARTIAL: '#B7791F', NO_DATA: '#5F6B7A' };

// [{label, value}] headline figures per report
export function headline(model) {
  if (model.status === 'NO_DATA' || !model.kpis) return [];
  if (model.kind === 'netflow') {
    const k = model.kpis;
    const est = k.sampled ? ' (est.)' : '';
    return [
      { label: `Inbound${est}`, value: `${fmtBytes(k.inboundBytes)}  ·  avg ${fmtBps(k.avgInBps)}` },
      { label: `Outbound${est}`, value: `${fmtBytes(k.outboundBytes)}  ·  avg ${fmtBps(k.avgOutBps)}` },
      { label: 'Peak inbound / outbound', value: `${fmtBps(k.peakIn?.bps)} at ${fmtClock(k.peakIn?.at)}  /  ${fmtBps(k.peakOut?.bps)} at ${fmtClock(k.peakOut?.at)}` },
      { label: 'vs previous day', value: k.previousAvailable ? `total ${fmtChange(k.change.total)}` : k.comparisonSuppressed ? 'not shown (incomplete day)' : 'no previous-day data' },
      { label: 'Data coverage', value: `${fmtPct(model.coverage.coverage * 100, 0)} (${model.coverage.observed} of ${model.coverage.expected} intervals)` },
    ];
  }
  const k = model.kpis;
  const top = model.interfaces.find((s) => s.key === k.busiest[0]);
  const hot = model.interfaces.filter((s) => s.peakUtilPct != null && s.peakUtilPct >= 80).length;
  return [
    { label: 'Interfaces reporting', value: `${k.interfacesReporting} of ${k.interfacesIncluded}${k.interfacesPartial ? ` (${k.interfacesPartial} incomplete)` : ''}` },
    { label: 'Highest peak utilisation', value: top ? `${top.peakUtilPct != null ? fmtPct(top.peakUtilPct) : 'N/A'} - ${top.site} ${top.interface} (${fmtBps(top.peakBps)})` : 'N/A' },
    { label: 'Interfaces over 80% at peak', value: String(hot) },
  ];
}

const title = (m) => (m.kind === 'netflow' ? 'Daily NetFlow Traffic Report' : 'Daily Interface Traffic Report');

export function emailSubject({ prefix, date, models, demo }) {
  const parts = models.map((m) => `${m.kind === 'netflow' ? 'NetFlow' : 'Interfaces'} ${statusText(m.status)}`);
  return `${demo ? '[DEMO] ' : ''}${prefix} - ${date} - ${parts.join(' / ')}`;
}

export function emailText({ date, models, files, demo }) {
  const out = [];
  if (demo) out.push(DEMO_LABEL, '');
  out.push(`Daily network traffic reports - ${fmtLongDate(date)} (00:00-24:00 Asia/Riyadh)`, '');
  for (const m of models) {
    out.push(`${title(m)}: ${statusText(m.status)}`);
    for (const h of headline(m)) out.push(`  ${h.label}: ${h.value}`);
    for (const o of m.observations) out.push(`  - ${o}`);
    out.push('');
  }
  out.push('Attached:', ...files.map((f) => `  ${f.filename} (${Math.round(f.bytes / 1024)} KB)`), '', 'This is an automatically generated message.');
  return out.join('\n');
}

export function emailHtml({ date, models, files, demo, grafanaUrl }) {
  const chip = (s) => `<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:${STATUS_COLOR[s]};color:#fff;font-size:11px;font-weight:600;letter-spacing:.05em">${esc(statusText(s))}</span>`;
  const section = (m) => `
<tr><td style="padding:18px 28px 6px 28px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td style="font-size:16px;font-weight:600;color:#1F2933">${esc(title(m))}</td><td align="right">${chip(m.status)}</td></tr></table>
  ${m.status === 'NO_DATA' ? `<p style="margin:10px 0 0 0;font-size:13px;line-height:1.5;color:#44505E">${esc(m.observations[0])}</p>` : `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px;border-collapse:collapse">
    ${headline(m).map((h) => `<tr><td style="padding:5px 0;border-bottom:1px solid #EBEEF2;font-size:12px;color:#5F6B7A;width:38%">${esc(h.label)}</td><td style="padding:5px 0;border-bottom:1px solid #EBEEF2;font-size:13px;color:#1F2933;font-weight:500">${esc(h.value)}</td></tr>`).join('')}
  </table>
  <ul style="margin:12px 0 0 0;padding-left:18px;font-size:12.5px;line-height:1.55;color:#33404D">${m.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>`}
</td></tr>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EEF1F5;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EEF1F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:640px;max-width:100%;background:#fff;border:1px solid #E1E5EA;border-radius:8px;overflow:hidden">
<tr><td style="background:#14283D;padding:22px 28px">
  <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#A9BDD3">NOC · Network traffic</div>
  <div style="font-size:21px;font-weight:600;color:#fff;margin-top:4px">Daily Network Traffic Reports</div>
  <div style="font-size:13px;color:#C9D6E5;margin-top:4px">${esc(fmtLongDate(date))} · 00:00 - 24:00 Asia/Riyadh (UTC+03:00)</div></td></tr>
${demo ? `<tr><td style="background:#FFF4DC;color:#7A4B00;padding:8px 28px;font-size:12px;font-weight:600">${esc(DEMO_LABEL)} - this is a delivery test, not an operational report</td></tr>` : ''}
${models.map(section).join('<tr><td style="padding:0 28px"><hr style="border:0;border-top:1px solid #E1E5EA;margin:14px 0 0 0"></td></tr>')}
<tr><td style="padding:18px 28px 6px 28px;font-size:12px;color:#5F6B7A">
  <b style="color:#1F2933">Attached</b><br>${files.map((f) => `${esc(f.filename)} (${Math.round(f.bytes / 1024)} KB)`).join('<br>')}</td></tr>
<tr><td style="padding:12px 28px 22px 28px;font-size:11px;color:#8A94A3;border-top:1px solid #EBEEF2">Charts are rendered by Grafana${grafanaUrl ? ` (${esc(grafanaUrl)})` : ''}. Volumes from sampled NetFlow are estimates. This is an automatically generated message.</td></tr>
</table></td></tr></table></body></html>`;
}

// Telegram: HTML parse mode (only <b>, <i>, <code> are used); stays well below the 4096-character limit.
export function telegramSummary({ date, models, demo }) {
  const lines = [];
  if (demo) lines.push(`<b>${tgEsc(DEMO_LABEL)}</b>`);
  lines.push(`<b>Daily network traffic - ${tgEsc(date)}</b>`, `<i>${tgEsc(fmtLongDate(date))}, 00:00-24:00 Asia/Riyadh</i>`, '');
  for (const m of models) {
    lines.push(`<b>${tgEsc(title(m))}</b> - <b>${tgEsc(statusText(m.status))}</b>`);
    if (m.status === 'NO_DATA') lines.push(tgEsc(m.observations[0]));
    else for (const h of headline(m)) lines.push(`${tgEsc(h.label)}: <code>${tgEsc(h.value)}</code>`);
    lines.push('');
  }
  lines.push('PDF reports attached.');
  const text = lines.join('\n');
  return text.length > 4000 ? `${text.slice(0, 3990)}...` : text;
}
