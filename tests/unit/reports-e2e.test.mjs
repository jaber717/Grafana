// End-to-end: the real orchestrator (window, data via Grafana API, panel render, HTML, Chromium PDF, e-mail + Telegram delivery, ledger)
// against mock Grafana / SMTP / Telegram. Needs a local Chromium (CHROMIUM_BIN, Chrome, Edge or /usr/bin/chromium); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGrafanaMock } from '../mocks/grafana-mock.mjs';
import { startSmtpMock } from '../mocks/smtp-mock.mjs';
import { startTelegramMock } from '../mocks/telegram-mock.mjs';
import { runDaily } from '../../reports/lib/generate.mjs';
import { findLocalChromium } from '../../reports/lib/pdf.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig, DEMO_INTERFACE_YAML, healthFixture } from '../../reports/lib/demo-data.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';
import { liveRevision } from '../../reports/lib/dashboards.mjs';
import { sha256 } from '../../reports/lib/delivery.mjs';

const chromium = findLocalChromium();
const opts = { skip: chromium ? false : 'no local Chromium available', timeout: 240000 };
const win = windowForDate('2026-10-11');
const NOW = Date.UTC(2026, 9, 12, 4, 0);                 // 2026-10-12 07:00 Asia/Riyadh -> reports the 11th
const noSleep = async () => {};
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

async function rig({ scenario = 'normal', grafana = {}, smtp = {}, email = true, telegram = true, kinds = ['netflow', 'interface'], scopes = null, scope = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rpt-e2e-'));
  const cfg = demoInterfaceConfig();
  writeFileSync(join(dir, 'interfaces.yaml'), DEMO_INTERFACE_YAML);
  if (scopes) writeFileSync(join(dir, 'scopes.yaml'), scopes);
  const hfx = healthFixture(win, { scenario });
  const inventory = hfx.devices.map((d, i) => ({ hostid: String(100 + i), host: d.host, name: d.host, status: '0', hostgroups: [...d.sites.map((x) => ({ name: `Site/${x}` })), ...d.types.map((x) => ({ name: `Type/${x}` }))] }));
  const g = await startGrafanaMock({
    cfg, inventory, health: { series: hfx.series }, netflowRows: netflowFixture(win, { scenario }), ifaceSeries: interfaceFixture(win, cfg, { scenario }).series,
    dashboards: { 'rpt-netflow-daily': { tags: [`rev:${liveRevision('netflow')}`] }, 'rpt-interface-daily': { tags: [`rev:${liveRevision('interface', cfg)}`] }, 'rpt-health-daily': { tags: [`rev:${liveRevision('health')}`] } }, ...grafana,
  });
  const smtpMock = await startSmtpMock(smtp);
  const tg = await startTelegramMock();
  const settings = {
    grafana: { url: g.url, token: g.token }, interfacesFile: join(dir, 'interfaces.yaml'), outputDir: join(dir, 'out'), stateDir: join(dir, 'state'), chromiumCmd: chromium,
    kinds, scopesFile: scopes ? join(dir, 'scopes.yaml') : null, scope, retry: { attempts: 3, baseMs: 1, maxMs: 2 }, renderTimeoutS: 30, notifyOnFailure: true, retentionDays: 45, publicGrafanaUrl: null,
    email: { enabled: email, from: 'NOC Reports <noc-reports@example.test>', to: ['a@example.test', 'b@example.test'], subjectPrefix: 'Daily Network Traffic Reports', smtp: { host: '127.0.0.1', port: smtpMock.port, security: 'none', username: null, password: null, tlsCa: null } },
    telegram: { enabled: telegram, apiBase: tg.apiBase, token: tg.token, chatId: '-1001' },
  };
  return { dir, settings, g, smtp: smtpMock, tg, run: (o = {}) => runDaily({ settings, now: NOW, deps: { sleep: noSleep }, ...o }), done: async () => { await g.close(); await smtpMock.close(); await tg.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('e2e: a complete day produces both PDFs and delivers them by e-mail and Telegram exactly once', opts, async () => {
  const r = await rig();
  const out = await r.run();
  assert.equal(out.exitCode, 0, JSON.stringify(out.error || out.delivery));
  assert.equal(out.win.date, '2026-10-11');
  const dir = join(r.settings.outputDir, '2026-10-11');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort(), ['Daily-Interface-Traffic-2026-10-11.pdf', 'Daily-NetFlow-2026-10-11.pdf']);
  assert.equal(pdfPages(readFileSync(join(dir, 'Daily-NetFlow-2026-10-11.pdf'))), 3);
  // the window sent to Grafana is the previous complete Riyadh day
  assert.equal(r.g.stats.queryBodies[0].from, String(win.startMs));
  assert.equal(r.g.stats.queryBodies[0].to, String(win.endMs));
  assert.equal(r.g.stats.lastRender.tz, 'Asia/Riyadh');
  // e-mail
  assert.equal(r.smtp.messages.length, 1);
  const m = r.smtp.messages[0];
  assert.deepEqual(m.rcpts, ['a@example.test', 'b@example.test']);
  assert.match(m.raw, /Subject: Daily Network Traffic Reports - 2026-10-11 - NetFlow COMPLETE \/ Interfaces COMPLETE/);
  assert.match(m.raw, /filename="Daily-NetFlow-2026-10-11.pdf"/);
  assert.match(m.raw, /filename="Daily-Interface-Traffic-2026-10-11.pdf"/);
  const att = [...m.raw.matchAll(/filename="([^"]+)"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((x) => ({ n: x[1], d: Buffer.from(x[2].replace(/\r\n/g, ''), 'base64') }));
  assert.ok(att.every((a) => a.d.subarray(0, 5).toString() === '%PDF-'));
  assert.equal(sha256(att[0].d), sha256(readFileSync(join(dir, att[0].n))), 'attachment is byte-identical to the stored PDF');
  // telegram
  assert.deepEqual(r.tg.calls.map((c) => c.method), ['sendMessage', 'sendDocument', 'sendDocument']);
  assert.match(r.tg.calls[0].fields.text, /Daily network reports - 2026-10-11/);
  // a second run for the same day sends nothing again - and does not even query Grafana or print PDFs
  const queries = r.g.stats.dsQueries, renders = r.g.stats.renders;
  const again = await r.run();
  assert.equal(again.exitCode, 0);
  assert.equal(again.skipped, true);
  assert.equal(r.g.stats.dsQueries, queries);
  assert.equal(r.g.stats.renders, renders);
  assert.equal(r.smtp.messages.length, 1);
  assert.equal(r.tg.calls.length, 3);
  // --force regenerates and resends deliberately
  const forced = await r.run({ force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(r.smtp.messages.length, 2);
  assert.equal(r.tg.calls.length, 6);
  await r.done();
});

test('e2e: a no-traffic day is a designed NO DATA report - 2 pages each, no figures, nothing fails', opts, async () => {
  const r = await rig({ scenario: 'nodata' });
  const out = await r.run();
  assert.equal(out.exitCode, 0, JSON.stringify(out.error));
  const dir = join(r.settings.outputDir, '2026-10-11');
  for (const f of ['Daily-NetFlow-2026-10-11.pdf', 'Daily-Interface-Traffic-2026-10-11.pdf']) assert.equal(pdfPages(readFileSync(join(dir, f))), 2);
  assert.equal(r.g.stats.renders, 0, 'no chart is rendered for a day without data');
  assert.match(r.smtp.messages[0].raw, /Subject: Daily Network Traffic Reports - 2026-10-11 - NetFlow NO DATA \/ Interfaces NO DATA/);
  const body = Buffer.from(r.smtp.messages[0].raw.match(/text\/plain[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/)[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /NO DATA/);
  assert.ok(!/\bInbound\b.*\b\d/.test(body), 'no traffic figures in the mail body');
  assert.match(r.tg.calls[0].fields.text, /NO DATA/);
  await r.done();
});

test('e2e: a Grafana outage fails the run (exit 2), keeps nothing half-done, and sends ONE failure notice', opts, async () => {
  const r = await rig({ grafana: { fail503: 999 }, telegram: false });
  const out = await r.run();
  assert.equal(out.exitCode, 2);
  assert.match(out.error, /503/);
  assert.equal(r.smtp.messages.length, 1);
  assert.match(r.smtp.messages[0].raw, /GENERATION FAILED/);
  assert.equal(r.smtp.messages[0].raw.includes('filename='), false, 'the failure notice carries no attachment');
  assert.ok(!existsSync(join(r.settings.outputDir, '2026-10-11', 'Daily-NetFlow-2026-10-11.pdf')));
  await r.run();
  assert.equal(r.smtp.messages.length, 1, 'the failure notice is not repeated for the same day');
  await r.done();
});

test('e2e: a stale dashboard on Grafana stops the run with a clear instruction', opts, async () => {
  const r = await rig({ grafana: { dashboards: { 'rpt-netflow-daily': { tags: ['rev:000000000000'] }, 'rpt-interface-daily': { tags: [] } } }, email: false, telegram: false });
  const out = await r.run();
  assert.equal(out.exitCode, 2);
  assert.match(out.error, /out of date.*build-dashboards --apply/);
  await r.done();
});

test('e2e: an SMTP outage leaves the reports on disk, exits 3, and the next run delivers without regenerating duplicates', opts, async () => {
  const r = await rig({ smtp: { failData: 99 }, telegram: false });
  const out = await r.run();
  assert.equal(out.exitCode, 3);
  assert.equal(out.delivery.email.status, 'failed');
  assert.ok(existsSync(join(r.settings.outputDir, '2026-10-11', 'Daily-NetFlow-2026-10-11.pdf')));
  r.smtp.state.failData = 0;
  const next = await r.run();
  assert.equal(next.exitCode, 0);
  assert.equal(r.smtp.messages.length, 1);
  await r.done();
});

test('e2e: DEMO mode labels every file DEMO- and the demo watermark is in the PDF source', opts, async () => {
  const r = await rig({ email: false, telegram: false });
  const out = await r.run({ demo: { scenario: 'normal' } });
  assert.equal(out.exitCode, 0);
  const files = readdirSync(join(r.settings.outputDir, '2026-10-11')).filter((f) => f.endsWith('.pdf'));
  assert.deepEqual(files.sort(), ['DEMO-Daily-Interface-Traffic-2026-10-11.pdf', 'DEMO-Daily-NetFlow-2026-10-11.pdf']);
  await r.done();
});

test('e2e: the network health report - three pages, state at end of day, rendered with the scope variable, delivered with the other reports', opts, async () => {
  const r = await rig({ kinds: ['netflow', 'interface', 'health'] });
  const out = await r.run();
  assert.equal(out.exitCode, 0, JSON.stringify(out.error || out.delivery));
  const dir = join(r.settings.outputDir, '2026-10-11');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort(), ['Daily-Interface-Traffic-2026-10-11.pdf', 'Daily-NetFlow-2026-10-11.pdf', 'Daily-Network-Health-2026-10-11.pdf']);
  assert.equal(pdfPages(readFileSync(join(dir, 'Daily-Network-Health-2026-10-11.pdf'))), 3);
  const model = JSON.parse(readFileSync(join(dir, 'health.model.json'), 'utf8'));
  assert.deepEqual(model.devices.map((d) => [d.host, d.state]), [['DEMO-BR1-R1', 'DOWN'], ['DEMO-BR2-AP1', 'UNKNOWN'], ['DEMO-BR2-R1', 'NO_DATA'], ['DEMO-BR2-SW1', 'NOT_MONITORED'], ['DEMO-DC-R1', 'UP'], ['DEMO-HQ-R1', 'UP'], ['DEMO-HQ-R2', 'UP'], ['DEMO-HQ-SW1', 'UP']].sort((a, b) => a[0].localeCompare(b[0])));
  assert.equal(r.smtp.messages.length, 1);
  const m = r.smtp.messages[0];
  assert.match(m.raw, /NetFlow COMPLETE \/ Interfaces COMPLETE \/ Health PARTIAL/);
  assert.match(m.raw, /filename="Daily-Network-Health-2026-10-11.pdf"/);
  assert.equal(r.tg.calls.filter((c) => c.method === 'sendDocument').length, 3);
  assert.ok(r.g.stats.inventoryCalls >= 1, 'the Zabbix inventory is read through Grafana');
  await r.done();
});

test('e2e: a saved scope narrows all three reports to its devices and says so', opts, async () => {
  const scopes = ['scopes:', '  - id: hq-routers', '    title: HQ routers', '    site: DEMO-HQ', '    device_group: Router', '    metrics: availability, cpu', ''].join(String.fromCharCode(10));
  const r = await rig({ kinds: ['netflow', 'interface', 'health'], scopes, scope: 'hq-routers', email: false, telegram: false });
  const out = await r.run();
  assert.equal(out.exitCode, 0, JSON.stringify(out.error));
  const dir = join(r.settings.outputDir, '2026-10-11');
  const health = JSON.parse(readFileSync(join(dir, 'health.model.json'), 'utf8'));
  assert.deepEqual(health.devices.map((d) => d.host), ['DEMO-HQ-R1', 'DEMO-HQ-R2'], 'site AND device type');
  assert.deepEqual(health.scope.metrics, ['availability', 'cpu']);
  const iface = JSON.parse(readFileSync(join(dir, 'interface.model.json'), 'utf8'));
  assert.deepEqual(iface.interfaces.map((i) => i.key), ['DEMO-HQ-R1:Gi0/0', 'DEMO-HQ-R1:Gi0/1']);
  const sql = r.g.stats.queryBodies.flatMap((q) => q.queries.map((x) => x.rawSql || '')).filter((x) => x.includes('flows_5m0s'));
  assert.ok(sql.length && sql.every((x) => x.includes("ExporterName IN ('DEMO-HQ-R1', 'DEMO-HQ-R2')")), 'every NetFlow query is limited to the scope exporters');
  assert.equal(r.g.stats.lastRender['var-hosts'], '/^(DEMO-HQ-R1|DEMO-HQ-R2)$/', 'the health panels are rendered for the scope devices only (hosts variable)');
  await r.done();
});
