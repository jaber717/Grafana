import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveItem, pickTier, TIERS, CONFIG } from '../../reports/lib/item-patterns.mjs';
import { startGrafanaMock } from '../mocks/grafana-mock.mjs';
import { Grafana } from '../../reports/lib/grafana-client.mjs';
import { fetchHealthSeries } from '../../reports/lib/live.mjs';
import { buildHealthModel } from '../../reports/lib/health-report.mjs';
import { ALL_SCOPE } from '../../reports/lib/scope.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';
import { WALK_CPU, WALK_MEM, CLI_MEMORY_PERCENT, MEM_PREPROCESSING_REGEX, preprocess, DEVICES } from '../fixtures/huawei.mjs';

const names = (h) => DEVICES[h].map((i) => i.name);
const win = windowForDate('2026-10-11');

test('fixture: the working Huawei preprocessing picks the right memory instance (28 %, CLI ~29 %), never the first instance (0) nor the index', () => {
  assert.equal(preprocess(WALK_MEM, MEM_PREPROCESSING_REGEX), 28);
  assert.notEqual(preprocess(WALK_MEM, MEM_PREPROCESSING_REGEX), 0);
  assert.ok(Math.abs(preprocess(WALK_MEM, MEM_PREPROCESSING_REGEX) - CLI_MEMORY_PERCENT) <= 1.5, 'consistent with the device CLI within timing / rounding');
  assert.equal(preprocess(WALK_CPU, String.raw`1\.3\.6\.1\.4\.1\.2011\.6\.3\.4\.1\.2\.1\.0\.0\s*=\s*INTEGER:\s*(\d+)`), 6);
});

test('item selection: vendor names first, generic last; one item per device and metric; raw counters never used; missing = null (N/A)', () => {
  assert.deepEqual([resolveItem('cpu', names('HW-EDGE-01')).pattern, resolveItem('memory', names('HW-EDGE-01')).pattern], ['Huawei: Custom CPU', 'Huawei - Custom Memory']);
  assert.equal(resolveItem('cpu', names('HW-EDGE-02')).pattern, 'Huawei CPU utilization', 'historical name variant (hwCpuDevDuty)');
  assert.equal(resolveItem('memory', names('HW-EDGE-02')).pattern, 'Huawei Memory utilization');
  const both = resolveItem('cpu', names('HW-BOTH-03'));
  assert.equal(both.pattern, 'Huawei: Custom CPU', 'the vendor item wins over the generic one');
  assert.deepEqual(both.names, ['Huawei: Custom CPU']);
  assert.equal(resolveItem('memory', names('HW-BOTH-03')).pattern, 'Huawei - Custom Memory');
  assert.equal(resolveItem('cpu', names('CISCO-R1')).pattern, 'CPU utilization');
  assert.equal(resolveItem('memory', names('CISCO-R1')).names.length, 2, 'Cisco keeps its two memory pools (processor / I/O) inside one tier');
  assert.equal(resolveItem('memory', names('FORTI-FW')).pattern, 'Memory utilization');
  assert.equal(resolveItem('cpu', names('NO-METRICS-SW')), null);
  assert.equal(resolveItem('memory', names('NO-METRICS-SW')), null, 'a raw counter is never a utilisation');
  assert.equal(pickTier([[], [], []]).length, 0);
});

test('Device Health dashboard: one target per configured name in precedence order, first value wins, no OID / instance index', () => {
  const d = JSON.parse(readFileSync(new URL('../../dashboards/noc/noc-device-health.json', import.meta.url), 'utf8'));
  const panels = d.panels.flatMap((p) => [p, ...(p.panels || [])]);
  const fresh = panels.find((p) => /^Latest values/.test(p.title));
  const cpuT = fresh.targets.filter((t) => /^C\d/.test(t.refId)).map((t) => t.item.filter);
  assert.deepEqual(cpuT, TIERS.cpu);
  assert.ok(cpuT[0].includes('Huawei: Custom CPU') && cpuT.at(-1).includes('CPU utilization'));
  assert.deepEqual(fresh.targets.filter((t) => /^D\d/.test(t.refId)).map((t) => t.item.filter), TIERS.memory);
  const status = panels.find((p) => p.title === 'Device status');
  const fn = status.transformations.filter((t) => t.id === 'calculateField' && t.options.reduce?.reducer === 'firstNotNull');
  assert.deepEqual(fn.map((t) => t.options.alias), ['CPU', 'MEM']);
  assert.deepEqual(fn[0].options.reduce.include, TIERS.cpu.map((_, i) => `CPU${i}`));
  assert.ok(!/16777217|1\.3\.6\.1\.4\.1\.2011/.test(JSON.stringify(d)), 'no OID / SNMP instance index in the dashboard');
  assert.equal(d.uid, 'noc-device-health');
  const metric = d.templating.list.find((v) => v.name === 'metric');
  for (const n of CONFIG.cpu.names) assert.ok(metric.options.some((o) => o.value === n), `metric option for ${n}`);
});

test('daily Network Health report: Huawei custom items read as numeric percentages, one series per device, nothing fabricated', async () => {
  const t = (v) => Array.from({ length: 288 }, (_, k) => ({ t: win.startMs + k * 300e3, v }));
  const hosts = ['HW-EDGE-01', 'HW-BOTH-03', 'CISCO-R1', 'NO-METRICS-SW'];
  const devices = hosts.map((h) => ({ host: h, sites: [], types: [] }));
  // a device has samples for EVERY configured name it owns (HW-BOTH-03 has the vendor item AND the generic one that reads 0)
  const by = (kind) => Object.fromEntries(hosts.map((h) => {
    const tiers = {};
    for (const i of DEVICES[h]) { const k = resolveItem(kind, [i.name])?.tier; if (k != null) tiers[k] = t(i.value); }
    return [h, tiers];
  }).filter(([, tiers]) => Object.keys(tiers).length));
  const ping = Object.fromEntries(hosts.map((h) => [h, t(1)]));
  const g = await startGrafanaMock({ health: { series: { ping, snmp: {}, agent: {} }, byTier: { cpu: by('cpu'), mem: by('memory') } } });
  const r = await fetchHealthSeries(new Grafana({ url: g.url, token: g.token }), devices, win);
  await g.close();
  const m = buildHealthModel({ win, scope: ALL_SCOPE, devices, series: r.series, fresh: Object.fromEntries(hosts.map((h) => [h, { ping: 1 }])), seen: new Set(hosts), nowMs: win.endMs + 3600e3 });
  const d = Object.fromEntries(m.devices.map((x) => [x.host, x]));
  assert.deepEqual([d['HW-EDGE-01'].cpu.avg, d['HW-EDGE-01'].mem.avg], [6, 28], 'CPU 6 %, memory 28 % (not the raw 0, not 29)');
  assert.deepEqual([d['HW-BOTH-03'].cpu.avg, d['HW-BOTH-03'].mem.avg], [6, 28], 'vendor item wins over the generic one that reads 0');
  assert.equal(d['HW-BOTH-03'].cpu.buckets, 288, 'one series, not two merged');
  assert.equal(d['CISCO-R1'].cpu.avg, 41, 'Cisco generic items keep working');
  assert.ok(d['CISCO-R1'].mem.monitored);
  assert.equal(d['NO-METRICS-SW'].cpu.monitored, false);
  assert.equal(d['NO-METRICS-SW'].mem.monitored, false, 'raw counter not used; missing metric = N/A, not 0');
  assert.equal(d['NO-METRICS-SW'].state, 'UP');
  assert.equal(r.tiers.cpu['HW-EDGE-01'], 0);
  assert.equal(r.tiers.cpu['CISCO-R1'], TIERS.cpu.length - 1);
  assert.equal(r.tiers.cpu['NO-METRICS-SW'], undefined);
});
