// Backs up the Grafana CONTENT that this repository manages (and the alerting objects), through the read-only API.
//   node scripts/backup.mjs [--out backups] [--keep 10]
// Creates <out>/grafana-<stamp>/ (mode 0700) with: dashboards/<folder>/<uid>.json (full API response incl. meta and version),
// folders.json, datasources.json (definitions only: Grafana never returns secrets), playlists.json, alert-rules.json,
// contact-points.json, policies.json, mute-timings.json, templates.json, org-preferences.json, plugins.json, users.json (login/role only)
// and manifest.json (SHA-256 of every file + Grafana version). Nothing is written to Grafana. Keeps the newest --keep backups.
// For the database file and /etc/grafana use scripts/backup-lxc.sh inside the container.
import { mkdirSync, writeFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { get, URL_, parseArgs, stamp, sha256, fail } from './lib/grafana.mjs';

const args = parseArgs(process.argv.slice(2));
const base = resolve(args.out || 'backups');
const keep = Number(args.keep || 10);
const dir = join(base, `grafana-${stamp()}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const files = {};
const save = (rel, obj) => {
  const text = JSON.stringify(obj, null, 2) + '\n';
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(p, text, { mode: 0o600 });
  files[rel] = sha256(text);
};

const health = await get('/api/health').catch((e) => fail(`Grafana is not reachable at ${URL_}: ${e.message}`));
save('folders.json', await get('/api/folders'));
for (const h of await get('/api/search?type=dash-db&limit=5000')) {
  const full = await get(`/api/dashboards/uid/${h.uid}`);
  save(`dashboards/${full.meta.folderUid || 'general'}/${h.uid}.json`, full);
}
save('datasources.json', await get('/api/datasources'));
const pls = [];
for (const p of await get('/api/playlists')) pls.push({ uid: p.uid, ...(await get(`/api/playlists/${p.uid}`)) });
save('playlists.json', pls);
for (const [name, path] of [['alert-rules', '/api/v1/provisioning/alert-rules'], ['contact-points', '/api/v1/provisioning/contact-points'], ['policies', '/api/v1/provisioning/policies'],
  ['mute-timings', '/api/v1/provisioning/mute-timings'], ['templates', '/api/v1/provisioning/templates'], ['org-preferences', '/api/org/preferences']]) {
  save(`${name}.json`, await get(path).catch((e) => ({ unavailable: String(e.message).slice(0, 120) })));
}
save('plugins.json', (await get('/api/plugins?core=0')).map((p) => ({ id: p.id, type: p.type, version: p.info?.version, signature: p.signature })));
save('users.json', (await get('/api/users').catch(() => [])).map((u) => ({ login: u.login, name: u.name, isAdmin: u.isAdmin, isDisabled: u.isDisabled })));
save('manifest.json', { created: new Date().toISOString(), grafanaUrl: URL_, grafanaVersion: health.version, files });
try { chmodSync(dir, 0o700); } catch { /* windows */ }
console.log(`backup written: ${dir} (${Object.keys(files).length} files)`);

const all = readdirSync(base).filter((n) => n.startsWith('grafana-')).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) { rmSync(join(base, old), { recursive: true, force: true }); console.log(`pruned ${old}`); }
