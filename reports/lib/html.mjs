// HTML building blocks for the report pages: A4 landscape, fixed-size pages, self-contained (fonts and Grafana panel images embedded).
// The charts are the PNGs Grafana's renderer produced - they are placed as images and never redrawn here.
import { readFileSync } from 'node:fs';
import { esc, fmtLongDate, fmtDateTime } from './format.mjs';
import { DEMO_LABEL } from './demo.mjs';

const FONT_DIR = new URL('../assets/fonts/', import.meta.url);
const font = (file) => readFileSync(new URL(file, FONT_DIR)).toString('base64');

export function css() {
  return `
@font-face{font-family:Inter;font-weight:400;src:url(data:font/woff2;base64,${font('Inter-Regular.woff2')}) format('woff2')}
@font-face{font-family:Inter;font-weight:500;src:url(data:font/woff2;base64,${font('Inter-Medium.woff2')}) format('woff2')}
:root{--ink:#1F2933;--mut:#5F6B7A;--faint:#8A94A3;--line:#E1E5EA;--card:#FBFBFB;--navy:#14283D;--navy2:#1E3A5A;--in:#2F6EBA;--out:#E0861B;--ok:#2E8B57;--warn:#B7791F;--crit:#C53030;--nodata:#5F6B7A}
@page{size:A4 landscape;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:var(--ink);font:400 8.6pt/1.38 Inter,'Liberation Sans','DejaVu Sans',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-variant-numeric:tabular-nums}
.page{position:relative;width:297mm;height:210mm;overflow:hidden;break-after:page;page-break-after:always;background:#fff;display:flex;flex-direction:column}
.page:last-child{break-after:auto;page-break-after:auto}
.hdr{flex:none;background:linear-gradient(100deg,var(--navy) 0%,var(--navy2) 100%);color:#fff;height:25mm;padding:0 12mm;display:flex;align-items:center;justify-content:space-between}
.hdr .k{font-size:7.2pt;letter-spacing:.14em;text-transform:uppercase;color:#A9BDD3;font-weight:500}
.hdr .t{font-size:17pt;font-weight:500;letter-spacing:-.01em;margin-top:1mm}
.hdr .p{font-size:8.4pt;color:#C9D6E5;margin-top:.8mm}
.hdr .r{text-align:right}
.pill{display:inline-flex;align-items:center;gap:1.6mm;border-radius:20mm;padding:1.2mm 3.4mm;font-size:8pt;font-weight:500;letter-spacing:.04em;background:rgba(255,255,255,.12);color:#fff;border:.25mm solid rgba(255,255,255,.28)}
.pill i{width:2.2mm;height:2.2mm;border-radius:50%;display:inline-block;background:#fff}
.pill.COMPLETE i{background:#4CC38A}.pill.PARTIAL i{background:#F2B544}.pill.NO_DATA i{background:#9AA7B6}
.hdr .cov{font-size:8pt;color:#C9D6E5;margin-top:1.6mm}
.demo-bar{flex:none;background:#FFF4DC;color:#7A4B00;font-size:8pt;font-weight:500;letter-spacing:.03em;text-align:center;padding:1.1mm 0;border-bottom:.3mm solid #F2D28B}
.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:9}
.wm span{transform:rotate(-24deg);font-size:40pt;font-weight:500;letter-spacing:.06em;color:rgba(183,121,31,.08);white-space:nowrap}
.body{flex:1 1 auto;min-height:0;padding:6mm 12mm 0 12mm;display:flex;flex-direction:column;gap:4.5mm}
.ftr{flex:none;height:10mm;padding:0 12mm;display:flex;align-items:center;justify-content:space-between;font-size:7pt;color:var(--faint);border-top:.25mm solid var(--line);margin:0 12mm;padding:0}
.kpis{display:grid;gap:3.2mm}
.kpi{background:var(--card);border:.25mm solid var(--line);border-radius:2mm;padding:3mm 3.6mm 2.8mm;border-top:.9mm solid var(--faint);min-width:0}
.kpi.in{border-top-color:var(--in)}.kpi.out{border-top-color:var(--out)}.kpi.neutral{border-top-color:var(--navy2)}
.kpi.ok{border-top-color:var(--ok)}.kpi.warn{border-top-color:var(--warn)}.kpi.crit{border-top-color:var(--crit)}.kpi.nodata{border-top-color:var(--nodata)}
.kpi .l{white-space:nowrap;font-size:6.6pt;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);font-weight:500}
.kpi .v{font-size:19pt;font-weight:500;letter-spacing:-.02em;margin-top:1.2mm;line-height:1.1;white-space:nowrap}
.kpi .v small{font-size:10pt;color:var(--mut);font-weight:400;margin-left:.8mm}
.kpi .s{font-size:7.4pt;color:var(--mut);margin-top:1.2mm;line-height:1.35;min-height:8.4mm}
.chg{display:inline-block;font-weight:500;color:var(--ink);background:#EDF0F4;border-radius:1mm;padding:0 1.3mm;margin-left:.5mm;font-size:7.2pt}
.card{background:var(--card);border:.25mm solid var(--line);border-radius:2mm;min-width:0;min-height:0;position:relative;overflow:hidden}
.card img{display:block;width:100%;height:100%;object-fit:contain}
.card h3,.sec h3{margin:0;font-size:8.6pt;font-weight:500;letter-spacing:.01em;color:var(--ink)}
.card .ch{padding:2.6mm 3.4mm 1.4mm;display:flex;justify-content:space-between;align-items:baseline}
.card .ch span{font-size:7pt;color:var(--mut)}
.card .cb{padding:0 3.4mm 2.6mm}
.sec{background:#fff;border:.25mm solid var(--line);border-radius:2mm;padding:2.4mm 3.4mm;min-width:0}
.sec h3{text-transform:uppercase;font-size:6.8pt;letter-spacing:.11em;color:var(--mut);margin-bottom:2mm}
ul.obs{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2mm}
ul.obs li{padding-left:3.6mm;position:relative;font-size:8.2pt;line-height:1.4}
ul.obs li:before{content:"";position:absolute;left:0;top:1.6mm;width:1.7mm;height:1.7mm;border-radius:50%;background:var(--navy2)}
table.t{width:100%;border-collapse:collapse;font-size:7.4pt}
table.t th{font-size:6.2pt;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:500;text-align:left;padding:1.1mm 1.6mm;border-bottom:.35mm solid #CBD2DA;white-space:nowrap}
table.t td{padding:.85mm 1.6mm;border-bottom:.2mm solid #EBEEF2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60mm}
table.t tr:nth-child(even) td{background:#F8F9FB}
table.t .r{text-align:right}
table.t td.n{color:var(--faint);width:5mm}
.bar{display:inline-block;height:1.6mm;border-radius:.8mm;background:var(--in);vertical-align:middle;opacity:.85}
.gauge{display:inline-block;width:14mm;height:1.9mm;border-radius:1mm;background:#E8ECF1;vertical-align:middle;position:relative;overflow:hidden}
.gauge i{position:absolute;left:0;top:0;bottom:0;border-radius:1mm}
.st{display:inline-block;border-radius:1mm;padding:.1mm 1.5mm;font-size:6.4pt;font-weight:500;letter-spacing:.05em}
.st.COMPLETE{background:#DDF3E7;color:#1E6B45}.st.PARTIAL{background:#FCEBC8;color:#8A5A00}.st.NO_DATA{background:#E7EAEE;color:#44505E}.st.ok{background:#DDF3E7;color:#1E6B45}.st.warn{background:#FCEBC8;color:#8A5A00}.st.crit{background:#F8D9D9;color:#8E2020}
.note{font-size:6.9pt;color:var(--mut);line-height:1.42}
.note b{color:var(--ink);font-weight:500}
.legend{display:flex;gap:4mm;font-size:7.2pt;color:var(--mut)}
.legend i{display:inline-block;width:3.4mm;height:1.1mm;border-radius:.6mm;margin-right:1.2mm;vertical-align:middle}
.nodata{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3mm;background:var(--card);border:.25mm dashed #B8C0CB;border-radius:3mm}
.nodata .big{font-size:34pt;font-weight:500;letter-spacing:.06em;color:#44505E}
.nodata .sub{font-size:11pt;color:var(--ink);font-weight:500}
.nodata .exp{max-width:170mm;font-size:8.8pt;color:var(--mut);line-height:1.5}
.cols{display:grid;gap:3.6mm;min-height:0}
`;
}

export function statusLabel(s) {
  return s === 'NO_DATA' ? 'NO DATA' : s;
}

export function header({ kicker, title, model, extra = '' }) {
  const w = model.window;
  const cov = model.coverage;
  return `<div class="hdr"><div><div class="k">${esc(kicker)}</div><div class="t">${esc(title)}</div>
<div class="p">${esc(fmtLongDate(w.date))} &nbsp;·&nbsp; ${esc(w.date)} 00:00 – 24:00 &nbsp;·&nbsp; ${esc(w.timezone)} (UTC+03:00)</div></div>
<div class="r"><span class="pill ${model.status}"><i></i>${statusLabel(model.status)}</span>
<div class="cov">${extra || (cov ? `Data coverage ${model.status === 'NO_DATA' ? '0%' : `${Math.round(cov.coverage * 100)}%`}` : '')}</div></div></div>${model.demo ? `<div class="demo-bar">${esc(DEMO_LABEL)} &nbsp;·&nbsp; this is a layout example, not an operational report</div>` : ''}`;
}

export function footer({ left, n, total, model }) {
  return `<div class="ftr"><span>${esc(left)}</span><span>Generated ${esc(fmtDateTime(model.generatedAt))} Asia/Riyadh${model.demo ? ' · DEMO' : ''}</span><span>Page ${n} of ${total}</span></div>`;
}

export function page({ n, total, kicker, title, model, left, body, extra }) {
  return `<section class="page">${model.demo ? `<div class="wm"><span>${esc('DEMO – SYNTHETIC DATA')}</span></div>` : ''}${header({ kicker, title, model, extra })}<div class="body">${body}</div>${footer({ left, n, total, model })}</section>`;
}

export const dataUri = (png) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
export const img = (png, alt) => `<img alt="${esc(alt)}" src="${dataUri(png)}">`;

export function kpi({ cls = 'neutral', label, value, unit = '', sub = '', change = null }) {
  return `<div class="kpi ${cls}"><div class="l">${esc(label)}</div><div class="v">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="s">${sub}${change ? `<span class="chg">${esc(change)}</span>` : ''}</div></div>`;
}

// cols: [{key,label,align,fmt(row,i)->html-safe string}]; fmt output is trusted HTML (callers escape); plain values are escaped.
export function table(cols, rows, { index = false } = {}) {
  const th = (index ? '<th></th>' : '') + cols.map((c) => `<th class="${c.align === 'r' ? 'r' : ''}">${esc(c.label)}</th>`).join('');
  const tr = rows.map((r, i) => `<tr>${index ? `<td class="n">${i + 1}</td>` : ''}${cols.map((c) => `<td class="${c.align === 'r' ? 'r' : ''}" title="${esc(c.title ? c.title(r) : '')}">${c.fmt ? c.fmt(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  return `<table class="t"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export function document_({ title, pages }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css()}</style></head><body>${pages.join('')}</body></html>`;
}

export const emptyRow = (msg) => `<div class="note" style="padding:4mm 0">${esc(msg)}</div>`;
