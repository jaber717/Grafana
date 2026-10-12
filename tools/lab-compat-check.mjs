// READ-ONLY compatibility check of a real Zabbix against what the universal-selection dashboards and the daily reports expect.
// Calls only hostgroup.get / host.get / item.get (a read-only API token is enough). Writes nothing anywhere; prints a report.
//   ZABBIX_URL=https://zabbix/api_jsonrpc.php ZABBIX_TOKEN_FILE=/path/token  node tools/lab-compat-check.mjs [--exporters file] [--json]
//   --exporters FILE   one ExporterName per line (from ClickHouse:  SELECT DISTINCT ExporterName FROM default.flows_1h0m0s WHERE TimeReceived > now() - INTERVAL 30 DAY)
import { readFileSync } from 'node:fs';
import { REGEX, resolveItem, TIER_REGEX } from '../reports/lib/item-patterns.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
import { connect } from './lib/zabbix-readonly.mjs';
const { call } = connect();

// what the dashboards / reports look for (same patterns as tools/monitoring and reports/lib)
const WANT = { ping: REGEX.icmp, snmp: REGEX.snmp, agent: REGEX.agent, cpu: REGEX.cpu, mem: REGEX.memory };   // config/monitoring-items.json
const LOOKS = { cpu: /cpu|processor|处理器/i, mem: /mem|ram/i };
const IFACE = /^Interface (.+?)\((.*)\): Bits (received|sent)$/;
const IFACE_LIKE = /bits (received|sent)|ifhc(in|out)octets|net\.if\.(in|out)\[/i;

const [groups, hosts] = await Promise.all([
  call('hostgroup.get', { output: ['groupid', 'name'] }),
  call('host.get', { output: ['hostid', 'host', 'name', 'status'], selectHostGroups: ['name'], selectInterfaces: ['type', 'ip'], selectTags: ['tag', 'value'], selectInventory: ['location', 'type', 'vendor', 'model'] }),
]);
const items = await call('item.get', { output: ['itemid', 'hostid', 'name', 'key_', 'status', 'units', 'lastvalue'], hostids: hosts.map((h) => h.hostid), ...(process.argv.includes("--include-disabled") ? {} : { filter: { status: 0 } }) });
const byHost = new Map(hosts.map((h) => [h.hostid, { h, items: [] }]));
for (const it of items) byHost.get(it.hostid)?.items.push(it);

// --dump TEXT: list every item (name, key, enabled, last value) of the hosts whose name contains TEXT
if (process.argv.includes("--dump")) {
  for (const { h, items: its } of byHost.values()) if (h.name.toLowerCase().includes((arg("dump") || "").toLowerCase())) {
    console.log("== " + h.name + " [" + h.host + "] groups: " + (h.hostgroups || []).map((g) => g.name).join(", "));
    for (const i of its) console.log("  " + i.name + "  [" + i.key_ + "]");
  }
  process.exit(0);
}
const out = { groups: groups.map((g) => g.name).sort(), hosts: [], findings: [] };
const find = (sev, msg) => out.findings.push({ sev, msg });
const monitored = hosts.filter((h) => String(h.status) === '0');
const names = (re, list) => list.filter((i) => re.test(i.name));

for (const { h, items: its } of byHost.values()) {
  const gs = (h.hostgroups || []).map((g) => g.name);
  const row = {
    host: h.name, technical: h.host, enabled: String(h.status) === '0', sites: gs.filter((g) => g.startsWith('Site/')), types: gs.filter((g) => g.startsWith('Type/')), otherGroups: gs.filter((g) => !/^(Site|Type)\//.test(g)),
    ping: names(WANT.ping, its).length, snmp: names(WANT.snmp, its).length, agent: names(WANT.agent, its).length,
    huawei: /huawei|vrp|2011/i.test([h.name, h.host, ...(h.tags || []).map((t) => `${t.tag}=${t.value}`), ...its.filter((i) => /system\.(descr|objectid|hw\.model)/.test(i.key_)).map((i) => i.lastvalue), ...its.map((i) => `${i.name} ${i.key_}`)].join(' ')),
    cpu: names(WANT.cpu, its).map((i) => i.name), mem: names(WANT.mem, its).map((i) => i.name),
    cpuCandidates: its.filter((i) => LOOKS.cpu.test(i.name) && !WANT.cpu.test(i.name)).map((i) => `${i.name} [${i.key_}]`).slice(0, 6),
    memCandidates: its.filter((i) => LOOKS.mem.test(i.name) && !WANT.mem.test(i.name)).map((i) => `${i.name} [${i.key_}]`).slice(0, 6),
    ifaces: its.filter((i) => IFACE.test(i.name)).length / 2,
    ifaceLike: its.filter((i) => IFACE_LIKE.test(`${i.name} ${i.key_}`) && !IFACE.test(i.name)).map((i) => `${i.name} [${i.key_}]`).slice(0, 4),
    ifStatus: its.filter((i) => /^Interface .*: Operational status$/.test(i.name)).length,
    ifErr: its.filter((i) => /^Interface .*: (Inbound|Outbound) packets (with errors|discarded)$/.test(i.name)).length,
    ifSpeed: its.filter((i) => /^Interface .*: Speed$/.test(i.name)).length,
    descr: ((its.find((i) => i.key_ === 'system.descr') || {}).lastvalue || '').slice(0, 70), tags: (h.tags || []).map((t) => t.tag + '=' + t.value), inventory: Object.entries(h.inventory && !Array.isArray(h.inventory) ? h.inventory : {}).filter(([, v]) => v).map(([k, v]) => k + '=' + v), interfaceTypes: [...new Set((h.interfaces || []).map((i) => ({ 1: 'agent', 2: 'snmp', 3: 'ipmi', 4: 'jmx' }[i.type] || i.type)))],
  };
  const nm = its.map((i) => i.name);
  row.cpuUsed = resolveItem('cpu', nm)?.pattern || null; row.memUsed = resolveItem('memory', nm)?.pattern || null;
  for (const [k, kind] of [['CPU', 'cpu'], ['Memory', 'memory']]) { const hit = TIER_REGEX[kind].map((r, i) => (nm.some((n) => r.test(n)) ? i : -1)).filter((i) => i >= 0); const used = resolveItem(kind, nm); if (used && new Set(nm.filter((n) => TIER_REGEX[kind].some((r) => r.test(n))).map((n) => TIER_REGEX[kind].findIndex((r) => r.test(n)))).size > 1) find('info', `${row.host}: several ${k} items (${nm.filter((n) => TIER_REGEX[kind].some((r) => r.test(n))).join(' | ')}): '${used.pattern}' is used, the others are ignored (precedence in config/monitoring-items.json)`); }
  out.hosts.push(row);
  if (!row.enabled) continue;
  if (!row.sites.length) find('warn', `${row.host}: no Site/<NAME> host group - appears only under Site = All`);
  if (!row.types.length) find('warn', `${row.host}: no Type/<NAME> host group - appears only under Device type = All`);
  if (!row.ping && !row.snmp && !row.agent) find('warn', `${row.host}: no ICMP, SNMP-availability or Zabbix-agent availability item - shows NOT MONITORED`);
  else if (!row.ping && !row.snmp) find('info', `${row.host}: availability only from the Zabbix agent (UP = the agent answers, not that interfaces or services are reachable; no availability percentage)`);
  if (!row.cpu.length) find(row.cpuCandidates.length ? 'gap' : 'info', `${row.host}: no item matching /CPU utilization/${row.cpuCandidates.length ? `; possible CPU items: ${row.cpuCandidates.join(' | ')}` : ' (no CPU item at all)'}`);
  if (!row.mem.length) find(row.memCandidates.length ? 'gap' : 'info', `${row.host}: no item matching /Memory utilization/${row.memCandidates.length ? `; possible memory items: ${row.memCandidates.join(' | ')}` : ' (no memory item at all)'}`);
  if (row.huawei && (!row.cpu.length || !row.mem.length)) find('gap', `${row.host}: Huawei device without matching CPU/Memory items (cpu: ${row.cpu.length}, memory: ${row.mem.length}); candidates: ${[...row.cpuCandidates, ...row.memCandidates].join(' | ') || 'none'}`);
  if (row.ifaceLike.length) find(row.ifaces > 0 || !row.snmp ? 'info' : 'gap', `${row.host}: traffic items not named "Interface X(desc): Bits received/sent": ${row.ifaceLike.join(' | ')}`);
}
// duplicate visible names break the name-based filters
const dup = Object.entries(monitored.reduce((m, h) => ((m[h.name] = (m[h.name] || 0) + 1), m), {})).filter(([, n]) => n > 1);
for (const [n] of dup) find('gap', `visible host name '${n}' is used by several hosts - name-based selection is ambiguous`);
const diff = monitored.filter((h) => h.name !== h.host);
if (diff.length) find('info', `${diff.length} host(s) have a visible name different from the technical name (the dashboards and ExporterName matching use the VISIBLE name): ${diff.slice(0, 5).map((h) => `${h.host} -> ${h.name}`).join(', ')}`);
if (!out.groups.some((g) => g.startsWith('Site/'))) find('gap', 'no host group starts with "Site/": the Site selector would be empty. Either create the groups or configure another prefix (tools/monitoring/scope.mjs SITE_PREFIX) - candidate groups: ' + out.groups.join(', '));
if (!out.groups.some((g) => g.startsWith('Type/'))) find('gap', 'no host group starts with "Type/": the Device type selector would be empty - candidate groups: ' + out.groups.join(', '));

// Huawei: only judged when a Huawei device actually exists in the visible inventory
const hw = out.hosts.filter((r) => r.enabled && r.huawei);
out.huawei = hw.length ? { devices: hw.map((r) => r.host), withCpu: hw.filter((r) => r.cpu.length).length, withMemory: hw.filter((r) => r.mem.length).length } : 'NOT TESTABLE';
if (!hw.length) find('info', 'Huawei CPU/Memory: NOT TESTABLE - no Huawei device is visible in this inventory (add the item names to config/monitoring-items.json when they are known; raw counters are never accepted)');

// exporter mapping
const exp = arg('exporters');
if (exp) {
  const ex = readFileSync(exp, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const vis = new Set(monitored.map((h) => h.name)), tech = new Set(monitored.map((h) => h.host));
  out.exporters = { matchVisible: ex.filter((e) => vis.has(e)), matchTechnicalOnly: ex.filter((e) => !vis.has(e) && tech.has(e)), unmatched: ex.filter((e) => !vis.has(e) && !tech.has(e)), hostsWithoutExporter: monitored.map((h) => h.name).filter((n) => !ex.includes(n)) };
  for (const e of out.exporters.matchTechnicalOnly) find('gap', `exporter '${e}' equals a technical host name, not the visible name`);
  const norm = (x) => x.toLowerCase().replace(/^(pnet|lab)[-_]/, '').replace(/\(.*\)/, '').trim();
  for (const e of out.exporters.unmatched) {
    const cand = monitored.filter((h) => norm(h.name) === norm(e) || norm(h.host) === norm(e) || h.name.toLowerCase().includes(e.toLowerCase()) || norm(h.host).includes(norm(e)) || norm(e).includes(norm(h.host))).map((h) => h.name);
    find('gap', `exporter '${e}' matches no Zabbix host (shows NOT IN INVENTORY)${cand.length ? `; probable device: ${cand.join(', ')} - rename the exporter in Akvorado to the visible host name, or the Zabbix host to the exporter name` : '; no similar host'}`);
  }
}

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`Zabbix: ${hosts.length} hosts (${monitored.length} enabled), ${groups.length} host groups, ${items.length} enabled items\n\nHost groups: ${out.groups.join(', ')}\n`);
console.log(`${pad('host', 26)} ${pad('sites', 14)} ${pad('types', 12)} ping snmp cpu mem ifaces status err speed`);
for (const r of out.hosts.filter((x) => x.enabled)) console.log(`${pad(r.host, 26)} ${pad(r.sites.map((s) => s.slice(5)).join(','), 14)} ${pad(r.types.map((s) => s.slice(5)).join(','), 12)} ${pad(r.ping, 4)} ${pad(r.snmp, 4)} ${pad(r.cpu.length, 3)} ${pad(r.mem.length, 3)} ${pad(r.ifaces, 6)} ${pad(r.ifStatus, 6)} ${pad(r.ifErr, 3)} ${r.ifSpeed}`);
console.log(`\nFindings (${out.findings.length}):`);
for (const f of out.findings) console.log(`  [${f.sev}] ${f.msg}`);
const gaps = out.findings.filter((f) => f.sev === 'gap').length;
console.log(`\n${gaps ? `${gaps} compatibility gap(s)` : 'no compatibility gap'}`);
process.exit(gaps ? 2 : 0);
