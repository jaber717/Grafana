// Interface counter arithmetic for the interface report. Pure functions over [{t: epochMs, v: counter}] sorted by time.
// Rules:
//  - counters wrap at 2^bits; a decrease is treated as a wrap only if the implied rate is plausible, otherwise it is a counter reset
//    and the interval is dropped (counted in `resets`), never shown as zero traffic;
//  - a gap longer than maxGapS is missing data (counted in `gaps`), not zero traffic;
//  - an interval whose rate exceeds the configured speed is an anomaly: excluded and counted (`anomalies`), so a wrong speed setting
//    is visible in the data-quality section instead of silently inflating or clipping utilisation.

export function counterIntervals(samples, { bits = 64, speedBps = null, maxGapS = 900, overspeedFactor = 1.05 } = {}) {
  const wrap = 2 ** bits;
  const out = { intervals: [], resets: 0, gaps: 0, anomalies: 0 };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dtS = (b.t - a.t) / 1000;
    if (dtS <= 0) continue;
    if (dtS > maxGapS) { out.gaps++; continue; }
    let delta = b.v - a.v;
    if (delta < 0) {
      // A real wrap starts from a value in the upper half of the counter range and ends with a small non-negative delta
      // whose rate is plausible. Anything else is a reset.
      const wrapped = delta + wrap;
      const nearLimit = a.v >= wrap / 2;
      const plausible = speedBps != null && wrapped >= 0 && nearLimit && (wrapped * 8) / dtS <= speedBps * overspeedFactor;
      if (plausible) delta = wrapped;
      else { out.resets++; continue; }
    }
    const rateBps = (delta * 8) / dtS;
    if (speedBps != null && rateBps > speedBps * overspeedFactor) { out.anomalies++; continue; }
    out.intervals.push({ t0: a.t, t1: b.t, dtS, bytes: delta, rateBps });
  }
  return out;
}

// One interface over a window. expectedS is the window length; the averages use only the covered seconds.
export function summarizeInterface(samples, { bits = 64, speedBps = null, expectedS = null, maxGapS = 900 } = {}) {
  const c = counterIntervals(samples, { bits, speedBps, maxGapS });
  const coveredS = c.intervals.reduce((s, x) => s + x.dtS, 0);
  const bytes = c.intervals.reduce((s, x) => s + x.bytes, 0);
  const peakBps = c.intervals.reduce((m, x) => Math.max(m, x.rateBps), 0);
  const avgBps = coveredS > 0 ? (bytes * 8) / coveredS : null;
  const hasSpeed = speedBps != null && speedBps > 0;
  return {
    bytes,
    avgBps,
    peakBps: c.intervals.length ? peakBps : null,
    avgUtilPct: hasSpeed && avgBps != null ? round1((avgBps / speedBps) * 100) : null,
    peakUtilPct: hasSpeed && c.intervals.length ? round1((peakBps / speedBps) * 100) : null,
    coverage: expectedS ? Math.min(1, coveredS / expectedS) : null,
    coveredS,
    resets: c.resets,
    gaps: c.gaps,
    anomalies: c.anomalies,
    speedKnown: hasSpeed,
  };
}

// Totals across interfaces are meaningful only when the selected interfaces do not overlap (a LAG and its members, a sub-interface and
// its parent, the same link seen twice). Refuse instead of double counting. rows: [{key, overlapsWith: [], summary}]
export function nonOverlappingTotal(rows) {
  const seen = new Set();
  for (const r of rows) {
    if (!r.key) throw new Error('interface row without key');
    if (seen.has(r.key)) throw new Error(`interface '${r.key}' selected twice`);
    seen.add(r.key);
    if (r.overlapsWith && r.overlapsWith.length) {
      throw new Error(`interface '${r.key}' overlaps ${r.overlapsWith.join(',')}: choose non-overlapping interfaces for a total`);
    }
  }
  return { bytes: rows.reduce((s, r) => s + (r.summary?.bytes || 0), 0), count: rows.length };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
