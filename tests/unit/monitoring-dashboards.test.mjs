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
  const calc = status.transformations.find((t) => t.id === 'calculateField' && t.options.alias === 'STATE').options.reduce.include;
  assert.deepEqual(calc, ['PING', 'SNMP', 'AGENT', 'SEEN']);
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

const NETFLOW = ['netflow-overview', 'netflow-top-talkers', 'netflow-asn', 'netflow-exporters', 'netflow-health'];
test('netflow: every dashboard uses the standard selectors and the nav link that carries them', () => {
  for (const uid of NETFLOW) {
    const d = rd(`dashboards/netflow/${uid}.json`);
    const names = d.templating.list.map((v) => v.name);
    for (const n of ['site', 'device_group', 'device', 'exporter']) assert.ok(names.includes(n), `${uid} ${n}`);
    assert.ok(!names.includes('iface'), `${uid} still uses the old iface variable`);
    assert.ok(d.links.some((l) => l.type === 'dashboards' && l.includeVars && l.keepTime), uid);
  }
  assert.deepEqual(['site', 'device_group', 'device'].map((n) => rd('dashboards/netflow/netflow-overview.json').templating.list.find((v) => v.name === n).datasource.uid), ['zabbix-lab', 'zabbix-lab', 'zabbix-lab']);
});

test('netflow: configured devices stay selectable and status never claims DOWN from traffic', () => {
  const d = rd('dashboards/netflow/netflow-exporters.json');
  const ex = d.templating.list.find((v) => v.name === 'exporter');
  assert.match(ex.query, /arrayJoin\(\[\$\{device:singlequote\}\]\)/, 'effective exporter set starts from the Zabbix inventory');
  const txt = JSON.stringify(d.panels.map((p) => p.targets).filter(Boolean));
  assert.ok(txt.includes("'NO DATA'") && txt.includes('NOT IN INVENTORY') && txt.includes("'ACTIVE'") && txt.includes('IDLE / NO RECENT FLOWS'));
  assert.ok(!/'DOWN'|"DOWN"/.test(JSON.stringify(d)), 'no DOWN state on NetFlow dashboards');
});

test('netflow health: no 57-year flow age, no phantom FLOWING, platform tiles ignore the selection', () => {
  for (const uid of NETFLOW) {
    const d = rd(`dashboards/netflow/${uid}.json`);
    for (const p of d.panels.filter((x) => /LAST REAL FLOW/.test(x.title))) assert.match(p.targets[0].rawSql, /if\(count\(\) = 0, NULL, dateDiff/, `${uid}: last flow age must be NULL without flows`);
    assert.ok(!JSON.stringify(d).includes('FLOWING'), `${uid}: misleading FLOWING state`);
  }
  const h = rd('dashboards/netflow/netflow-health.json');
  for (const t of ['CLICKHOUSE', 'CLICKHOUSE MEMORY', 'DISK UTILIZATION', 'QUERY HEALTH (p95)']) {
    const sql = h.panels.find((p) => p.title === t).targets[0].rawSql;
    assert.ok(!/\$\{(site|device|exporter|device_group)/.test(sql), `${t} must be independent of the selection`);
  }
  const col = h.panels.find((p) => p.title === 'FLOW COLLECTION');
  assert.ok(!JSON.stringify(col.fieldConfig).includes('"red"'), 'no red for "no traffic"');
});

test('every ${variable} used by a NetFlow or NOC dashboard is defined by that dashboard (an undefined one stays literal text in Grafana and silently breaks the query)', async () => {
  const { readdirSync } = await import('node:fs');
  for (const dir of ['netflow', 'noc']) {
    for (const f of readdirSync(join(ROOT, 'dashboards', dir)).filter((x) => x.endsWith('.json'))) {
      const d = rd(`dashboards/${dir}/${f}`);
      const defined = new Set(d.templating.list.map((v) => v.name));
      // the original panels kept in the collapsed legacy row use '$A'-style expression references, not variables
      const text = JSON.stringify([d.panels.filter((p) => !(p.type === 'row' && /^Original /.test(p.title))), d.templating.list.map((v) => v.query)]);
      const used = new Set([...text.matchAll(/\$\{?(\w+)/g)].map((m) => m[1]).filter((n) => !n.startsWith('__') && !/^\d+$/.test(n)));   // $1 in renameByRegex patterns is a capture group
      for (const n of used) assert.ok(defined.has(n), `${dir}/${f}: \${${n}} is used but not defined`);
    }
  }
});
