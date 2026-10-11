import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../../reports/lib/yaml.mjs';
import { loadInterfaceConfig, parseSpeed } from '../../reports/lib/config.mjs';
import { summarizeRates } from '../../reports/lib/interface-math.mjs';

const example = readFileSync(new URL('../../config/reports/interfaces.example.yaml', import.meta.url), 'utf8');
const base = (extra = '') => `groups:\n  - id: wan\n    title: WAN\ninterfaces:\n${extra}`;
const ifc = (o = {}) => `  - site: S\n    device: ${o.device || 'D1'}\n    interface: ${o.interface || 'Gi0/0'}\n    group: wan\n${o.include === undefined ? '    include: true\n' : o.include === null ? '' : `    include: ${o.include}\n`}${o.extra || ''}`;

test('yaml: maps, lists, scalars, comments and quoted strings', () => {
  const v = parseYaml('a: 1\nb: "x # not a comment"  # comment\nc:\n  - one\n  - two\nd:\n  e: true\n  f: [1, 2, three]\n  g: ~\nlist:\n  - k: v\n    n: 2\n  - k: w\n');
  assert.deepEqual(v, { a: 1, b: 'x # not a comment', c: ['one', 'two'], d: { e: true, f: [1, 2, 'three'], g: null }, list: [{ k: 'v', n: 2 }, { k: 'w' }] });
});

test('yaml: unsupported or ambiguous syntax is rejected, not guessed', () => {
  assert.throws(() => parseYaml('a: &x 1'), /unsupported/);
  assert.throws(() => parseYaml('a: {b: 1}'), /unsupported/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\tb: 1'), /tabs/);
});

test('config: the shipped example loads - SITE-A and SITE-B included, the others excluded', () => {
  const c = loadInterfaceConfig(example);
  assert.deepEqual(c.interfaces.map((i) => i.key), ['SITE-A:Gi0/0', 'SITE-B:Gi0/0']);
  assert.deepEqual(c.excluded.map((i) => i.key), ['STC:Gi0/0', 'MOBILY:Gi0/0']);
  const a = c.interfaces[0];
  assert.equal(a.speedBps, 1e9);
  assert.equal(a.inboundItem, 'Interface Gi0/0(TO-SAIX-A-Gi0/1): Bits received');
  assert.equal(a.outboundItem, 'Interface Gi0/0(TO-SAIX-A-Gi0/1): Bits sent');
  assert.deepEqual(c.boundaries, ['SITE-A-WAN', 'SITE-B-WAN']);
  assert.ok(!JSON.stringify(c).match(/\b5\d{4}\b/), 'no Zabbix item ids anywhere in the configuration');
});

test('config: include is mandatory, nothing is included implicitly', () => {
  assert.throws(() => loadInterfaceConfig(base(ifc({ include: null }))), /'include' must be true or false/);
});

test('config: duplicates, unknown groups and bad directions are rejected', () => {
  assert.throws(() => loadInterfaceConfig(base(ifc() + ifc())), /listed twice/);
  assert.throws(() => loadInterfaceConfig(base(ifc().replace('group: wan', 'group: nope'))), /unknown group/);
  assert.throws(() => loadInterfaceConfig(base(ifc({ extra: '    traffic_direction: sideways\n' }))), /traffic_direction/);
});

test('config: customer-facing interfaces swap the inbound and outbound items', () => {
  const c = loadInterfaceConfig(base(ifc({ extra: '    traffic_direction: customer-facing\n' })));
  assert.match(c.interfaces[0].inboundItem, /Bits sent$/);
  assert.match(c.interfaces[0].outboundItem, /Bits received$/);
});

test('config: overlapping interfaces in one boundary are refused; different boundaries are fine', () => {
  const a = ifc({ device: 'R1', interface: 'Po1', extra: '    boundary: B\n    overlaps_with: [R1:Gi0/1]\n' });
  const b = ifc({ device: 'R1', interface: 'Gi0/1', extra: '    boundary: B\n' });
  assert.throws(() => loadInterfaceConfig(base(a + b)), /overlaps R1:Gi0\/1 inside boundary 'B'/);
  const b2 = ifc({ device: 'R1', interface: 'Gi0/1', extra: '    boundary: OTHER\n' });
  assert.doesNotThrow(() => loadInterfaceConfig(base(a + b2)));
});

test('speed: units, bare numbers and unknown', () => {
  assert.equal(parseSpeed('100M'), 100e6);
  assert.equal(parseSpeed('10Gbps'), 10e9);
  assert.equal(parseSpeed(1000000000), 1e9);
  assert.equal(parseSpeed(null), null);
  assert.equal(parseSpeed('unknown'), null);
  assert.throws(() => parseSpeed('fast'), /cannot read speed/);
  assert.throws(() => parseSpeed(0), /> 0/);
});

test('rates: volume is the sum of bucket volumes; missing buckets lower coverage but never become zero traffic', () => {
  const t0 = 0;
  const s = Array.from({ length: 144 }, (_, k) => ({ t: t0 + k * 300e3, bps: 100e6 }));        // half a day at 100 Mbps
  const r = summarizeRates(s, { speedBps: 1e9, expectedS: 86400, stepS: 300 });
  assert.equal(r.bytes, (100e6 * 300 / 8) * 144);
  assert.equal(r.avgBps, 100e6);                          // averaged over covered time, not over the full day
  assert.equal(r.avgUtilPct, 10);
  assert.equal(r.coverage, 0.5);
  assert.equal(r.peakBps, 100e6);
});

test('rates: anomalies above the configured speed are excluded and counted; duplicates and nulls are ignored', () => {
  const s = [{ t: 0, bps: 5e8 }, { t: 300e3, bps: 3e9 }, { t: 600e3, bps: null }, { t: 0, bps: 9e8 }, { t: 900e3, bps: -1 }];
  const r = summarizeRates(s, { speedBps: 1e9, expectedS: 1200, stepS: 300 });
  assert.equal(r.anomalies, 1);
  assert.equal(r.invalid, 3);
  assert.equal(r.coveredS, 300);
  assert.equal(r.peakBps, 5e8);
});

test('rates: no samples gives nulls (NO DATA), never zeros; unknown speed gives no utilisation', () => {
  const none = summarizeRates([], { speedBps: 1e9, expectedS: 86400 });
  assert.equal(none.bytes, null);
  assert.equal(none.avgBps, null);
  assert.equal(none.peakBps, null);
  assert.equal(none.avgUtilPct, null);
  assert.equal(none.coverage, 0);
  const unk = summarizeRates([{ t: 0, bps: 1e6 }], { speedBps: null, expectedS: 86400 });
  assert.equal(unk.speedKnown, false);
  assert.equal(unk.avgUtilPct, null);
});
