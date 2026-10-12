import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { netflowDashboard, interfaceDashboard, healthDashboard, liveRevision, revisionOf, FOLDER, DS_CH, DS_ZBX } from '../../reports/lib/dashboards.mjs';
import { loadInterfaceConfig } from '../../reports/lib/config.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig } from '../../reports/lib/demo-data.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';
import { NETFLOW_QUERIES, bind } from '../../reports/lib/queries.mjs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const cfg = loadInterfaceConfig(read('config/reports/interfaces.example.yaml'));

test('reference dashboards in the repository equal what the generator produces (no drift)', () => {
  for (const [file, want] of [['reports/dashboards/rpt-netflow-daily.json', netflowDashboard('live')], ['reports/dashboards/rpt-interface-daily.json', interfaceDashboard(cfg, 'live')], ['reports/dashboards/rpt-health-daily.json', healthDashboard('live')]]) {
    assert.deepEqual(JSON.parse(read(file)), JSON.parse(JSON.stringify(want)), `${file} is out of date: run grafana-report build-dashboards --interfaces config/reports/interfaces.example.yaml --out reports/dashboards`);
  }
});

test('generation is deterministic and the revision tag fingerprints the panels', () => {
  assert.equal(liveRevision('netflow'), liveRevision('netflow'));
  const a = interfaceDashboard(cfg, 'live');
  assert.equal(a.tags.find((t) => t.startsWith('rev:')), `rev:${revisionOf(a.panels)}`);
  const other = loadInterfaceConfig(read('config/reports/interfaces.example.yaml').replace('speed: 1G\n    group: wan\n    boundary: SITE-A-WAN', 'speed: 10G\n    group: wan\n    boundary: SITE-A-WAN'));
  assert.notEqual(liveRevision('interface', cfg), liveRevision('interface', other), 'a changed interface setting changes the revision, so a stale dashboard is detected');
});

test('live dashboards use the production datasources, name items (never numeric ids) and carry no demo data', () => {
  const json = JSON.stringify([netflowDashboard('live'), interfaceDashboard(cfg, 'live')]);
  assert.ok(!json.includes('itemids'), 'no Zabbix item ids');
  assert.ok(!json.includes('csv_metric_values') && !json.includes('grafana-testdata-datasource'), 'no TestData in live dashboards');
  const nf = netflowDashboard('live');
  for (const p of nf.panels) for (const t of p.targets) assert.deepEqual(t.datasource, DS_CH);
  for (const p of interfaceDashboard(cfg, 'live').panels) for (const t of p.targets) { assert.deepEqual(t.datasource, DS_ZBX); assert.equal(t.queryType, '0'); }
  assert.equal(FOLDER.title, 'NOC / Daily Reports');
});

test('every dashboard SQL target is exactly the shared report query (panels and KPIs cannot drift apart)', () => {
  const sqls = new Set(netflowDashboard('live').panels.flatMap((p) => p.targets.map((t) => t.rawSql)));
  for (const id of ['trend', 'trend_total', 'trend_prev', 'hourly', 'protocols', 'by_site', 'by_isp']) {
    const want = bind(NETFLOW_QUERIES[id].sql, null, { macro: true, variable: true });
    assert.ok(sqls.has(want), `panel query for ${id} is the shared definition`);
  }
});

test('every Zabbix target aliases its series with setAlias (the plugin ignores a plain alias property)', () => {
  for (const p of interfaceDashboard(cfg, 'live').panels) for (const t of p.targets) {
    assert.ok(t.functions.some((f) => f.def.name === 'setAlias'), `${p.title} / ${t.refId}`);
    assert.ok(t.functions.some((f) => f.def.name === 'groupBy' && f.params[0] === '5m'), 'groups to 5-minute averages');
    assert.equal(t.alias, undefined);
  }
});

test('DEMO dashboards differ only in their targets: same panel types, layout and styling', () => {
  const win = windowForDate('2026-10-11');
  const live = netflowDashboard('live');
  const demo = netflowDashboard({ demo: netflowFixture(win) });
  assert.equal(demo.panels.length, live.panels.length);
  live.panels.forEach((p, i) => { const q = demo.panels[i]; assert.equal(q.type, p.type); assert.deepEqual(q.gridPos, p.gridPos); assert.deepEqual(q.fieldConfig, p.fieldConfig); });
  const dcfg = demoInterfaceConfig();
  const dd = interfaceDashboard(dcfg, { demo: interfaceFixture(win, dcfg) });
  assert.ok(dd.title.startsWith('DEMO'));
  assert.ok(!dd.tags.includes(`rev:${liveRevision('interface', dcfg)}`), 'a DEMO dashboard can never satisfy the live revision check');
});
