// DEMO fixtures: deterministic, clearly synthetic daily series for layout review and tests.
// They must NEVER be mixed into operational reports. Every object produced here carries demo: true, and the renderer prints the
// DEMO_LABEL watermark on any page built from such data.
export const DEMO_LABEL = 'DEMO - synthetic data, not measured';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 288 five-minute buckets of one day: diurnal load, business-hour peak, evening peak, a quiet night, optional quiet mode and missing buckets.
// gap: {fromBucket, toBucket} buckets that are ABSENT (not zero), so the coverage logic is exercised.
export function demoDailySeries({ startMs, peakBps = 850e6, seed = 7, gap = null, quiet = false }) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let k = 0; k < 288; k++) {
    const t = startMs + k * 300e3;
    const hour = k / 12;
    const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
    const peaks = Math.exp(-((hour - 11) ** 2) / 3) * 0.25 + Math.exp(-((hour - 20) ** 2) / 4) * 0.18;
    const night = hour < 5 ? 0.35 : 1;
    let v = Math.max(0, (diurnal + peaks) * night) * peakBps * (0.94 + 0.12 * rnd());
    if (quiet) v *= 0.05;
    if (gap && k >= gap.fromBucket && k < gap.toBucket) continue;
    out.push({ t, bps: v, demo: true });
  }
  return out;
}
