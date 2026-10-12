import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScopes, pickScope, makeScope, resolveDevices, scopeInterfaces, hostRegex, isAllScope, scopeLabel, ALL_SCOPE } from '../../reports/lib/scope.mjs';
import { parseHosts } from '../../reports/lib/inventory.mjs';
import { buildHealthModel, stateCode, stateOf } from '../../reports/lib/health-report.mjs';
import { buildHealthHtml } from '../../reports/lib/health-html.mjs';
import { healthFixture, DEMO_HEALTH_DEVICES, demoInterfaceConfig } from '../../reports/lib/demo-data.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';
import { NETFLOW_QUERIES, bind } from '../../reports/lib/queries.mjs';

const win = windowForDate('2026-10-11');
const NOW = win.endMs + 4 * 3600e3;
const model = (o = {}) => { const fx = healthFixture(win, { scenario: o.scenario || 'normal' }); return buildHealthModel({ win, scope: o.scope || ALL_SCOPE, devices: o.devices || fx.devices, series: fx.series, fresh: fx.fresh, seen: fx.seen, nowMs: NOW, demo: true }); };

// ---- scopes ----------------------------------------------------------------------------------------------------------------------------
const YAML = ['scopes:', '  - id: hq-routers', '    title: HQ routers', '    site: DEMO-HQ', '    device_group: Router', '    metrics: availability, cpu',
  '  - id: two-boxes', '    devices: DEMO-DC-R1, DEMO-BR1-R1', '    interfaces: Gi0/0', 'default_scope: hq-routers', ''].join('\n');

test('scopes: the built-in "all" scope exists without a file; saved scopes load; the default can be chosen', () => {
  const none = loadScopes(null);
  assert.equal(pickScope(none).id, 'all');
  assert.ok(isAllScope(pickScope(none)));
  const cfg = loadScopes(YAML);
  assert.equal(pickScope(cfg).id, 'hq-routers', 'default_scope');
  assert.deepEqual(pickScope(cfg, 'hq-routers').metrics, ['availability', 'cpu']);
  assert.deepEqual(pickScope(cfg, 'two-boxes').devices, ['DEMO-DC-R1', 'DEMO-BR1-R1']);
  assert.throws(() => pickScope(cfg, 'nope'), /unknown scope 'nope'/);
});

test('scopes: invalid definitions are refused with a reason', () => {
  assert.throws(() => loadScopes('scopes:\n  - id: all\n'), /built-in/);
  assert.throws(() => loadScopes('scopes:\n  - id: a\n  - id: a\n'), /defined twice/);
  assert.throws(() => loadScopes('scopes:\n  - id: a\n    metrics: voltage\n'), /unknown metric 'voltage'/);
  assert.throws(() => loadScopes('scopes:\n  - id: a\n    site: "x\' OR 1=1"\n'), /not allowed in a name/);
  assert.throws(() => makeScope({ id: 'Bad Id' }), /lowercase/);
  assert.throws(() => loadScopes('default_scope: ghost\n'), /not defined/);
});

test('scopes: site, device type and device names combine with AND against the Zabbix inventory; new devices join without any edit', () => {
  const inv = DEMO_HEALTH_DEVICES;
  const hq = pickScope(loadScopes(YAML), 'hq-routers');
  assert.deepEqual(resolveDevices(hq, inv).map((d) => d.host), ['DEMO-HQ-R1', 'DEMO-HQ-R2']);
  const grown = [...inv, { host: 'DEMO-HQ-R3', sites: ['DEMO-HQ'], types: ['Router'] }];
  assert.deepEqual(resolveDevices(hq, grown).map((d) => d.host), ['DEMO-HQ-R1', 'DEMO-HQ-R2', 'DEMO-HQ-R3'], 'a device added to Zabbix with the right groups is in scope');
  assert.deepEqual(resolveDevices(pickScope(loadScopes(YAML), 'two-boxes'), inv).map((d) => d.host), ['DEMO-BR1-R1', 'DEMO-DC-R1']);
  assert.equal(resolveDevices(ALL_SCOPE, inv).length, inv.length);
  assert.match(scopeLabel(hq, 2), /site DEMO-HQ · type Router · metrics availability, cpu · 2 devices/);
});

test('scopes: interfaces are only filtered, never added; a site/type scope needs the inventory', () => {
  const cfg = demoInterfaceConfig();
  const hq = pickScope(loadScopes(YAML), 'hq-routers');
  const r = scopeInterfaces(hq, cfg, resolveDevices(hq, DEMO_HEALTH_DEVICES));
  assert.deepEqual(r.interfaces.map((i) => i.key), ['DEMO-HQ-R1:Gi0/0', 'DEMO-HQ-R1:Gi0/1']);
  assert.deepEqual(r.boundaries, ['DEMO-HQ-WAN']);
  const two = scopeInterfaces(pickScope(loadScopes(YAML), 'two-boxes'), cfg);
  assert.deepEqual(two.interfaces.map((i) => i.key), ['DEMO-BR1-R1:Gi0/0'], 'device AND interface name');
  assert.throws(() => scopeInterfaces(hq, cfg), /inventory is needed/);
  assert.equal(scopeInterfaces(ALL_SCOPE, cfg), cfg);
});

test('scopes: host regex literal escapes regex characters', () => {
  assert.equal(hostRegex(['a.b', 'c-d']), '/^(a\\.b|c-d)$/');
  assert.equal(hostRegex([]), '/^$/');
});

test('inventory: hosts become device / site / type rows; disabled hosts are left out', () => {
  const rows = parseHosts([
    { hostid: '1', host: 'r1', name: 'Router 1', status: '0', hostgroups: [{ name: 'Site/HQ' }, { name: 'Type/Router' }, { name: 'Other' }] },
    { hostid: '2', host: 'r2', name: 'r2', status: '1', hostgroups: [] },
    { hostid: '3', host: 'sw', name: 'sw', status: '0', groups: [{ name: 'Site/DC' }] },
  ]);
  assert.deepEqual(rows.map((r) => [r.host, r.sites, r.types]), [['Router 1', ['HQ'], ['Router']], ['sw', ['DC'], []]]);
});

// ---- state logic: identical to the NOC Device Health dashboard ------------------------------------------------------------------------------
test('device state codes follow the dashboard: the report and the dashboard cannot disagree', () => {
  const dash = JSON.parse(readFileSync(new URL('../../dashboards/noc/noc-device-health.json', import.meta.url), 'utf8'));
  const status = dash.panels.find((p) => p.title === 'Device status');
  const maps = status.fieldConfig.overrides.find((o) => o.matcher.options === 'State').properties.find((p) => p.id === 'mappings').value;
  const dashLabel = (code) => {
    for (const m of maps) {
      if (m.type === 'value' && m.options[code]) return m.options[code].text;
      if (m.type === 'range' && code >= m.options.from && code <= m.options.to) return m.options.result.text;
    }
    return 'NOT MONITORED';
  };
  const label = { UP: 'UP', DOWN: 'DOWN', UNKNOWN: 'UNKNOWN', NO_DATA: 'NO DATA', NOT_MONITORED: 'NOT MONITORED' };
  for (const seen of [false, true]) for (const ping of [null, 0, 1]) for (const snmp of [null, 0, 1, 2]) for (const agent of [null, 0, 1]) {
    const code = stateCode({ ping, snmp, agent, seen });
    if (!seen && (ping != null || snmp != null || agent != null)) continue;      // data cannot be fresh without having been seen
    assert.equal(label[stateOf(code)], dashLabel(code), `code ${code} (seen ${seen}, ping ${ping}, snmp ${snmp}, agent ${agent})`);
  }
});

// ---- the model -------------------------------------------------------------------------------------------------------------------------
test('health model: every state is distinct and a reachable device without CPU / memory stays UP', () => {
  const m = model();
  const by = Object.fromEntries(m.devices.map((d) => [d.host, d]));
  assert.equal(by['DEMO-HQ-SW1'].state, 'UP');
  assert.equal(by['DEMO-HQ-SW1'].cpu.monitored, false);
  assert.equal(by['DEMO-HQ-SW1'].mem.monitored, false);
  assert.equal(by['DEMO-BR1-R1'].state, 'DOWN');
  assert.equal(by['DEMO-BR2-R1'].state, 'NO_DATA', 'silent at the end of the day is not DOWN');
  assert.equal(by['DEMO-BR2-AP1'].state, 'UNKNOWN');
  assert.equal(by['DEMO-BR2-SW1'].state, 'NOT_MONITORED');
  assert.equal(by['DEMO-HQ-R2'].state, 'UP', 'recovered after a short outage');
  assert.equal(by['DEMO-HQ-R2'].downMinutes, 40);
  assert.deepEqual([m.kpis.up, m.kpis.down, m.kpis.unknown, m.kpis.noData, m.kpis.notMonitored], [4, 1, 1, 1, 1]);
  assert.equal(by['DEMO-BR2-AP1'].availability, null, 'SNMP "unknown" is no information: neither up nor down time');
  assert.equal(by['DEMO-BR2-AP1'].downMinutes, 0);
  assert.equal(m.status, 'PARTIAL');
  assert.ok(m.attention.some((a) => a.host === 'DEMO-DC-R1' && /CPU peaked at 93/.test(a.reasons.join())), 'CPU alert on an UP device');
  assert.ok(!m.attention.some((a) => a.host === 'DEMO-HQ-SW1'), 'a healthy ping-only switch is not an attention item');
  assert.match(m.observations.join(' '), /reachable but has no CPU or memory data \(DEMO-HQ-SW1\); they are not counted as down/);
});

test('health model: a scope without cpu / memory leaves them out; a no-data day and an empty scope are NO_DATA, never "healthy"', () => {
  const only = makeScope({ id: 'a', metrics: 'availability' });
  const m = model({ scope: only });
  assert.equal(m.devices[0].cpu, null);
  assert.equal(m.kpis.peakCpu, null);
  const none = model({ scenario: 'nodata' });
  assert.equal(none.status, 'NO_DATA');
  assert.match(none.observations[0], /absence of data is not reported as a healthy network/);
  assert.deepEqual([none.kpis.up, none.kpis.down], [0, 0]);
  const empty = buildHealthModel({ win, scope: makeScope({ id: 'x', site: 'NOWHERE' }), devices: [], series: { ping: {}, snmp: {}, cpu: {}, mem: {} }, nowMs: NOW, scopeText: 'site NOWHERE' });
  assert.equal(empty.status, 'NO_DATA');
  assert.match(empty.observations[0], /matches no monitored device/);
});

test('health model: a partial day marks the device and says why', () => {
  const m = model({ scenario: 'partial' });
  const hq = m.devices.find((d) => d.host === 'DEMO-HQ-R1');
  assert.ok(hq.coverage < 0.95);
  assert.ok(m.attention.find((a) => a.host === 'DEMO-HQ-R1').reasons.some((r) => /coverage/.test(r)));
});

// ---- pages -----------------------------------------------------------------------------------------------------------------------------
test('health report pages: 3 pages with data, 2 without; DEMO is labelled on every page; nothing is shown as healthy without data', () => {
  const full = buildHealthHtml(model(), { timeline: Buffer.from('x'), avail: Buffer.from('x'), cpu: Buffer.from('x'), mem: Buffer.from('x') });
  assert.equal(full.pages, 3);
  assert.equal((full.html.match(/DEMO – SYNTHETIC DATA/g) || []).length, 3);
  assert.match(full.html, /Page 3 of 3/);
  for (const s of ['UP', 'DOWN', 'UNKNOWN', 'NO DATA', 'NOT MONITORED']) assert.ok(full.html.includes(`>${s}</span>`), s);
  const nd = buildHealthHtml(model({ scenario: 'nodata' }));
  assert.equal(nd.pages, 2);
  assert.match(nd.html, />NO DATA</);
  assert.ok(!/Average availability<\/div><div class="v">\d/.test(nd.html), 'no availability figure on a no-data day');
  const big = Array.from({ length: 30 }, (_, i) => ({ host: `d${i}`, sites: ['S'], types: ['Router'] }));
  const m = buildHealthModel({ win, scope: ALL_SCOPE, devices: big, series: { ping: Object.fromEntries(big.map((d) => [d.host, [{ t: win.startMs, v: 1 }]])), snmp: {}, cpu: {}, mem: {} }, fresh: {}, seen: new Set(big.map((d) => d.host)), nowMs: NOW });
  assert.equal(buildHealthHtml(m, {}).pages, 3 + 2, 'long device lists continue on extra technical pages');
});

// ---- NetFlow scope ---------------------------------------------------------------------------------------------------------------------
test('netflow queries: the exporter scope is a placeholder everywhere; dashboards use the variable, the client the literal list', () => {
  for (const [id, q] of Object.entries(NETFLOW_QUERIES)) assert.ok(q.sql.includes('{EXP}'), `${id} must carry the scope filter`);
  const sql = bind(NETFLOW_QUERIES.totals.sql, win, { macro: true, exporters: ['A', 'B'] });
  assert.match(sql, /ExporterName IN \('A', 'B'\)/);
  assert.ok(!bind(NETFLOW_QUERIES.totals.sql, win).includes('ExporterName IN'), 'no scope: no filter');
  assert.match(bind(NETFLOW_QUERIES.totals.sql, win, { exporters: [] }), /AND 0/, 'a scope that matches no device returns nothing');
  assert.match(bind(NETFLOW_QUERIES.trend.sql, null, { macro: true, variable: true }), /\$\{exp_scope\}/);
});

test('scope devices with unsafe names are skipped, never interpolated into queries', async () => {
  const { resolveRunScope } = await import('../../reports/lib/generate.mjs');
  const events = [];
  const inv = [{ host: "ok-1", sites: [], types: [] }, { host: "bad'name", sites: [], types: [] }, { host: 'a,b', sites: [], types: [] }, { host: 'r1.example', sites: [], types: [] }];
  const r = await resolveRunScope({ g: null, settings: { scopesFile: null, retry: { attempts: 1, baseMs: 1, maxMs: 1 } }, scopeId: null, kinds: ['health'], log: (e) => events.push(e), deps: { inventory: async () => inv } });
  assert.deepEqual(r.devices.map((d) => d.host), ['ok-1', 'r1.example']);
  assert.deepEqual(events.filter((e) => e.event === 'device-skipped').map((e) => e.host), ['a,b', "bad'name"]);
});

test('availability sources stay distinct: ICMP first, then SNMP, then Zabbix agent; the agent proves nothing about interfaces', async () => {
  const { stateCode, stateOf, basisOf } = await import('../../reports/lib/health-report.mjs');
  const st = (o) => { const c = stateCode({ seen: true, ...o }); return [stateOf(c), basisOf(c)]; };
  assert.deepEqual(st({ ping: 1, agent: 0 }), ['UP', 'ICMP']);
  assert.deepEqual(st({ ping: 0, agent: 1 }), ['DOWN', 'ICMP'], 'ICMP failing is not hidden by a healthy agent');
  assert.deepEqual(st({ snmp: 1, agent: 0 }), ['UP', 'SNMP']);
  assert.deepEqual(st({ snmp: 2, agent: 1 }), ['DOWN', 'SNMP']);
  assert.deepEqual(st({ agent: 1 }), ['UP', 'Agent']);
  assert.deepEqual(st({ agent: 0 }), ['DOWN', 'Agent']);
  assert.deepEqual(st({ snmp: 0, agent: 1 }), ['UP', 'Agent'], 'SNMP unknown does not override a working agent');
  assert.deepEqual(st({ snmp: 0 }), ['UNKNOWN', 'SNMP']);
  assert.deepEqual(st({}), ['NO_DATA', null]);
  // an agent-only device is UP but has no availability percentage and says "Agent" as its basis
  const dev = [{ host: 'srv', sites: [], types: [] }];
  const t0 = win.startMs;
  const m = buildHealthModel({ win, scope: ALL_SCOPE, devices: dev, series: { ping: {}, snmp: {}, agent: { srv: Array.from({ length: 288 }, (_, k) => ({ t: t0 + k * 300e3, v: 1 })) }, cpu: {}, mem: {} }, fresh: { srv: { agent: 1 } }, nowMs: NOW });
  assert.equal(m.devices[0].state, 'UP');
  assert.equal(m.devices[0].basis, 'Agent');
  assert.equal(m.devices[0].availability, null);
  assert.match(m.notes.join(' '), /does not prove that interfaces or services are reachable/);
});

test('item patterns: Cisco and Huawei CPU / memory names are configured, never hard-coded, and raw counters are refused', async () => {
  const { REGEX, PATTERN } = await import('../../reports/lib/item-patterns.mjs');
  for (const n of ['#1: CPU utilization', 'CPU utilization', 'Huawei: Custom CPU']) assert.ok(REGEX.cpu.test(n), n);
  for (const n of ['Processor: Memory utilization', 'I/O: Memory utilization', 'Memory utilization']) assert.ok(REGEX.memory.test(n), n);
  for (const n of ['Huawei - Memory Raw', 'Processor: Free memory', 'Total memory', 'Used memory']) assert.ok(!REGEX.memory.test(n), `${n} is not a utilisation percentage`);
  assert.ok(REGEX.icmp.test('ICMP ping') && !REGEX.icmp.test('Zabbix agent ping') && REGEX.agent.test('Zabbix agent ping') && !REGEX.agent.test('Version of Zabbix agent running'));
  assert.match(PATTERN.cpu, /Huawei: Custom CPU/);
  const dash = JSON.stringify(JSON.parse((await import('node:fs')).readFileSync(new URL('../../dashboards/noc/noc-device-health.json', import.meta.url), 'utf8')).panels);
  assert.ok(dash.includes('Huawei: Custom CPU'), 'the generated dashboard carries the configured CPU names');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(`${tmpdir()}/mi-`);
  const bad = `${d}/bad.json`;
  writeFileSync(bad, JSON.stringify({ availability: { icmp: ['ICMP ping'], snmp: ['x'], agent: ['y'] }, cpu: { match: 'contains', names: ['CPU'] }, memory: { match: 'contains', names: ['Huawei - Memory Raw'] } }));
  const r = (await import('node:child_process')).spawnSync(process.execPath, ['-e', "import('./reports/lib/item-patterns.mjs')"], { env: { ...process.env, MONITORING_ITEMS_FILE: bad }, encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
  assert.match(r.stderr, /raw counters are not utilisation percentages/);
});
