import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowForDate } from '../../reports/lib/window.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig } from '../../reports/lib/demo-data.mjs';
import { buildNetflowModel } from '../../reports/lib/netflow-report.mjs';
import { buildInterfaceModel } from '../../reports/lib/interface-report.mjs';
import { buildNetflowHtml } from '../../reports/lib/netflow-html.mjs';
import { buildInterfaceHtml } from '../../reports/lib/interface-html.mjs';

const win = windowForDate('2026-10-11');
const prevWin = windowForDate('2026-10-10');
const now = Date.UTC(2026, 9, 12, 4, 0);
const nf = (scenario, demo = true) => buildNetflowModel({ win, rows: netflowFixture(win, { scenario }), nowMs: now, demo });
const ifm = (scenario, demo = true) => {
  const cfg = demoInterfaceConfig();
  const fx = interfaceFixture(win, cfg, { scenario });
  return buildInterfaceModel({ win, cfg, series: fx.series, prevSeries: fx.prevSeries, prevWin, nowMs: now, demo });
};
const stripTags = (h) => h.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');

test('netflow: complete day - volumes, averages, peaks and previous-day change come from the same rows', () => {
  const m = nf('normal');
  assert.equal(m.status, 'COMPLETE');
  const k = m.kpis;
  assert.equal(k.totalBytes, k.inboundBytes + k.outboundBytes);
  assert.equal(k.avgInBps, (k.inboundBytes * 8) / 86400);
  assert.ok(k.peakIn.bps >= k.avgInBps, 'peak is never below the average');
  assert.equal(m.coverage.observed, 288);
  assert.equal(k.sampled, true);
  assert.equal(k.previousAvailable, true);
  assert.ok(Math.abs(k.change.total) < 50);
  assert.equal(m.tables.top_src.length, 10);
  assert.ok(m.tables.top_src.every((r) => r.Share > 0));
});

test('netflow: partial day is labelled PARTIAL, understatement is stated, and no previous-day percentage is shown', () => {
  const m = nf('partial');
  assert.equal(m.status, 'PARTIAL');
  assert.ok(m.coverage.coverage < 0.95);
  assert.equal(m.kpis.previousAvailable, false);
  assert.equal(m.kpis.comparisonSuppressed, true);
  assert.equal(m.kpis.change.total, null);
  assert.ok(m.observations.some((o) => /understate/.test(o)));
  assert.ok(m.observations.some((o) => /not comparable/.test(o)));
});

test('netflow: a day without flows is NO DATA with no KPIs - never zero traffic', () => {
  const m = nf('nodata');
  assert.equal(m.status, 'NO_DATA');
  assert.equal(m.kpis, null);
  const { html, pages } = buildNetflowHtml(m, {});
  const text = stripTags(html);
  assert.equal(pages, 2);
  assert.match(text, /NO DATA/);
  assert.ok(!/(?<![\d.])0(\.0)? (B|KB|MB|GB|TB|b\/s|Kb\/s|Mb\/s|Gb\/s)\b/.test(text), 'no zero volumes or rates are printed');
  assert.ok(!/Inbound|Outbound/.test(text.replace(/Transit and unclassified[^.]*\./g, '')), 'no direction figures on a NO DATA report');
});

test('netflow: raw-flow tables are withheld (not faked) when raw retention has expired', () => {
  const old = windowForDate('2026-09-01');
  const m = buildNetflowModel({ win: old, rows: netflowFixture(old, { scenario: 'normal' }), nowMs: now, demo: false });
  assert.equal(m.tables.rawExpired, true);
  assert.deepEqual(m.tables.top_src, []);
  assert.ok(m.notes.some((n) => /14 days/.test(n)));
});

test('netflow html: DEMO label and watermark appear only for demo data', () => {
  const demo = buildNetflowHtml(nf('normal', true), {}).html;
  const real = buildNetflowHtml(nf('normal', false), {}).html;
  assert.match(demo, /DEMO - synthetic data, not measured/);
  assert.match(demo, /class="wm"/);
  assert.ok(!/DEMO - synthetic/.test(real) && !/class="wm"/.test(real) && !/ · DEMO/.test(real));
});

test('netflow html: three pages for data, volumes marked estimated when sampled, content escaped', () => {
  const m = nf('normal');
  m.tables.top_src[0].Network = '<script>alert(1)</script>';
  const { html, pages } = buildNetflowHtml(m, {});
  assert.equal(pages, 3);
  assert.equal((html.match(/<section class="page">/g) || []).length, 3);
  assert.match(html, /Inbound \(est\.\)/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('interface: complete day has per-interface figures and utilisation only where a speed is configured', () => {
  const m = ifm('normal');
  assert.equal(m.status, 'COMPLETE');
  const unknown = m.interfaces.find((s) => s.key === 'DEMO-DC-R1:Te0/2');
  assert.equal(unknown.speedBps, null);
  assert.equal(unknown.peakUtilPct, null);
  assert.ok(unknown.peakBps > 0);
  for (const s of m.interfaces.filter((x) => x.speedBps)) assert.ok(s.peakUtilPct > 0 && s.peakUtilPct <= 105, s.key);
});

test('interface: totals exist only for configured boundaries and only over intervals where all members reported', () => {
  const m = ifm('normal');
  assert.deepEqual(m.boundaries.map((b) => b.boundary), ['DEMO-HQ-WAN']);
  const hq = m.boundaries[0];
  const a = m.interfaces.find((s) => s.key === 'DEMO-HQ-R1:Gi0/0'), b = m.interfaces.find((s) => s.key === 'DEMO-HQ-R1:Gi0/1');
  assert.ok(Math.abs(hq.total.inbound.bytes - (a.inbound.bytes + b.inbound.bytes)) < 1, 'boundary total equals the sum of its members');
  assert.equal(m.kpis.inboundBytes !== undefined, true);
  const html = buildInterfaceHtml(m, {}).html;
  assert.ok(!/Total (inbound|volume)/i.test(stripTags(html)), 'no grand total across interfaces is printed');
});

test('interface: a gap makes the interface PARTIAL, lists it as missing, and suppresses its previous-day comparison', () => {
  const m = ifm('partial');
  assert.equal(m.status, 'PARTIAL');
  const s = m.interfaces.find((x) => x.key === 'DEMO-BR2-R1:Gi0/0');
  assert.equal(s.status, 'PARTIAL');
  assert.ok(s.coverage < 0.95 && s.coverage > 0.9);
  assert.equal(s.longestGapMinutes, 90);
  assert.deepEqual(s.change, { inbound: null, outbound: null });
  assert.equal(m.missing.length, 1);
  assert.equal(m.missing[0].missingMinutes, 90);
  const ok = m.interfaces.find((x) => x.key === 'DEMO-HQ-R1:Gi0/0');
  assert.notEqual(ok.change.inbound, null);
});

test('interface: no samples at all is NO DATA - no volumes, no utilisation, no zeros', () => {
  const m = ifm('nodata');
  assert.equal(m.status, 'NO_DATA');
  assert.equal(m.kpis, null);
  const { html, pages } = buildInterfaceHtml(m, {});
  const text = stripTags(html);
  assert.equal(pages, 2);
  assert.match(text, /NO DATA/);
  assert.ok(!/%/.test(text.replace(/Utilisation = rate[^.]*\./g, '').replace(/\(\+5 %\)/g, '').replace(/0%/g, '')), 'no utilisation percentages');
  assert.ok(!/(?<![\d.])0(\.0)? (B|KB|MB|GB|TB|b\/s|Kb\/s|Mb\/s|Gb\/s)\b/.test(text), 'no zero volumes or rates are printed');
});

test('interface: pagination - panels are 6 per page and the page count follows the interface count', () => {
  const cfg = demoInterfaceConfig();
  const m = ifm('normal');
  assert.equal(buildInterfaceHtml(m, {}).pages, 3);                      // summary + 1 panel page + technical
  const many = { ...m, kpis: { ...m.kpis, busiest: [] }, interfaces: Array.from({ length: 14 }, (_, i) => ({ ...m.interfaces[i % 6], key: `X:${i}`, interface: `Gi0/${i}` })) };
  const out = buildInterfaceHtml(many, {});
  assert.equal(out.pages, 1 + 3 + 2);                                    // 14 panels = 3 pages; 9 + 5 summary rows = 2 technical pages
  assert.equal((out.html.match(/<section class="page">/g) || []).length, out.pages);
  assert.ok(cfg.interfaces.length === 6);
});
