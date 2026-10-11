// Reporting window: the previous COMPLETE calendar day in Asia/Riyadh (UTC+03:00, no daylight saving), 00:00 to 24:00 local.
export const REPORT_TZ = 'Asia/Riyadh';
export const RIYADH_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 86400 * 1000;

// nowMs: epoch milliseconds. Returns the window as epoch ms [startMs, endMs) and the local date label YYYY-MM-DD.
export function previousDayWindow(nowMs = Date.now()) {
  const localNow = nowMs + RIYADH_OFFSET_MS;
  const localToday = Math.floor(localNow / DAY_MS) * DAY_MS;      // local midnight of today, in local ms
  const startMs = localToday - DAY_MS - RIYADH_OFFSET_MS;          // local midnight of yesterday, in UTC ms
  return windowFromStart(startMs);
}

// The window for an explicit local date (YYYY-MM-DD), used for manual re-generation.
export function windowForDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`date must be YYYY-MM-DD, got '${dateStr}'`);
  const localMidnight = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return windowFromStart(localMidnight - RIYADH_OFFSET_MS);
}

function windowFromStart(startMs) {
  const endMs = startMs + DAY_MS;
  return {
    date: new Date(startMs + RIYADH_OFFSET_MS).toISOString().slice(0, 10),
    timezone: REPORT_TZ,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    seconds: DAY_MS / 1000,
  };
}
