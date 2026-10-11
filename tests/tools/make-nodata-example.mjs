// Builds the NO DATA example reports with the REAL (non-demo) code path: an empty mock Grafana answers every query with no rows, exactly
// what a day without traffic looks like. The interface list is the shipped example configuration (SITE-A and SITE-B). No synthetic data is
// involved, so these files carry no DEMO label.
//   CHROMIUM_BIN=/path/to/chromium node tests/tools/make-nodata-example.mjs [outdir] [YYYY-MM-DD]
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { startGrafanaMock } from '../mocks/grafana-mock.mjs';
import { runDaily } from '../../reports/lib/generate.mjs';
import { liveRevision } from '../../reports/lib/dashboards.mjs';
import { loadInterfaceConfig } from '../../reports/lib/config.mjs';
import { previewPages } from '../../reports/lib/preview.mjs';
import { findLocalChromium } from '../../reports/lib/pdf.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const out = resolve(process.argv[2] || join(ROOT, 'docs', 'reports', 'examples', 'no-data'));
const date = process.argv[3] || '2026-10-11';
const chromium = findLocalChromium() || (console.error('set CHROMIUM_BIN'), process.exit(1));
const ifFile = join(ROOT, 'config', 'reports', 'interfaces.example.yaml');
const cfg = loadInterfaceConfig(readFileSync(ifFile, 'utf8'));
const g = await startGrafanaMock({ cfg, netflowRows: {}, ifaceSeries: {}, dashboards: { 'rpt-netflow-daily': { tags: [`rev:${liveRevision('netflow')}`] }, 'rpt-interface-daily': { tags: [`rev:${liveRevision('interface', cfg)}`] } } });
const work = join(tmpdir(), `nodata-example-${process.pid}`);
const settings = { grafana: { url: g.url, token: g.token }, interfacesFile: ifFile, outputDir: work, stateDir: join(work, 'state'), chromiumCmd: chromium, kinds: ['netflow', 'interface'], retry: { attempts: 1, baseMs: 1, maxMs: 1 }, renderTimeoutS: 30, notifyOnFailure: false, retentionDays: 3650, email: { enabled: false }, telegram: { enabled: false } };
const [y, m, d] = date.split('-').map(Number);
const r = await runDaily({ settings, now: Date.UTC(y, m - 1, d + 1, 4, 0), noDeliver: true, keepHtml: true, deps: { sleep: async () => {} }, log: () => {} });
await g.close();
if (r.exitCode) { console.error('failed:', r.error); process.exit(r.exitCode); }
mkdirSync(join(out, 'previews'), { recursive: true });
for (const x of r.results) {
  copyFileSync(x.file.path, join(out, x.file.filename));
  console.log(`${x.model.status}  ${join(out, x.file.filename)} (${x.file.pages} pages)`);
  await previewPages(readFileSync(`${x.file.path}.html`, 'utf8'), join(out, 'previews'), { chromium, pages: x.file.pages, prefix: x.file.filename.replace(/\.pdf$/, '') });
}
console.log('queries sent to Grafana:', g.stats.dsQueries, ' panels rendered:', g.stats.renders);
