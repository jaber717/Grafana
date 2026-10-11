import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowForDate } from '../../reports/lib/window.mjs';
import { netflowFixture, interfaceFixture, demoInterfaceConfig } from '../../reports/lib/demo-data.mjs';
import { buildNetflowModel } from '../../reports/lib/netflow-report.mjs';
import { buildInterfaceModel } from '../../reports/lib/interface-report.mjs';
import { emailHtml, emailText, emailSubject, telegramSummary, headline } from '../../reports/lib/notify.mjs';

const win = windowForDate('2026-10-11');
const now = Date.UTC(2026, 9, 12, 4);
const models = (scenario, demo = true) => {
  const cfg = demoInterfaceConfig();
  const fx = interfaceFixture(win, cfg, { scenario });
  return [buildNetflowModel({ win, rows: netflowFixture(win, { scenario }), nowMs: now, demo }), buildInterfaceModel({ win, cfg, series: fx.series, prevSeries: fx.prevSeries, prevWin: windowForDate('2026-10-10'), nowMs: now, demo })];
};
const files = [{ filename: 'Daily-NetFlow-2026-10-11.pdf', bytes: 321795 }, { filename: 'Daily-Interface-Traffic-2026-10-11.pdf', bytes: 259387 }];

test('subject carries the date and both statuses', () => {
  assert.equal(emailSubject({ prefix: 'Daily Network Traffic Reports', date: '2026-10-11', models: models('normal'), demo: false }), 'Daily Network Traffic Reports - 2026-10-11 - NetFlow COMPLETE / Interfaces COMPLETE');
  assert.match(emailSubject({ prefix: 'P', date: '2026-10-11', models: models('partial'), demo: false }), /NetFlow PARTIAL \/ Interfaces PARTIAL/);
  assert.match(emailSubject({ prefix: 'P', date: '2026-10-11', models: models('nodata'), demo: false }), /NetFlow NO DATA \/ Interfaces NO DATA/);
  assert.match(emailSubject({ prefix: 'P', date: '2026-10-11', models: models('normal'), demo: true }), /^\[DEMO\] /);
});

test('complete day: headline figures appear once, the email is HTML+text, attachments are listed', () => {
  const m = models('normal');
  const html = emailHtml({ date: '2026-10-11', models: m, files, demo: false });
  const text = emailText({ date: '2026-10-11', models: m, files, demo: false });
  assert.match(html, /Daily NetFlow Traffic Report/);
  assert.match(html, /Highest peak utilisation/);
  assert.match(html, /Daily-NetFlow-2026-10-11.pdf \(314 KB\)/);
  assert.equal((text.match(/Inbound \(est\.\)/g) || []).length, 1, 'volumes are not repeated in the observations');
  assert.ok(headline(m[0]).length >= 4);
  assert.ok(!/DEMO - synthetic data/.test(html), 'no DEMO banner when the data is not demo');
});

test('partial day: the understatement is stated and no previous-day percentage is shown', () => {
  const [nf] = models('partial');
  const text = emailText({ date: '2026-10-11', models: models('partial'), files, demo: false });
  assert.match(text, /understate/);
  assert.match(text, /not shown \(incomplete day\)/);
  assert.equal(nf.kpis.change.total, null);
});

test('NO DATA: a plain statement, no figures at all (email and Telegram)', () => {
  const m = models('nodata');
  const html = emailHtml({ date: '2026-10-11', models: m, files, demo: false });
  const tg = telegramSummary({ date: '2026-10-11', models: m, demo: false });
  assert.match(html, /NO DATA/);
  assert.match(html, /No NetFlow records were received/);
  assert.match(tg, /NO DATA/);
  assert.ok(!/Inbound|Outbound|Mb\/s|%/.test(tg), 'no figures in the Telegram summary of a NO DATA day');
  assert.ok(!/Highest peak utilisation|Interfaces over 80/.test(html));
});

test('demo content is labelled; operator-controlled text is escaped', () => {
  const m = models('normal');
  m[0].observations.push('<img src=x onerror=alert(1)>');
  const html = emailHtml({ date: '2026-10-11', models: m, files, demo: true });
  assert.match(html, /DEMO - synthetic data, not measured/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(telegramSummary({ date: '2026-10-11', models: m, demo: true }), /DEMO - synthetic/);
});

test('telegram summary stays within the Bot API limit and uses only supported tags', () => {
  const m = models('normal');
  for (let i = 0; i < 80; i++) m[0].observations.push('x'.repeat(120));
  const tg = telegramSummary({ date: '2026-10-11', models: m, demo: false });
  assert.ok(tg.length <= 4000);
  assert.ok(!/<(?!\/?(b|i|code)>)/.test(tg.replace(/&lt;|&gt;/g, '')), 'only <b>, <i>, <code>');
});
