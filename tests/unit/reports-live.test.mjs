import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGrafanaMock } from '../mocks/grafana-mock.mjs';
import { Grafana, GrafanaError } from '../../reports/lib/grafana-client.mjs';
import { fetchNetflowRows, fetchInterfaceSeries } from '../../reports/lib/live.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig } from '../../reports/lib/demo-data.mjs';
import { buildNetflowModel } from '../../reports/lib/netflow-report.mjs';
import { buildInterfaceModel } from '../../reports/lib/interface-report.mjs';
import { NETFLOW_QUERIES } from '../../reports/lib/queries.mjs';

const win = windowForDate('2026-10-11');
const now = Date.UTC(2026, 9, 12, 4, 0);

test('netflow live: every report query is sent to the ClickHouse datasource with the window bound by Grafana macros', async () => {
  const rows = netflowFixture(win);
  const mock = await startGrafanaMock({ netflowRows: rows });
  const g = new Grafana({ url: mock.url, token: mock.token });
  const got = await fetchNetflowRows(g, win);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(NETFLOW_QUERIES).sort());
  const sent = mock.stats.queryBodies[0];
  assert.equal(sent.from, String(win.startMs));
  assert.equal(sent.to, String(win.endMs));
  assert.ok(sent.queries.every((q) => q.rawSql.includes('$__fromTime') && q.rawSql.includes('$__toTime') || q.refId === 'newest_flow'));
  const m = buildNetflowModel({ win, rows: got, nowMs: now, demo: true });
  const direct = buildNetflowModel({ win, rows, nowMs: now, demo: true });
  assert.equal(m.kpis.inboundBytes, direct.kpis.inboundBytes, 'live path and fixture path agree');
  assert.equal(m.tables.top_src.length, 10);
  await mock.close();
});

test('netflow live: a failing query aborts - never a silent empty table', async () => {
  const mock = await startGrafanaMock({ netflowRows: netflowFixture(win), failQuery: 'top_src' });
  const g = new Grafana({ url: mock.url, token: mock.token });
  await assert.rejects(fetchNetflowRows(g, win), /top_src: Code: 60/);
  await mock.close();
});

test('grafana client: wrong token is 401 and not transient; 503 is transient', async () => {
  const mock = await startGrafanaMock({ netflowRows: {}, fail503: 1 });
  const bad = new Grafana({ url: mock.url, token: 'wrong' });
  await assert.rejects(bad.query([], { fromMs: 0, toMs: 1 }), (e) => e instanceof GrafanaError && e.status === 401 && e.transient === false);
  const good = new Grafana({ url: mock.url, token: mock.token });
  await assert.rejects(good.query([], { fromMs: 0, toMs: 1 }), (e) => e.status === 503 && e.transient === true);
  await mock.close();
});

test('grafana client: render returns a PNG of exactly the requested size and rejects a renderer that enforces another size', async () => {
  const mock = await startGrafanaMock({});
  const g = new Grafana({ url: mock.url, token: mock.token });
  const png = await g.renderPanel({ uid: 'u', panelId: 3, fromMs: win.startMs, toMs: win.endMs - 60000, width: 507, height: 159 });
  assert.equal(png.readUInt32BE(16), 1014);
  assert.equal(png.readUInt32BE(20), 318);
  assert.equal(mock.stats.lastRender.tz, 'Asia/Riyadh');
  assert.equal(mock.stats.lastRender.hideLogo, 'true');
  assert.equal(mock.stats.lastRender.theme, 'light');
  await mock.close();
  const small = await startGrafanaMock({ renderSizeOverride: { w: 2000, h: 1000 } });
  await assert.rejects(new Grafana({ url: small.url, token: small.token }).renderPanel({ uid: 'u', panelId: 1, fromMs: 0, toMs: 1, width: 507, height: 159 }), /BROWSER_MIN_HEIGHT/);
  await small.close();
});

test('interface live: series come back per interface and direction and feed the model', async () => {
  const cfg = demoInterfaceConfig();
  const fx = interfaceFixture(win, cfg);
  const prevWin = windowForDate('2026-10-10');
  const mock = await startGrafanaMock({ cfg, ifaceSeries: fx.series });
  const g = new Grafana({ url: mock.url, token: mock.token });
  const { series, issues } = await fetchInterfaceSeries(g, cfg, win);
  assert.deepEqual(issues, {});
  assert.equal(series['DEMO-HQ-R1:Gi0/0'].inbound.length, 288);
  const sent = mock.stats.queryBodies[0].queries[0];
  assert.equal(sent.queryType, '0');
  assert.equal(sent.host.filter, 'DEMO-HQ-R1');
  assert.match(sent.item.filter, /Bits received$/);
  assert.ok(!JSON.stringify(sent).match(/itemids/), 'no numeric item ids are used');
  const m = buildInterfaceModel({ win, cfg, series, prevSeries: {}, prevWin, nowMs: now, demo: true });
  assert.equal(m.status, 'COMPLETE');
  await mock.close();
});

test('interface live: missing and ambiguous item matches are reported as issues, never guessed', async () => {
  const cfg = demoInterfaceConfig();
  const fx = interfaceFixture(win, cfg);
  const mock = await startGrafanaMock({ cfg, ifaceSeries: fx.series, missingItems: new Set(['DEMO-BR1-R1:Gi0/0']), duplicateItems: new Set(['DEMO-DC-R1:Te0/1']) });
  const g = new Grafana({ url: mock.url, token: mock.token });
  const { series, issues } = await fetchInterfaceSeries(g, cfg, win);
  assert.match(issues['DEMO-DC-R1:Te0/1'], /matched 2 items/);
  assert.equal(issues['DEMO-BR1-R1:Gi0/0'], undefined, 'a missing item is plain missing data (no frames), not a configuration issue');
  assert.equal(series['DEMO-BR1-R1:Gi0/0'].inbound.length, 0);
  const m = buildInterfaceModel({ win, cfg, series, prevSeries: {}, issues, prevWin: null, nowMs: now, demo: true });
  const dc = m.interfaces.find((s) => s.key === 'DEMO-DC-R1:Te0/1');
  assert.equal(dc.status, 'NO_DATA');
  assert.ok(m.missing.some((x) => x.key === 'DEMO-DC-R1:Te0/1' && /matched 2 items/.test(x.reason)));
  assert.equal(m.interfaces.find((s) => s.key === 'DEMO-BR1-R1:Gi0/0').status, 'NO_DATA');
  assert.equal(m.status, 'PARTIAL');
  await mock.close();
});
