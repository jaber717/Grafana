import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeviceHealth } from '../../tools/monitoring/device-health.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const flat = (d) => d.panels.flatMap((p) => [p, ...(p.panels || [])]);

test('device health: the committed dashboard is exactly what the generator builds from the frozen v1.0.1 base', () => {
  const built = buildDeviceHealth(rd('tools/monitoring/base/noc-device-health.json'));
  const committed = rd('dashboards/noc/noc-device-health.json');
  const norm = (d) => JSON.stringify(d, (k, v) => (k === 'id' && typeof v === 'number' && v > 1e6 ? undefined : v));
  assert.equal(norm({ ...committed, id: null, version: null }), norm({ ...built, id: null, version: null }));
});

test('device health: original uid, original panels (ids, queries) and tags are preserved', () => {
  const base = rd('tools/monitoring/base/noc-device-health.json');
  const d = rd('dashboards/noc/noc-device-health.json');
  assert.equal(d.uid, base.uid);
  assert.deepEqual(d.tags, base.tags);
  const legacy = d.panels.find((p) => p.type === 'row' && p.collapsed).panels;
  assert.deepEqual(legacy.map((p) => p.id), base.panels.map((p) => p.id));
  base.panels.forEach((p, i) => assert.deepEqual(legacy[i].targets, p.targets));
});

test('device health: standard variable names, native selectors only, no hard-coded devices', () => {
  const d = rd('dashboards/noc/noc-device-health.json');
  const names = d.templating.list.map((v) => v.name);
  for (const n of ['site', 'device_group', 'device', 'metric']) assert.ok(names.includes(n), n);
  assert.ok(d.links.some((l) => l.type === 'dashboards' && l.includeVars && l.keepTime));
  const newPanels = d.panels.filter((p) => p.type !== 'row' && p.id >= 100);
  assert.ok(!JSON.stringify(newPanels).match(/SITE-A|SITE-B|itemids/), 'new section must not name devices or item ids');
});

test('device health: all five states are distinct in the mapping and a reachable device without CPU/Memory is not DOWN', () => {
  const d = rd('dashboards/noc/noc-device-health.json');
  const status = flat(d).find((p) => p.title === 'Device status');
  const map = status.fieldConfig.overrides.find((o) => o.matcher.options === 'State').properties.find((p) => p.id === 'mappings').value;
  const text = JSON.stringify(map);
  for (const s of ['UP', 'DOWN', 'UNKNOWN', 'NO DATA', 'NOT MONITORED']) assert.ok(text.includes(`"${s}"`), s);
  // code = SEEN(1000) + PING(100 down / 200 up) + SNMP(1 unknown / 2 ok / 3 unavailable); CPU and Memory are not part of it
  const calc = status.transformations.find((t) => t.id === 'calculateField').options.reduce.include;
  assert.deepEqual(calc, ['PING', 'SNMP', 'SEEN']);
  const vals = map[0].options;
  assert.equal(vals[1002].text, 'UP');       // SNMP-only device
  assert.equal(map.find((m) => m.type === 'range' && m.options.from === 1200).options.result.text, 'UP');   // ping up, any SNMP/CPU/Memory
});

test('wan: original uid and six link panels preserved; standard variables; series are never summed', async () => {
  const { buildWan } = await import('../../tools/monitoring/wan.mjs');
  const base = rd('tools/monitoring/base/noc-wan-overview.json');
  const d = rd('dashboards/noc/noc-wan-overview.json');
  assert.equal(d.uid, base.uid);
  const legacy = d.panels.find((p) => p.type === 'row' && p.collapsed).panels;
  assert.deepEqual(legacy.map((p) => p.id), base.panels.map((p) => p.id));
  base.panels.forEach((p, i) => assert.deepEqual(legacy[i].targets, p.targets));
  const names = d.templating.list.map((v) => v.name);
  for (const n of ['site', 'device_group', 'device', 'interface', 'direction', 'metric']) assert.ok(names.includes(n), n);
  const norm = (x) => JSON.stringify({ ...x, id: null, version: null });
  assert.equal(norm(d), norm(buildWan(base)));
  const text = JSON.stringify(d.panels.filter((p) => p.type !== 'row'));
  assert.ok(!/sumSeries|"sum"[^]*Bits/.test(text.replace(/reducers":\["sum"\]/g, '')), 'bandwidth must not be summed across interfaces');
  assert.ok(!/itemids|SITE-A|STC|MOBILY/.test(text), 'new section carries no item ids or device names');
});
