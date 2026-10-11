// One unit convention everywhere (decimal SI, the same as the Grafana panels' "bps" / "decbytes"), one decimal place.
import { RIYADH_OFFSET_MS } from './window.mjs';

const scale = (v, units) => {
  let i = 0;
  let x = Math.abs(v);
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return { x: Math.sign(v) * x, unit: units[i] };
};

export function fmtBps(v) {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  const { x, unit } = scale(v, ['b/s', 'Kb/s', 'Mb/s', 'Gb/s', 'Tb/s']);
  return `${x.toFixed(1)} ${unit}`;
}

export function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  const { x, unit } = scale(v, ['B', 'KB', 'MB', 'GB', 'TB', 'PB']);
  return unit === 'B' ? `${Math.round(x)} B` : `${x.toFixed(1)} ${unit}`;
}

export function fmtPct(v, digits = 1) {
  return v == null || !Number.isFinite(v) ? 'N/A' : `${v.toFixed(digits)}%`;
}

export function fmtChange(v) {
  if (v == null) return 'n/a';
  const s = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${s}${Math.abs(v).toFixed(1)}%`;
}

const p2 = (n) => String(n).padStart(2, '0');
export function fmtClock(ms) {
  if (ms == null) return 'N/A';
  const d = new Date(ms + RIYADH_OFFSET_MS);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export function fmtDateTime(ms) {
  if (ms == null) return 'N/A';
  const d = new Date(ms + RIYADH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function fmtLongDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtAge(seconds) {
  if (seconds == null) return 'N/A';
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
