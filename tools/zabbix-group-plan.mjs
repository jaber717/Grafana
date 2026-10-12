// READ-ONLY planner for the additive Site/ and Type/ host-group migration. It changes nothing: it prints (and optionally writes) the exact plan
// for approval - the groups to create, the memberships to ADD, the verification queries and the rollback - from a mapping file.
//   ZABBIX_ENV_FILE=... ZABBIX_CA_FILE=... node tools/zabbix-group-plan.mjs --mapping config/zabbix-group-mapping.example.yaml [--include-unconfirmed] [--out plan.json]
// Applying the plan needs a Zabbix identity allowed to call hostgroup.create / hostgroup.massadd (not the read-only compatibility account).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseYaml } from '../reports/lib/yaml.mjs';
import { connect } from './lib/zabbix-readonly.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const file = arg('mapping');
if (!file) { console.error('usage: zabbix-group-plan.mjs --mapping FILE [--include-unconfirmed] [--out plan.json]'); process.exit(1); }
const incl = process.argv.includes('--include-unconfirmed');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const { call } = connect();
const [groups, hosts] = await Promise.all([call('hostgroup.get', { output: ['groupid', 'name'] }), call('host.get', { output: ['hostid', 'host', 'name'], selectHostGroups: ['groupid', 'name'] })]);
const gByName = new Map(groups.map((g) => [g.name, g]));
const byVisible = new Map();
for (const h of hosts) byVisible.set(h.name, [...(byVisible.get(h.name) || []), h]);

const doc = parseYaml(readFileSync(file, 'utf8'));
const problems = [], skipped = [], create = new Set(), adds = new Map();      // group name -> [{hostid, name}]
for (const [i, e] of (doc.hosts || []).entries()) {
  const where = `hosts[${i}] '${e.host}'`;
  if (e.confirm && !incl) { skipped.push(`${e.host}: marked confirm - not planned until the flag is removed`); continue; }
  const m = byVisible.get(e.host);
  if (!m) { problems.push(`${where}: no Zabbix host with this visible name`); continue; }
  if (m.length > 1) { problems.push(`${where}: ${m.length} hosts share this visible name`); continue; }
  for (const [prefix, v] of [['Site/', e.site], ['Type/', e.type]]) {
    if (v == null) continue;
    if (!NAME.test(String(v))) { problems.push(`${where}: '${v}' is not a valid ${prefix} code (letters, digits, . _ -)`); continue; }
    const g = prefix + v;
    if (m[0].hostgroups.some((x) => x.name === g)) continue;                    // already a member: nothing to do
    if (!gByName.has(g)) create.add(g);
    adds.set(g, [...(adds.get(g) || []), { hostid: m[0].hostid, name: e.host }]);
  }
}

const plan = {
  generated: new Date().toISOString(), zabbixHosts: hosts.length, existingGroups: groups.map((g) => g.name),
  unchangedGuarantee: 'only hostgroup.create and hostgroup.massadd (additive); no group, template, item, SNMP setting or other membership is touched',
  createGroups: [...create].sort(),
  addMemberships: [...adds].sort().map(([group, hs]) => ({ group, existing: gByName.get(group)?.groupid || null, hosts: hs })),
  apply: [
    ...[...create].sort().map((name) => ({ method: 'hostgroup.create', params: { name } })),
    ...[...adds].sort().map(([group, hs]) => ({ method: 'hostgroup.massadd', params: { groups: [{ groupid: gByName.get(group)?.groupid || `<id of ${group} from the create call>` }], hosts: hs.map((h) => ({ hostid: h.hostid })) } })),
  ],
  verify: [
    { check: 'every planned host is in its group', call: "host.get {filter:{name:[<hosts>]}, selectHostGroups:['name']} - each host lists the planned group AND all its previous groups" },
    { check: 'nothing else changed', call: "hostgroup.get {output:['name'], selectHosts:'count'} - previous groups keep their host counts; item.get count per host unchanged" },
    { check: 'dashboards see them', call: 'node tools/lab-compat-check.mjs: no "Site/" / "Type/" gap and no host-group warning' },
  ],
  rollback: [
    ...[...adds].sort().map(([group, hs]) => ({ method: 'hostgroup.massremove', params: { groupids: [gByName.get(group)?.groupid || `<id of ${group}>`], hostids: hs.map((h) => h.hostid) }, note: 'removes only the memberships added by this plan' })),
    ...[...create].sort().map((name) => ({ method: 'hostgroup.delete', params: [`<id of ${name}>`], note: 'only when the group is empty and was created by this plan' })),
  ],
  skipped, problems,
};
const text = JSON.stringify(plan, null, 2);
if (arg('out')) writeFileSync(arg('out'), text + '\n');
console.log(`Zabbix hosts ${hosts.length}; planned: ${plan.createGroups.length} group(s) to create, ${plan.addMemberships.reduce((n, a) => n + a.hosts.length, 0)} membership(s) to add; ${skipped.length} skipped (unconfirmed), ${problems.length} problem(s)\n`);
for (const g of plan.createGroups) console.log(`  create group   ${g}`);
for (const a of plan.addMemberships) console.log(`  add to ${a.group.padEnd(22)} ${a.hosts.map((h) => h.name).join(', ')}`);
for (const x of skipped) console.log(`  skipped        ${x}`);
for (const x of problems) console.log(`  PROBLEM        ${x}`);
console.log('\nRead-only: nothing was changed in Zabbix.' + (arg('out') ? ` Full plan (apply / verify / rollback calls): ${arg('out')}` : ' Use --out FILE for the full JSON-RPC plan.'));
process.exit(problems.length ? 2 : 0);
