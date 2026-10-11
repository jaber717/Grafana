// One report run: window -> data (through Grafana) -> model -> Grafana panel images -> HTML -> PDF -> delivery.
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Grafana, GrafanaError } from './grafana-client.mjs';
import { previousDayWindow, windowForDate } from './window.mjs';
import { loadInterfaceConfig } from './config.mjs';
import { fetchNetflowRows, fetchInterfaceSeries } from './live.mjs';
import { buildNetflowModel } from './netflow-report.mjs';
import { buildInterfaceModel } from './interface-report.mjs';
import { buildNetflowHtml, NETFLOW_SLOTS, NETFLOW_FILE, mmToPx } from './netflow-html.mjs';
import { buildInterfaceHtml, INTERFACE_SLOT, UTIL_SLOT, INTERFACE_FILE } from './interface-html.mjs';
import { interfacePanelId, liveRevision } from './dashboards.mjs';
import { htmlToPdf as realHtmlToPdf } from './pdf.mjs';
import { deliver, sha256 } from './delivery.mjs';
import { emailBatch, telegramBatch, telegramUnits } from './channels.mjs';
import { emailHtml, emailText, emailSubject, telegramSummary } from './notify.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig } from './demo-data.mjs';

export const DASH_UID = { netflow: 'rpt-netflow-daily', interface: 'rpt-interface-daily' };
const FILENAME = { netflow: NETFLOW_FILE, interface: INTERFACE_FILE };

export function makeLogger(logFile = null, echo = true) {
  return (event) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    if (echo) console.log(line);
    if (logFile) { try { appendFileSync(logFile, line + '\n', { mode: 0o640 }); } catch { /* logging must never break a run */ } }
  };
}

export async function retrying(fn, { attempts = 3, baseMs = 5000, maxMs = 120000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, what = 'step' } = {}) {
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (e) {
      const transient = e.transient !== false && !/layout check failed|PDF has \d+ pages/.test(e.message);
      if (!transient || n >= attempts) throw e;
      const wait = Math.min(maxMs, baseMs * 2 ** (n - 1));
      log({ event: 'retry', what, attempt: n, waitMs: wait, error: e.message.slice(0, 200) });
      await sleep(wait);
    }
  }
}

export async function assertDashboardCurrent(g, uid, expectedRev) {
  let d;
  try { d = await g.json('GET', `/api/dashboards/uid/${uid}`); } catch (e) {
    if (e.status === 404) throw Object.assign(new GrafanaError(`dashboard ${uid} is not installed on Grafana: run "grafana-report build-dashboards --apply"`, { status: 404, transient: false }), {});
    throw e;
  }
  const rev = (d.dashboard.tags || []).find((t) => t.startsWith('rev:'));
  if (rev !== `rev:${expectedRev}`) {
    throw new GrafanaError(`dashboard ${uid} on Grafana is out of date (found ${rev || 'no revision'}, expected rev:${expectedRev}): run "grafana-report build-dashboards --apply"`, { transient: false });
  }
}

// ---- one report ------------------------------------------------------------------------------------------------------------------
export async function generateOne(kind, ctx) {
  const { g, win, prevWin, nowMs, settings, outDir, demo = null, log = () => {}, deps = {} } = ctx;
  const htmlToPdf = deps.htmlToPdf || realHtmlToPdf;
  const rt = { ...settings.retry, sleep: deps.sleep, log };
  const render = (uid, slot, panelId) => retrying(() => g.renderPanel({ uid, panelId, fromMs: win.startMs, toMs: win.endMs - 60000, width: mmToPx(slot.w), height: mmToPx(slot.h), timeoutS: settings.renderTimeoutS }), { ...rt, attempts: 3, baseMs: 5000, what: `render ${kind} panel ${panelId}` });
  let model, html, pages;
  const images = {};
  if (kind === 'netflow') {
    if (!demo) await assertDashboardCurrent(g, DASH_UID.netflow, liveRevision('netflow'));
    const rows = demo ? netflowFixture(win, { scenario: demo.scenario }) : await retrying(() => fetchNetflowRows(g, win), { ...rt, what: 'netflow queries' });
    model = buildNetflowModel({ win, rows, nowMs, demo: !!demo });
    if (model.status !== 'NO_DATA') {
      for (const [name, slot] of Object.entries(NETFLOW_SLOTS)) {
        if ((name === 'site' && !model.available.site) || (name === 'isp' && !model.available.isp) || (name === 'protocols' && !model.available.protocols)) continue;
        images[name] = await render(DASH_UID.netflow, slot, slot.panelId);
      }
    }
    ({ html, pages } = buildNetflowHtml(model, images));
  } else {
    const cfg = demo ? demoInterfaceConfig() : loadInterfaceConfig(readFileSync(settings.interfacesFile, 'utf8'));
    if (!demo) await assertDashboardCurrent(g, DASH_UID.interface, liveRevision('interface', cfg));
    let series, issues = {}, prevSeries = {};
    if (demo) { const fx = interfaceFixture(win, cfg, { scenario: demo.scenario }); series = fx.series; prevSeries = fx.prevSeries; }
    else {
      ({ series, issues } = await retrying(() => fetchInterfaceSeries(g, cfg, win), { ...rt, what: 'interface queries' }));
      try { ({ series: prevSeries } = await fetchInterfaceSeries(g, cfg, prevWin)); } catch (e) { log({ event: 'previous-day-unavailable', error: e.message.slice(0, 160) }); }
    }
    model = buildInterfaceModel({ win, cfg, series, prevSeries, prevWin, issues, nowMs, demo: !!demo });
    if (model.status !== 'NO_DATA') {
      if (cfg.interfaces.some((i) => i.speedBps)) images.__util = await render(DASH_UID.interface, UTIL_SLOT, UTIL_SLOT.panelId);
      for (const [i, it] of cfg.interfaces.entries()) {
        const s = model.interfaces.find((x) => x.key === it.key);
        if (s.status !== 'NO_DATA') images[it.key] = await render(DASH_UID.interface, INTERFACE_SLOT, interfacePanelId(i));
      }
    }
    ({ html, pages } = buildInterfaceHtml(model, images));
  }
  const dayDir = join(outDir, win.date);
  mkdirSync(dayDir, { recursive: true });
  const filename = `${demo ? 'DEMO-' : ''}${FILENAME[kind](win.date)}`;
  const tmp = join(dayDir, `.${filename}.tmp`);
  const info = await retrying(() => htmlToPdf(html, tmp, { chromium: settings.chromiumCmd, expectedPages: pages, keepHtml: demo?.keepHtml ? join(dayDir, `${filename}.html`) : null }), { ...rt, attempts: 2, baseMs: 3000, what: `pdf ${kind}` });
  const path = join(dayDir, filename);
  renameSync(tmp, path);
  const data = readFileSync(path);
  log({ event: 'report-generated', kind, status: model.status, file: filename, pages: info.pages, bytes: info.bytes });
  return { kind, model, file: { filename, path, bytes: data.length, sha256: sha256(data), pages: info.pages } };
}

export function pruneOutput(outDir, keepDays, nowMs, log = () => {}) {
  if (!existsSync(outDir)) return;
  const cutoff = new Date(nowMs - keepDays * 86400e3).toISOString().slice(0, 10);
  for (const d of readdirSync(outDir)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) { rmSync(join(outDir, d), { recursive: true, force: true }); log({ event: 'pruned', dir: d }); }
}

// ---- delivery ----------------------------------------------------------------------------------------------------------------------
const smtpOf = (s) => ({ host: s.email.smtp.host, port: s.email.smtp.port, security: s.email.smtp.security, username: s.email.smtp.username, password: s.email.smtp.password,
  tlsOptions: s.email.smtp.tlsCa ? { ca: readFileSync(s.email.smtp.tlsCa) } : {} });

export async function deliverResults({ settings, results, win, force = false, demo = false, log = () => {}, deps = {}, channelPrefix = '' }) {
  const out = {};
  const models = results.map((r) => r.model);
  const files = results.map((r) => ({ ...r.file, data: readFileSync(r.file.path) }));
  const contentHash = sha256(Buffer.from(files.map((f) => f.sha256).join('')));
  const base = { reportDate: win.date, force, retry: settings.retry, log, sleep: deps.sleep, ledgerDir: join(settings.stateDir, 'ledger') };
  if (settings.email.enabled) {
    const content = {
      from: settings.email.from, subject: emailSubject({ prefix: settings.email.subjectPrefix, date: win.date, models, demo }),
      text: emailText({ date: win.date, models, files, demo }), html: emailHtml({ date: win.date, models, files, demo, grafanaUrl: settings.publicGrafanaUrl }),
      attachments: files.map((f) => ({ filename: f.filename, contentType: 'application/pdf', data: f.data })),
    };
    out.email = await deliver({ ...base, channel: `${channelPrefix}email`, units: settings.email.to, contentHash, sendBatch: emailBatch(smtpOf(settings), content) });
  }
  if (settings.telegram.enabled) {
    const content = { summaryHtml: telegramSummary({ date: win.date, models, demo }), documents: files.map((f, i) => ({ filename: f.filename, data: f.data, caption: `<b>${models[i].kind === 'netflow' ? 'NetFlow' : 'Interface traffic'}</b> - ${win.date}` })) };
    const tg = { apiBase: settings.telegram.apiBase, token: settings.telegram.token, chatId: settings.telegram.chatId };
    out.telegram = await deliver({ ...base, channel: `${channelPrefix}telegram`, units: telegramUnits(content), contentHash, sendBatch: telegramBatch(tg, content) });
  }
  return out;
}

async function notifyFailure({ settings, win, error, log, deps }) {
  if (!settings.notifyOnFailure || !settings.email.enabled) return;
  const subject = `${settings.email.subjectPrefix} - ${win.date} - GENERATION FAILED`;
  const text = `The daily network traffic reports for ${win.date} could not be generated.\n\nReason: ${error.message}\n\nNo report was produced for this day. Check the grafana-report log on the report host.`;
  const content = { from: settings.email.from, subject, text, html: `<p style="font-family:Arial,sans-serif;font-size:14px"><b>The daily network traffic reports for ${win.date} could not be generated.</b></p><p style="font-family:Arial,sans-serif;font-size:13px">Reason: ${String(error.message).replace(/[<>&]/g, '')}</p><p style="font-family:Arial,sans-serif;font-size:13px">No report was produced for this day. Check the grafana-report log on the report host.</p>`, attachments: [] };
  await deliver({ ledgerDir: join(settings.stateDir, 'ledger'), channel: 'email-failure', reportDate: win.date, units: settings.email.to, sendBatch: emailBatch(smtpOf(settings), content), retry: settings.retry, log, sleep: deps.sleep });
}

// ---- the daily run -----------------------------------------------------------------------------------------------------------------
// exit codes: 0 ok, 2 generation failed, 3 delivery failed or partial
export async function runDaily({ settings, now = Date.now(), date = null, kinds = null, force = false, noDeliver = false, demo = null, log = () => {}, deps = {} }) {
  const win = date ? windowForDate(date) : previousDayWindow(now);
  const prevWin = windowForDate(new Date(win.startMs - 86400e3 + 3 * 3600e3).toISOString().slice(0, 10));
  const g = deps.grafana || new Grafana({ url: settings.grafana.url, token: settings.grafana.token });
  const selected = (kinds || settings.kinds);
  log({ event: 'run-start', date: win.date, kinds: selected, demo: !!demo, force });
  const results = [];
  try {
    for (const k of selected) results.push(await generateOne(k, { g, win, prevWin, nowMs: now, settings, outDir: settings.outputDir, demo, log, deps }));
  } catch (e) {
    log({ event: 'generation-failed', error: e.message });
    try { await notifyFailure({ settings, win, error: e, log, deps }); } catch (n) { log({ event: 'failure-notice-failed', error: n.message }); }
    return { exitCode: 2, win, results, error: e.message };
  }
  pruneOutput(settings.outputDir, settings.retentionDays, now, log);
  let delivery = {};
  if (!noDeliver && !(settings.email.enabled || settings.telegram.enabled)) log({ event: 'no-delivery-channel', note: 'EMAIL_ENABLED and TELEGRAM_ENABLED are both off: reports were generated only' });
  if (!noDeliver) delivery = await deliverResults({ settings, results, win, force, demo: !!demo, log, deps });
  const bad = Object.values(delivery).some((d) => d.status === 'failed' || d.status === 'partial');
  const summary = { date: win.date, generatedAt: new Date(now).toISOString(), reports: results.map((r) => ({ kind: r.kind, status: r.model.status, ...r.file, path: undefined })), delivery: Object.fromEntries(Object.entries(delivery).map(([k, v]) => [k, { status: v.status, delivered: v.delivered?.length ?? 0, attempts: v.attempts }])) };
  writeFileSync(join(settings.outputDir, win.date, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log({ event: 'run-end', date: win.date, exitCode: bad ? 3 : 0, delivery: summary.delivery });
  return { exitCode: bad ? 3 : 0, win, results, delivery, summary };
}
