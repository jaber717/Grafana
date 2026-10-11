#!/usr/bin/env node
// grafana-report - daily NetFlow and interface traffic reports rendered by Grafana.
//
//   run               generate both reports for the previous Asia/Riyadh day and deliver them (what the systemd timer runs)
//   generate          generate the PDFs only (manual "Generate Report"); never sends anything (--keep-html also keeps the page HTML for debugging)
//   deliver           deliver already generated PDFs of a day (e-mail / Telegram), duplicate-protected
//   test-delivery     send a clearly marked TEST message with sample PDFs to the configured (or --to) recipients
//   check-config      validate settings, interface list, Chromium, Grafana access and dashboard revisions
//   build-dashboards  generate the two report dashboards from the interface list; --apply installs them in "NOC / Daily Reports"
//   discover          READ-ONLY: propose interface candidates from Zabbix (all include: false) or check an existing mapping (--compare)
//   schedule          show | set HH:MM | enable | disable the daily timer (systemd drop-in; default 07:00 Asia/Riyadh, disabled until enabled)
//   status            show the last run and delivery ledger of a day
//   demo              build DEMO example reports against a DISPOSABLE Grafana with the TestData datasource (never operational data)
//
// Settings: --settings FILE (default $REPORT_SETTINGS or /etc/grafana-platform/reports/report.env). Secrets are read from files only.
// Exit codes: 0 ok | 1 configuration/usage error | 2 report generation failed | 3 delivery failed or partial
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadSettings, validateSettings, parseEnv } from './lib/settings.mjs';
import { runDaily, makeLogger, DASH_UID, slimModel, deliverResults } from './lib/generate.mjs';
import { Grafana } from './lib/grafana-client.mjs';
import { loadInterfaceConfig } from './lib/config.mjs';
import { netflowDashboard, interfaceDashboard, liveRevision, FOLDER } from './lib/dashboards.mjs';
import { previousDayWindow, windowForDate } from './lib/window.mjs';
import { discoverInterfaces, candidatesYaml, compareConfig, zabbixCaller } from './lib/discover.mjs';
import { deliver, sha256 } from './lib/delivery.mjs';
import { emailBatch, telegramBatch, telegramUnits } from './lib/channels.mjs';
import { parseChromiumCmd } from './lib/pdf.mjs';
import { previewPages } from './lib/preview.mjs';
import { demoInterfaceConfig, netflowFixture, interfaceFixture } from './lib/demo-data.mjs';
import { DS_DEMO } from './lib/dashboards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
}
const fail = (msg, code = 1) => { console.error(`ERROR: ${msg}`); process.exit(code); };
const settingsPath = flags.settings || process.env.REPORT_SETTINGS || '/etc/grafana-platform/reports/report.env';
const need = () => {
  if (!existsSync(settingsPath)) fail(`settings file ${settingsPath} not found (use --settings FILE; template: config/reports/report.env.example)`);
  try { return loadSettings(settingsPath); } catch (e) { fail(e.message); }
};
const kinds = flags.kind ? String(flags.kind).split(',') : null;
const date = flags.date && flags.date !== true ? flags.date : null;
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date must be YYYY-MM-DD');

function loggerFor(s) { return makeLogger(s.logFile, true); }

async function main() {
  switch (cmd) {
    case 'run': case 'generate': {
      const { settings, warnings } = need();
      warnings.forEach((w) => console.error(`warning: ${w}`));
      const r = await runDaily({ settings, date, kinds, force: !!flags.force, noDeliver: cmd === 'generate', keepHtml: !!flags['keep-html'], log: loggerFor(settings) });
      if (cmd === 'generate') for (const x of r.results) console.log(`${x.model.status.padEnd(8)} ${x.file.path} (${x.file.pages} pages, ${Math.round(x.file.bytes / 1024)} KB)`);
      return r.exitCode;
    }
    case 'deliver': {
      const { settings } = need();
      const win = date ? windowForDate(date) : previousDayWindow(Date.now());
      const dir = join(settings.outputDir, win.date);
      const results = [];
      for (const k of kinds || settings.kinds) {
        const mp = join(dir, `${k}.model.json`);
        if (!existsSync(mp)) fail(`no generated ${k} report for ${win.date} in ${dir} (run "grafana-report generate --date ${win.date}" first)`);
        const model = JSON.parse(readFileSync(mp, 'utf8'));
        const filename = readdirSync(dir).find((f) => f.endsWith('.pdf') && !f.startsWith('DEMO-') && f.toLowerCase().includes(k === 'netflow' ? 'netflow' : 'interface'));
        if (!filename) fail(`PDF for ${k} missing in ${dir}`);
        const data = readFileSync(join(dir, filename));
        results.push({ kind: k, model, file: { filename, path: join(dir, filename), bytes: data.length, sha256: sha256(data) } });
      }
      const out = await deliverResults({ settings, results, win, force: !!flags.force, log: loggerFor(settings) });
      if (!Object.keys(out).length) { console.error('no delivery channel is enabled (EMAIL_ENABLED / TELEGRAM_ENABLED)'); return 1; }
      return Object.values(out).some((d) => d.status === 'failed' || d.status === 'partial') ? 3 : 0;
    }
    case 'test-delivery': {
      const { settings } = need();
      const log = loggerFor(settings);
      const id = `test-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      const ex = join(ROOT, 'docs', 'reports', 'examples');
      const samples = ['DEMO-Daily-NetFlow-2026-10-11.pdf', 'DEMO-Daily-Interface-Traffic-2026-10-11.pdf'].map((f) => join(ex, f)).filter((p) => existsSync(p)).map((p) => ({ filename: p.split(/[\\/]/).pop().replace('DEMO-', 'TEST-DEMO-'), data: readFileSync(p) }));
      if (!samples.length) fail('sample PDFs not found in docs/reports/examples');
      const wantEmail = flags.email || (!flags.telegram && settings.email.enabled), wantTg = flags.telegram || (!flags.email && settings.telegram.enabled);
      let worst = 0;
      const base = { ledgerDir: join(settings.stateDir, 'ledger'), reportDate: id, retry: settings.retry, log };
      if (wantEmail) {
        if (!settings.email.enabled) fail('EMAIL_ENABLED is not true in the settings');
        const to = flags.to && flags.to !== true ? String(flags.to).split(',').map((x) => x.trim()) : settings.email.to;
        const smtp = { host: settings.email.smtp.host, port: settings.email.smtp.port, security: settings.email.smtp.security, username: settings.email.smtp.username, password: settings.email.smtp.password, tlsOptions: settings.email.smtp.tlsCa ? { ca: readFileSync(settings.email.smtp.tlsCa) } : {} };
        const content = { from: settings.email.from, subject: '[TEST] Grafana report delivery test (DEMO data)', text: 'This is a delivery test sent by grafana-report. The attached PDFs contain synthetic DEMO data only. No action is needed.',
          html: '<p style="font-family:Arial,sans-serif;font-size:14px"><b>[TEST] Grafana report delivery test</b></p><p style="font-family:Arial,sans-serif;font-size:13px">This message was sent by <code>grafana-report test-delivery</code>. The attached PDFs contain synthetic <b>DEMO</b> data only. No action is needed.</p>',
          attachments: samples.map((s) => ({ filename: s.filename, contentType: 'application/pdf', data: s.data })) };
        const r = await deliver({ ...base, channel: 'test-email', units: to, sendBatch: emailBatch(smtp, content) });
        console.log(`email test: ${r.status} (${r.delivered.length}/${to.length} recipients)`);
        if (r.status !== 'sent') worst = 3;
      }
      if (wantTg) {
        if (!settings.telegram.enabled) fail('TELEGRAM_ENABLED is not true in the settings');
        const content = { summaryHtml: '<b>[TEST] Grafana report delivery test</b>\nSample PDFs with synthetic DEMO data are attached. No action is needed.', documents: samples.map((s) => ({ filename: s.filename, data: s.data, caption: 'DEMO test document' })) };
        const r = await deliver({ ...base, channel: 'test-telegram', units: telegramUnits(content), sendBatch: telegramBatch({ apiBase: settings.telegram.apiBase, token: settings.telegram.token, chatId: settings.telegram.chatId }, content) });
        console.log(`telegram test: ${r.status}`);
        if (r.status !== 'sent') worst = 3;
      }
      if (!wantEmail && !wantTg) fail('no channel is enabled; enable EMAIL_ENABLED and/or TELEGRAM_ENABLED');
      return worst;
    }
    case 'check-config': {
      const text = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : fail(`settings file ${settingsPath} not found`);
      const { settings, problems, warnings } = validateSettings(parseEnv(text));
      let bad = 0;
      const line = (ok, msg) => { console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${msg}`); if (!ok) bad++; };
      problems.forEach((p) => line(false, p));
      warnings.forEach((w) => console.log(`[warn] ${w}`));
      if (!problems.length) line(true, `settings valid (${settingsPath})`);
      let cfg = null;
      try { cfg = loadInterfaceConfig(readFileSync(settings.interfacesFile, 'utf8')); line(true, `interfaces: ${cfg.interfaces.length} included, ${cfg.excluded.length} excluded, boundaries: ${cfg.boundaries.join(', ') || 'none'}`); } catch (e) { line(false, `interfaces file: ${e.message}`); }
      try {
        const wd = mkdtempSync(join(tmpdir(), 'rpt-chk-'));        // a private subdirectory, exactly like a real run (a container cannot relabel /tmp itself)
        const argvC = parseChromiumCmd(settings.chromiumCmd, wd);
        const r = spawnSync(argvC[0], [...argvC.slice(1), '--version'], { encoding: 'utf8', timeout: 120000 });
        rmSync(wd, { recursive: true, force: true });
        line(r.status === 0, `Chromium: ${(r.stdout || r.stderr || '').trim().split('\n')[0] || 'no output'}`);
      } catch (e) { line(false, `Chromium: ${e.message}`); }
      if (settings.grafana.token) {
        const g = new Grafana({ url: settings.grafana.url, token: settings.grafana.token });
        try { const h = await g.health(); line(true, `Grafana reachable, version ${h.version}`); } catch (e) { line(false, `Grafana: ${e.message}`); }
        for (const [kind, uid] of Object.entries(DASH_UID)) {
          try {
            if (kind === 'interface' && !cfg) continue;
            const d = await g.json('GET', `/api/dashboards/uid/${uid}`);
            const want = liveRevision(kind, cfg);
            line((d.dashboard.tags || []).includes(`rev:${want}`), `dashboard ${uid}: ${(d.dashboard.tags || []).includes(`rev:${want}`) ? 'current' : 'OUT OF DATE (run build-dashboards --apply)'}`);
          } catch (e) { line(false, `dashboard ${uid}: ${e.message}`); }
        }
      }
      console.log(bad ? `\n${bad} check(s) failed` : '\nall checks passed');
      return bad ? 1 : 0;
    }
    case 'build-dashboards': {
      const ifFile = flags.interfaces && flags.interfaces !== true ? flags.interfaces : need().settings.interfacesFile;
      const cfg = loadInterfaceConfig(readFileSync(ifFile, 'utf8'));
      const dashes = [netflowDashboard('live'), interfaceDashboard(cfg, 'live')];
      if (!flags.apply) {
        const out = flags.out && flags.out !== true ? flags.out : 'dashboards-out';
        mkdirSync(out, { recursive: true });
        for (const d of dashes) { writeFileSync(join(out, `${d.uid}.json`), JSON.stringify(d, null, 1) + '\n'); console.log(`wrote ${join(out, d.uid + '.json')} (rev ${d.tags.find((t) => t.startsWith('rev:'))})`); }
        return 0;
      }
      const tf = flags['token-file'];
      if (!tf || tf === true) fail('--apply needs --token-file (a Grafana token with Editor rights on the "NOC / Daily Reports" folder; the daily job itself only needs a read-only token)');
      const url = flags['grafana-url'] && flags['grafana-url'] !== true ? flags['grafana-url'] : need().settings.grafana.url;
      const g = new Grafana({ url, tokenFile: tf });
      try { await g.json('GET', `/api/folders/${FOLDER.uid}`); } catch (e) { if (e.status !== 404) throw e; await g.json('POST', '/api/folders', FOLDER); console.log(`created folder "${FOLDER.title}"`); }
      for (const d of dashes) {
        let same = false;
        try { const cur = await g.json('GET', `/api/dashboards/uid/${d.uid}`); same = (cur.dashboard.tags || []).includes(d.tags.find((t) => t.startsWith('rev:'))) && cur.meta.folderUid === FOLDER.uid; } catch (e) { if (e.status !== 404) throw e; }
        if (same) { console.log(`unchanged ${d.uid}`); continue; }
        await g.json('POST', '/api/dashboards/db', { dashboard: { ...d, id: null }, folderUid: FOLDER.uid, overwrite: true, message: 'grafana-report build-dashboards' });
        console.log(`applied ${d.uid}`);
      }
      return 0;
    }
    case 'discover': {
      const url = process.env.ZABBIX_URL || fail('set ZABBIX_URL (…/api_jsonrpc.php)');
      const tf = process.env.ZABBIX_TOKEN_FILE || fail('set ZABBIX_TOKEN_FILE (a READ-ONLY Zabbix API token)');
      const cands = await discoverInterfaces(zabbixCaller({ url, token: readFileSync(tf, 'utf8').trim() }));
      if (flags.compare) {
        const r = compareConfig(readFileSync(flags.compare, 'utf8'), cands);
        r.ok.forEach((k) => console.log(`[ OK ] ${k}`));
        r.problems.forEach((p) => console.log(`[FAIL] ${p}`));
        if (r.notConfigured.length) console.log(`\n${r.notConfigured.length} interface(s) exist in Zabbix but are not in the configuration (not reported): ${r.notConfigured.slice(0, 20).join(', ')}${r.notConfigured.length > 20 ? ', …' : ''}`);
        return r.problems.length ? 1 : 0;
      }
      const text = candidatesYaml(cands);
      if (flags.out && flags.out !== true) { writeFileSync(flags.out, text); console.log(`wrote ${cands.length} candidate(s) to ${flags.out} - none is included; edit and copy the ones you want into interfaces.yaml`); } else process.stdout.write(text);
      return 0;
    }
    case 'status': {
      const { settings } = need();
      const win = date ? windowForDate(date) : previousDayWindow(Date.now());
      const sp = join(settings.outputDir, win.date, 'summary.json');
      console.log(existsSync(sp) ? readFileSync(sp, 'utf8') : `no run summary for ${win.date}`);
      const ld = join(settings.stateDir, 'ledger');
      if (existsSync(ld)) for (const f of readdirSync(ld).filter((x) => x.startsWith(win.date) && x.endsWith('.json'))) { const l = JSON.parse(readFileSync(join(ld, f), 'utf8')); console.log(`${f}: ${l.status || 'in progress'}, delivered ${l.delivered.length}, attempts ${l.history.length}`); }
      return 0;
    }
    case 'schedule': {
      // grafana-report schedule show | set HH:MM | enable | disable   (needs root; writes a systemd drop-in, never edits the shipped unit)
      const sub = argv.find((a) => !a.startsWith('--')) || 'show';
      const sc = (...a) => spawnSync('systemctl', a, { encoding: 'utf8' });
      if (sub === 'show') {
        const r = sc('list-timers', 'grafana-report.timer', '--no-pager');
        console.log(r.stdout || r.stderr);
        console.log((sc('cat', 'grafana-report.timer').stdout || '').split('\n').filter((l) => /OnCalendar|^#/.test(l) || l.includes('schedule.conf')).join('\n'));
        return 0;
      }
      if (sub === 'set') {
        const t = argv[argv.indexOf('set') + 1];
        const m = String(t || '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!m) fail('usage: grafana-report schedule set HH:MM   (24 h, Asia/Riyadh)');
        const spec = `*-*-* ${m[1].padStart(2, '0')}:${m[2]}:00 Asia/Riyadh`;
        const v = spawnSync('systemd-analyze', ['calendar', spec], { encoding: 'utf8' });
        if (v.status !== 0) fail(`systemd rejects the schedule "${spec}": ${v.stderr}`);
        const dir = '/etc/systemd/system/grafana-report.timer.d';
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'schedule.conf'), `[Timer]\nOnCalendar=\nOnCalendar=${spec}\n`);
        sc('daemon-reload');
        if (sc('is-enabled', 'grafana-report.timer').stdout.trim() === 'enabled') sc('restart', 'grafana-report.timer');
        console.log(`schedule set to ${spec}\n${v.stdout.split('\n').filter((l) => /Next elapse|UTC/.test(l)).join('\n')}`);
        return 0;
      }
      if (sub === 'enable' || sub === 'disable') { const r = sc(sub === 'enable' ? 'enable' : 'disable', '--now', 'grafana-report.timer'); console.log(r.stderr || `timer ${sub}d`); return r.status; }
      fail('usage: grafana-report schedule show | set HH:MM | enable | disable');
      return 1;
    }
    case 'demo': return demo();
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      return cmd ? 1 : 0;
  }
}

// DEMO: provisions the DEMO dashboards (TestData datasource) into a DISPOSABLE Grafana and renders example reports from synthetic data.
async function demo() {
  const url = (flags['grafana-url'] && flags['grafana-url'] !== true ? flags['grafana-url'] : 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/.test(url) && !flags['allow-remote-demo']) fail('demo only talks to a loopback Grafana (it creates a TestData datasource and overwrites dashboards); pass --allow-remote-demo for a disposable remote one');
  const user = process.env.GRAFANA_USER, pw = process.env.GRAFANA_PASSWORD;
  if (!user) fail('set GRAFANA_USER and GRAFANA_PASSWORD (environment) for the disposable Grafana');
  const out = flags.out && flags.out !== true ? flags.out : join(ROOT, 'docs', 'reports', 'examples');
  const chromium = flags.chromium && flags.chromium !== true ? flags.chromium : process.env.CHROMIUM_BIN || fail('set --chromium or CHROMIUM_BIN');
  const g = new Grafana({ url, user, password: pw });
  try { await g.json('POST', '/api/datasources', { name: 'Report DEMO (TestData)', type: DS_DEMO.type, uid: DS_DEMO.uid, access: 'proxy' }); } catch (e) { if (!/409|already/.test(e.message)) throw e; }
  try { await g.json('GET', `/api/folders/${FOLDER.uid}`); } catch (e) { if (e.status !== 404) throw e; await g.json('POST', '/api/folders', FOLDER); }
  const date_ = date || '2026-10-11';
  const win = windowForDate(date_);
  const now = Date.UTC(+date_.slice(0, 4), +date_.slice(5, 7) - 1, +date_.slice(8, 10) + 1, 4, 0);
  const scenarios = (flags.scenario && flags.scenario !== true ? String(flags.scenario) : 'normal').split(',');
  mkdirSync(out, { recursive: true });
  let code = 0;
  for (const scenario of scenarios) {
    const cfg = demoInterfaceConfig();
    const nf = netflowFixture(win, { scenario });
    const ifx = interfaceFixture(win, cfg, { scenario });
    for (const d of [netflowDashboard({ demo: nf }), interfaceDashboard(cfg, { demo: ifx })]) await g.json('POST', '/api/dashboards/db', { dashboard: d, folderUid: FOLDER.uid, overwrite: true });
    const settings = { grafana: { url }, interfacesFile: null, outputDir: join(tmpdir(), `grafana-report-demo-${process.pid}`, scenario), stateDir: join(out, '.state'), chromiumCmd: chromium, kinds: ['netflow', 'interface'], retry: { attempts: 2, baseMs: 2000, maxMs: 5000 }, renderTimeoutS: 60, notifyOnFailure: false, retentionDays: 3650, email: { enabled: false }, telegram: { enabled: false } };
    const r = await runDaily({ settings, now, date: date_, noDeliver: true, demo: { scenario, keepHtml: !!flags.previews }, deps: { grafana: g }, log: loggerFor(settings) });
    if (r.exitCode) { code = r.exitCode; continue; }
    const dest = scenario === 'normal' ? out : join(out, scenario);
    mkdirSync(dest, { recursive: true });
    for (const x of r.results) {
      copyFileSync(x.file.path, join(dest, x.file.filename));
      console.log(`${scenario}: ${join(dest, x.file.filename)} (${x.model.status}, ${x.file.pages} pages)`);
      if (flags.previews) await previewPages(readFileSync(`${x.file.path}.html`, 'utf8'), join(out, 'previews', scenario), { chromium, pages: x.file.pages, prefix: x.file.filename.replace(/\.pdf$/, '') });
    }
  }
  return code;
}

main().then((c) => process.exit(c || 0), (e) => { console.error(`ERROR: ${e.message}`); process.exit(e.exitCode || 2); });
