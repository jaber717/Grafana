// NetFlow arithmetic. Rows are the datasource results: {bytes, samplingRate, t?, direction?}.
// Volumes are ESTIMATES of sampled traffic: each flow record stands for SamplingRate packets, so estimated bytes = sum(Bytes * SamplingRate).
// Unsampled exporters use SamplingRate = 1, so their figures are observed volume. isSampled() says which one a report shows.

export function estimatedBytes(rows) {
  return rows.reduce((s, r) => s + Number(r.bytes) * Number(r.samplingRate || 1), 0);
}

// Average rate over the FULL window (the window is what the report covers; missing time lowers the average and is shown via coverage).
export function averageBps(bytes, windowSeconds) {
  return windowSeconds > 0 ? (bytes * 8) / windowSeconds : null;
}

// Peak over 5-minute buckets: rows {t, bytes, samplingRate}.
export function peakBps(rows, bucketS = 300) {
  const byT = new Map();
  for (const r of rows) byT.set(r.t, (byT.get(r.t) || 0) + Number(r.bytes) * Number(r.samplingRate || 1));
  let peak = null;
  let at = null;
  for (const [t, b] of byT) {
    const bps = (b * 8) / bucketS;
    if (peak == null || bps > peak) { peak = bps; at = t; }
  }
  return { peakBps: peak, peakAt: at };
}

// Direction split from the Grafana classification: 'inbound' | 'outbound' | 'transit' | 'unclassified'.
export function directionSplit(rows) {
  const out = { inbound: 0, outbound: 0, transit: 0, unclassified: 0 };
  for (const r of rows) out[r.direction || 'unclassified'] += Number(r.bytes) * Number(r.samplingRate || 1);
  return out;
}

export function isSampled(rows) {
  return rows.some(r => Number(r.samplingRate || 1) > 1);
}

// Relative change against the previous day; null when the previous day has no data (never a fabricated percentage).
export function changePct(today, previous) {
  if (today == null || previous == null || previous <= 0) return null;
  return Math.round(((today - previous) / previous) * 1000) / 10;
}
