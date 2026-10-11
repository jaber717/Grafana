import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousDayWindow, windowForDate, RIYADH_OFFSET_MS } from '../../reports/lib/window.mjs';
import { classify, expectedBuckets } from '../../reports/lib/coverage.mjs';
import { counterIntervals, summarizeInterface, nonOverlappingTotal } from '../../reports/lib/interface-math.mjs';
import { estimatedBytes, averageBps, peakBps, isSampled, changePct } from '../../reports/lib/netflow-math.mjs';
import { demoDailySeries, DEMO_LABEL } from '../../reports/lib/demo.mjs';

const H = 3600e3;

test('window: previous complete Riyadh day, 00:00 to 24:00 local, around midnight', () => {
  // 2026-10-12 00:30 Riyadh = 2026-10-11 21:30 UTC -> previous day is 2026-10-11 Riyadh
  const now = Date.UTC(2026, 9, 11, 21, 30);
  const w = previousDayWindow(now);
  assert.equal(w.date, '2026-10-11');
  assert.equal(w.startIso, '2026-10-10T21:00:00.000Z');   // 2026-10-11 00:00 +03:00
  assert.equal(w.endIso, '2026-10-11T21:00:00.000Z');     // 2026-10-12 00:00 +03:00 (exclusive)
  assert.equal(w.seconds, 86400);
});

test('window: exactly at local midnight the previous day is the one that just ended', () => {
  const now = Date.UTC(2026, 9, 11, 21, 0, 0);            // 2026-10-12 00:00 Riyadh
  assert.equal(previousDayWindow(now).date, '2026-10-11');
});

test('window: explicit date and invalid date', () => {
  const w = windowForDate('2026-03-01');
  assert.equal(w.startIso, '2026-02-28T21:00:00.000Z');
  assert.equal(w.endMs - w.startMs, 86400e3);
  assert.equal(RIYADH_OFFSET_MS, 3 * H);
  assert.throws(() => windowForDate('01-03-2026'));
});

test('coverage: NO_DATA is never COMPLETE and has zero coverage', () => {
  const c = classify({ windowSeconds: 86400, observedBuckets: 0, nowMs: Date.UTC(2026, 9, 12) });
  assert.equal(c.status, 'NO_DATA');
  assert.equal(c.expected, 288);
  assert.equal(c.coverage, 0);
  assert.equal(c.freshnessS, null);
});

test('coverage: expected buckets of a day are 288', () => {
  assert.equal(expectedBuckets(86400), 288);
});

test('coverage: 270 of 288 buckets is PARTIAL (93.75 %), 280 is COMPLETE (97.2 %)', () => {
  assert.equal(classify({ windowSeconds: 86400, observedBuckets: 270 }).status, 'PARTIAL');
  assert.equal(classify({ windowSeconds: 86400, observedBuckets: 280 }).status, 'COMPLETE');
});

test('interface: 32-bit counter wrap is accepted when the implied rate is plausible', () => {
  const wrapAt = 2 ** 32;
  const s = [{ t: 0, v: wrapAt - 1000 }, { t: 300e3, v: 4000 }]; // delta = 5000 bytes after wrap over 300 s
  const c = counterIntervals(s, { bits: 32, speedBps: 1e9 });
  assert.equal(c.intervals.length, 1);
  assert.equal(c.intervals[0].bytes, 5000);
  assert.equal(c.resets, 0);
});

test('interface: a decrease that is not a plausible wrap is a counter reset and is dropped, not zero', () => {
  const s = [{ t: 0, v: 9_000_000_000 }, { t: 300e3, v: 100 }];
  const c = counterIntervals(s, { bits: 32, speedBps: 1e9 });
  assert.equal(c.intervals.length, 0);
  assert.equal(c.resets, 1);
});

test('interface: a gap longer than maxGapS is missing data, not traffic', () => {
  const s = [{ t: 0, v: 0 }, { t: 3 * H, v: 1e12 }];
  const c = counterIntervals(s, { bits: 64, maxGapS: 900 });
  assert.equal(c.intervals.length, 0);
  assert.equal(c.gaps, 1);
});

test('interface: intervals above the configured speed are anomalies and excluded; utilisation uses the speed', () => {
  const speed = 1e9; // 1 Gbps
  // 300 s at 500 Mbps -> 18.75 GB... use bytes: 500e6 * 300 / 8 = 18.75e6 bytes
  const bytes300 = (500e6 * 300) / 8;
  const ok = summarizeInterface([{ t: 0, v: 0 }, { t: 300e3, v: bytes300 }], { bits: 64, speedBps: speed, expectedS: 86400 });
  assert.equal(Math.round(ok.avgBps / 1e6), 500);
  assert.equal(ok.avgUtilPct, 50);
  const bad = (2e9 * 300) / 8; // 2 Gbps on a 1 Gbps interface
  const s = summarizeInterface([{ t: 0, v: 0 }, { t: 300e3, v: bad }], { bits: 64, speedBps: speed, expectedS: 86400 });
  assert.equal(s.anomalies, 1);
  assert.equal(s.bytes, 0);
  assert.equal(s.avgUtilPct, null);
});

test('interface: unknown speed yields no utilisation percentage', () => {
  const s = summarizeInterface([{ t: 0, v: 0 }, { t: 300e3, v: 1000 }], { bits: 64, speedBps: null, expectedS: 86400 });
  assert.equal(s.speedKnown, false);
  assert.equal(s.avgUtilPct, null);
  assert.equal(s.bytes, 1000);
});

test('totals: overlapping or duplicated interfaces are refused, never added together', () => {
  assert.throws(() => nonOverlappingTotal([{ key: 'A:Gi0/0', overlapsWith: ['A:Po1'] }]), /overlaps/);
  assert.throws(() => nonOverlappingTotal([{ key: 'A:Gi0/0' }, { key: 'A:Gi0/0' }]), /selected twice/);
  const t = nonOverlappingTotal([{ key: 'A:Gi0/0', summary: { bytes: 10 } }, { key: 'A:Gi0/1', summary: { bytes: 5 } }]);
  assert.equal(t.bytes, 15);
});

test('netflow: volume is sampled-estimate scaled by SamplingRate; unsampled stays observed', () => {
  const sampled = [{ bytes: 1000, samplingRate: 100 }, { bytes: 10, samplingRate: 100 }];
  assert.equal(estimatedBytes(sampled), 101000);
  assert.equal(isSampled(sampled), true);
  const unsampled = [{ bytes: 1000, samplingRate: 1 }];
  assert.equal(estimatedBytes(unsampled), 1000);
  assert.equal(isSampled(unsampled), false);
});

test('netflow: average over the full window, peak over 5-minute buckets, no fabricated change', () => {
  assert.equal(averageBps(10800, 86400), 1);   // 10800 bytes over one day = 1 bit/s
  const rows = [{ t: 0, bytes: 375000, samplingRate: 1 }, { t: 300e3, bytes: 750000, samplingRate: 1 }];
  assert.equal(peakBps(rows).peakBps, (750000 * 8) / 300);
  assert.equal(changePct(110, 100), 10);
  assert.equal(changePct(110, null), null);
  assert.equal(changePct(110, 0), null);
});

test('demo: deterministic, labelled, and missing buckets are absent rather than zero', () => {
  const a = demoDailySeries({ startMs: 0, seed: 3, gap: { fromBucket: 100, toBucket: 140 } });
  const b = demoDailySeries({ startMs: 0, seed: 3, gap: { fromBucket: 100, toBucket: 140 } });
  assert.deepEqual(a, b);
  assert.equal(a.length, 248);                       // 40 absent buckets, not zeros
  assert.ok(a.every(p => p.demo === true));
  assert.match(DEMO_LABEL, /^DEMO/);
  assert.equal(classify({ windowSeconds: 86400, observedBuckets: a.length }).status, 'PARTIAL');   // 86 % coverage
  const short = demoDailySeries({ startMs: 0, seed: 3, gap: { fromBucket: 100, toBucket: 110 } });
  assert.equal(classify({ windowSeconds: 86400, observedBuckets: short.length }).status, 'COMPLETE'); // 96.5 % coverage
});
