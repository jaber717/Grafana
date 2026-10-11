// Maintainer tool: capture a running Grafana into this repository layout (READ-ONLY against Grafana).
//   GRAFANA_URL=... GRAFANA_USER=... GRAFANA_PASSWORD=... node tools/export-live.mjs [--dry-run]
// Writes dashboards/<folder-uid>/<dashboard-uid>.json, config/folders.json, config/datasources.json (no secrets: Grafana never returns them),
// config/playlists.json. Dashboards are stored as deployed except for the instance-specific `id` (set to null) and `version` (removed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, ROOT, parseArgs } from '../scripts/lib/grafana.mjs';

const args = parseArgs(process.argv.slice(2));
const write = (rel, obj) => {
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (args['dry-run']) { console.log(`would write ${rel} (${text.length} bytes)`); return; }
  mkdirSync(join(ROOT, rel, '..'), { recursive: true });
  writeFileSync(join(ROOT, rel), text);
  console.log(`wrote ${rel}`);
};

const folders = (await get('/api/folders')).map((f) => ({ uid: f.uid, title: f.title })).sort((a, b) => a.uid.localeCompare(b.uid));
write('config/folders.json', folders);

const hits = await get('/api/search?type=dash-db&limit=5000');
for (const h of hits.sort((a, b) => a.uid.localeCompare(b.uid))) {
  const { dashboard, meta } = await get(`/api/dashboards/uid/${h.uid}`);
  const dir = meta.folderUid || 'general';
  const d = JSON.parse(JSON.stringify(dashboard));
  d.id = null; delete d.version;
  write(`dashboards/${dir}/${h.uid}.json`, d);
}

const strip = (ds) => ({ uid: ds.uid, name: ds.name, type: ds.type, access: ds.access, url: ds.url || '', isDefault: !!ds.isDefault, basicAuth: !!ds.basicAuth, jsonData: ds.jsonData || {} });
write('config/datasources.json', (await get('/api/datasources')).map(strip).sort((a, b) => a.uid.localeCompare(b.uid)));

const pls = [];
for (const p of await get('/api/playlists')) { const full = await get(`/api/playlists/${p.uid}`); pls.push({ name: full.name, interval: full.interval, items: full.items }); }
write('config/playlists.json', pls);
