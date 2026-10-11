// Builds the Zabbix item map for a NEW Zabbix server (READ-ONLY: only apiinfo.version, host.get and item.get are called).
//
//   ZABBIX_URL=https://zabbix.example.com/api_jsonrpc.php ZABBIX_TOKEN_FILE=/root/zbx-readonly.token \
//     node tools/zabbix-item-map.mjs [--descriptors config/zabbix-item-descriptors.json] [--out /etc/grafana-platform/zabbix-item-map.json]
//
// The NOC dashboards address Zabbix items by numeric id (queryType 3). Ids are specific to one Zabbix database, so the LAB ids mean nothing on
// another server. config/zabbix-item-descriptors.json says which host + item key each LAB id stood for; this tool finds the same host + key
// on the target Zabbix and writes {"<lab id>": "<target id>"}. It never guesses: a host or key that is missing or ambiguous, and the
// descriptors marked unresolved, are listed and the exit code is 3 (the file is still written with everything that WAS resolved,
// so the missing entries can be added by hand).
//
// Token: a Zabbix API token of a read-only user (never put it on the command line). TLS is verified with the system trust store
// (NODE_EXTRA_CA_CERTS=/path/ca.pem to add a private CA).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseArgs, fail } from '../scripts/lib/grafana.mjs';

const args = parseArgs(process.argv.slice(2));
const URL_ = process.env.ZABBIX_URL || fail('set ZABBIX_URL (…/api_jsonrpc.php)', 2);
const token = process.env.ZABBIX_TOKEN || (process.env.ZABBIX_TOKEN_FILE ? readFileSync(process.env.ZABBIX_TOKEN_FILE, 'utf8').trim() : fail('set ZABBIX_TOKEN_FILE (or ZABBIX_TOKEN)', 2));

let seq = 0;
async function rpc(method, params) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++seq }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data || ''}`);
  return j.result;
}

export async function buildMap(descriptors, call = rpc) {
  const items = descriptors.items || descriptors;
  const hostIds = new Map(), map = {}, problems = [];
  for (const [labId, d] of Object.entries(items)) {
    if (d.unresolved) { problems.push(`${labId}: descriptor is unresolved (no data when captured) - used in ${(d.used_in || []).join('; ')}`); continue; }
    if (!hostIds.has(d.host)) { const h = await call('host.get', { output: ['hostid', 'host'], filter: { host: [d.host] } }); hostIds.set(d.host, h.length === 1 ? h[0].hostid : (h.length ? 'AMBIGUOUS' : null)); }
    const hid = hostIds.get(d.host);
    if (!hid) { problems.push(`${labId}: host "${d.host}" not found`); continue; }
    if (hid === 'AMBIGUOUS') { problems.push(`${labId}: host name "${d.host}" is ambiguous`); continue; }
    const found = await call('item.get', { output: ['itemid', 'key_', 'name'], hostids: [hid], filter: { key_: [d.item_key] } });
    if (found.length !== 1) { problems.push(`${labId}: ${found.length} item(s) with key ${d.item_key} on host ${d.host}`); continue; }
    map[labId] = found[0].itemid;
  }
  return { map, problems };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('zabbix-item-map.mjs')) {
  const desc = JSON.parse(readFileSync(args.descriptors || join(ROOT, 'config', 'zabbix-item-descriptors.json'), 'utf8'));
  console.log(`Zabbix API ${await rpc('apiinfo.version', {}).catch(() => '(version call needs no auth; continuing)')} at ${URL_}`);
  const { map, problems } = await buildMap(desc);
  const out = args.out || 'zabbix-item-map.json';
  writeFileSync(out, JSON.stringify(map, null, 2) + '\n', { mode: 0o640 });
  console.log(`wrote ${out}: ${Object.keys(map).length} item(s) mapped`);
  if (problems.length) { console.log(`\n${problems.length} item(s) NOT mapped - add them to the file by hand or fix the Zabbix side:`); problems.forEach((p) => console.log('  - ' + p)); process.exit(3); }
  console.log('all items mapped');
}
