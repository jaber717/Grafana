// Restores folders, dashboards and playlists from a backup made by scripts/backup.mjs (this is the content ROLLBACK).
//   node scripts/restore.mjs <backup-dir> [--apply] [--only dashboards|playlists|folders]
// DRY RUN by default: verifies the manifest hashes, compares with the live Grafana and prints what would change.
// --apply writes: folders created when missing; dashboards upserted by uid with overwrite (the dashboard's own version history in
// Grafana is kept, so the state before the restore can still be recovered from the UI); playlists upserted by name.
// Datasources are NOT recreated here (their secrets are not in a backup): the script reports any that are missing - recreate them with
// scripts/apply.mjs --datasource-only and the secrets from your password store.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { api, get, URL_, parseArgs, normalizeDashboard, canonical, sha256, fail } from './lib/grafana.mjs';

const args = parseArgs(process.argv.slice(2));
const dir = args._[0] ? resolve(args._[0]) : fail('usage: restore.mjs <backup-dir> [--apply]', 2);
const APPLY = !!args.apply;
const only = args.only;
const read = (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

if (!existsSync(join(dir, 'manifest.json'))) fail(`${dir} has no manifest.json (not a backup made by backup.mjs)`);
const manifest = read('manifest.json');
for (const [rel, want] of Object.entries(manifest.files)) {
  const got = sha256(readFileSync(join(dir, rel), 'utf8'));
  if (got !== want) fail(`backup file ${rel} fails its SHA-256 check; refusing to restore from a modified backup`);
}
console.log(`backup OK: ${Object.keys(manifest.files).length} files, taken ${manifest.created} from Grafana ${manifest.grafanaVersion}`);
const health = await get('/api/health').catch((e) => fail(`Grafana is not reachable at ${URL_}: ${e.message}`));
console.log(`target: ${URL_} (Grafana ${health.version})${APPLY ? '' : '   [DRY RUN]'}`);
if (health.version !== manifest.grafanaVersion) console.log(`WARNING   backup came from Grafana ${manifest.grafanaVersion}; target is ${health.version}`);
let changes = 0;

if (!only || only === 'folders') {
  const live = new Set((await get('/api/folders')).map((f) => f.uid));
  for (const f of read('folders.json')) if (!live.has(f.uid)) { changes++; console.log(`${APPLY ? 'create ' : 'would create'} folder ${f.uid}`); if (APPLY) await api('POST', '/api/folders', { uid: f.uid, title: f.title }); }
}
if (!only || only === 'dashboards') {
  const { readdirSync } = await import('node:fs');
  for (const folderDir of readdirSync(join(dir, 'dashboards'))) {
    for (const f of readdirSync(join(dir, 'dashboards', folderDir))) {
      const full = read(`dashboards/${folderDir}/${f}`);
      const cur = await get(`/api/dashboards/uid/${full.dashboard.uid}`, { allow404: true });
      if (cur && canonical(normalizeDashboard(cur.dashboard)) === canonical(normalizeDashboard(full.dashboard)) && (cur.meta.folderUid || '') === (full.meta.folderUid || '')) { console.log(`unchanged dashboard ${full.dashboard.uid}`); continue; }
      changes++; console.log(`${APPLY ? (cur ? 'restore' : 'create ') : (cur ? 'would restore' : 'would create')} dashboard ${full.dashboard.uid}`);
      if (APPLY) await api('POST', '/api/dashboards/db', { dashboard: { ...full.dashboard, id: cur ? cur.dashboard.id : null, version: cur ? cur.dashboard.version : undefined }, folderUid: full.meta.folderUid || '', overwrite: true, message: `restore.mjs from ${manifest.created}` });
    }
  }
}
if (!only || only === 'playlists') {
  const lists = await get('/api/playlists');
  for (const p of read('playlists.json')) {
    const hit = lists.find((x) => x.name === p.name);
    const body = { name: p.name, interval: p.interval, items: p.items };
    if (hit) { const cur = await get(`/api/playlists/${hit.uid}`); if (cur.interval === p.interval && canonical(cur.items) === canonical(p.items)) { console.log(`unchanged playlist "${p.name}"`); continue; } }
    changes++; console.log(`${APPLY ? 'restore' : 'would restore'} playlist "${p.name}"`);
    if (APPLY) await (hit ? api('PUT', `/api/playlists/${hit.uid}`, { ...body, uid: hit.uid }) : api('POST', '/api/playlists', body));
  }
}
const liveDs = new Set((await get('/api/datasources')).map((d) => d.uid));
for (const d of read('datasources.json')) if (!liveDs.has(d.uid)) console.log(`MISSING   datasource ${d.uid} (${d.name}) - recreate with scripts/apply.mjs --datasource-only (secrets are not in backups)`);
console.log(`\n${APPLY ? 'restored' : 'would change'}: ${changes} object(s)`);
