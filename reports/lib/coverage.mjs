// Data coverage and the NO_DATA / PARTIAL / COMPLETE decision.
// A day without data is NO_DATA: it must never be rendered as zero utilisation.
export const BUCKET_S = 300;          // NetFlow and interface samples are aggregated to 5-minute buckets
export const MIN_COVERAGE = 0.95;     // below this share of expected buckets the day is PARTIAL

export function expectedBuckets(windowSeconds) {
  return Math.round(windowSeconds / BUCKET_S);
}

// observedBuckets: buckets that hold at least one valid sample. lastSampleMs: newest sample (or null). nowMs: generation time.
export function classify({ windowSeconds, observedBuckets, lastSampleMs = null, nowMs = Date.now(), minCoverage = MIN_COVERAGE }) {
  const expected = expectedBuckets(windowSeconds);
  const coverage = expected > 0 ? Math.min(1, observedBuckets / expected) : 0;
  const freshnessS = lastSampleMs == null ? null : Math.max(0, Math.round((nowMs - lastSampleMs) / 1000));
  if (!observedBuckets) return { status: 'NO_DATA', expected, observed: 0, coverage: 0, freshnessS };
  const status = coverage >= minCoverage ? 'COMPLETE' : 'PARTIAL';
  return { status, expected, observed: observedBuckets, coverage: Math.round(coverage * 1000) / 1000, freshnessS };
}
