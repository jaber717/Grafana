// Read-only interface discovery for onboarding. Only item.get is called (a read-only Zabbix API token is enough, same as tools/zabbix-item-map.mjs).
// It PROPOSES interfaces; it never selects any: every candidate is written with include: false, so an administrator must opt each one in.
// This is a configuration helper, not a reporting path: the reports themselves are always built by Grafana.
import { loadInterfaceConfig, interfaceKey } from './config.mjs';

const NAME = /^Interface (.+?)\((.*)\): Bits (received|sent)$/;

export function parseInterfaceItemName(name) {
  const m = String(name).match(NAME);
  return m ? { interface: m[1], description: m[2], direction: m[3] } : null;
}

export function zabbixCaller({ url, token, fetchImpl = fetch }) {
  let seq = 0;
  return async (method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++seq }), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data || ''}`);
    return j.result;
  };
}

// call(method, params) -> result. Returns [{device, hostTechnical, interface, description, rxItem, txItem, speedBps, issues:[]}]
export async function discoverInterfaces(call) {
  const base = { output: ['itemid', 'name', 'key_', 'lastvalue', 'units', 'status'], selectHosts: ['host', 'name'], filter: { status: 0 }, sortfield: 'name' };
  const bits = await call('item.get', { ...base, search: { name: ': Bits ' } });
  const speeds = await call('item.get', { ...base, search: { name: ': Speed' } });
  const byKey = new Map();
  for (const it of bits) {
    const p = parseInterfaceItemName(it.name);
    if (!p) continue;
    const host = it.hosts?.[0];
    if (!host) continue;
    const key = `${host.name}\u0000${p.interface}`;
    const c = byKey.get(key) || { device: host.name, hostTechnical: host.host, interface: p.interface, description: p.description, rxItems: [], txItems: [], speedBps: null, issues: [] };
    (p.direction === 'received' ? c.rxItems : c.txItems).push(it.name);
    byKey.set(key, c);
  }
  for (const it of speeds) {
    const m = String(it.name).match(/^Interface (.+?)\((.*)\): Speed$/);
    const host = it.hosts?.[0];
    if (!m || !host) continue;
    const c = byKey.get(`${host.name}\u0000${m[1]}`);
    const v = Number(it.lastvalue);
    if (c && Number.isFinite(v) && v > 0) c.speedBps = v;
  }
  const hostNames = new Map();
  for (const c of byKey.values()) { const s = hostNames.get(c.device) || new Set(); s.add(c.hostTechnical); hostNames.set(c.device, s); }
  const out = [];
  for (const c of byKey.values()) {
    if (c.rxItems.length !== 1) c.issues.push(`${c.rxItems.length} 'Bits received' items`);
    if (c.txItems.length !== 1) c.issues.push(`${c.txItems.length} 'Bits sent' items`);
    if (hostNames.get(c.device).size > 1) c.issues.push('several Zabbix hosts share this visible name: the item filter would be ambiguous');
    out.push({ device: c.device, hostTechnical: c.hostTechnical, interface: c.interface, description: c.description, rxItem: c.rxItems[0] || null, txItem: c.txItems[0] || null, speedBps: c.speedBps, issues: c.issues });
  }
  return out.sort((a, b) => a.device.localeCompare(b.device) || a.interface.localeCompare(b.interface, undefined, { numeric: true }));
}

const q = (s) => JSON.stringify(String(s));
const speedText = (bps) => (bps == null ? null : bps >= 1e9 && bps % 1e9 === 0 ? `${bps / 1e9}G` : bps >= 1e6 && bps % 1e6 === 0 ? `${bps / 1e6}M` : String(bps));

// A candidates file: nothing is included. Copy the entries you want into interfaces.yaml and set include: true.
export function candidatesYaml(cands, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    `# Interface candidates discovered ${generatedAt} (read-only). NOTHING here is reported: every entry has include: false.`,
    '# To report an interface: copy its entry into interfaces.yaml, choose group/boundary, check speed, and set include: true.',
    '# speed is a SUGGESTION from the Zabbix "Speed" item (empty when Zabbix has none) - verify it before relying on utilisation figures.',
    'groups:', '  - id: candidates', '    title: Discovered candidates (not reported)', 'interfaces:',
  ];
  for (const c of cands) {
    lines.push(`  - site: ${q(c.device)}`, `    device: ${q(c.device)}`, `    interface: ${q(c.interface)}`);
    if (c.description) lines.push(`    description: ${q(c.description)}`);
    if (speedText(c.speedBps)) lines.push(`    speed: ${speedText(c.speedBps)}`);
    lines.push('    group: candidates', '    include: false');
    if (c.issues.length) lines.push(`    # PROBLEM: ${c.issues.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

// Mapping check of an existing interfaces.yaml against what Zabbix has.
export function compareConfig(yamlText, cands) {
  const cfg = loadInterfaceConfig(yamlText);
  const byKey = new Map(cands.map((c) => [`${c.device}:${c.interface}`, c]));
  const report = { ok: [], problems: [], notConfigured: [] };
  for (const it of [...cfg.interfaces, ...cfg.excluded]) {
    const c = byKey.get(it.key);
    if (!c) { if (it.include) report.problems.push(`${it.key}: no matching device/interface in Zabbix`); continue; }
    if (!it.include) continue;
    const bad = [];
    if (c.rxItem !== it.rxItem) bad.push(`received item is "${c.rxItem}" in Zabbix but "${it.rxItem}" in the configuration`);
    if (c.txItem !== it.txItem) bad.push(`sent item is "${c.txItem}" in Zabbix but "${it.txItem}" in the configuration`);
    if (c.issues.length) bad.push(...c.issues);
    if (c.speedBps && it.speedBps && c.speedBps !== it.speedBps) bad.push(`speed ${it.speedBps} in the configuration but Zabbix reports ${c.speedBps}`);
    (bad.length ? report.problems.push(`${it.key}: ${bad.join('; ')}`) : report.ok.push(it.key));
  }
  const known = new Set([...cfg.interfaces, ...cfg.excluded].map((i) => i.key));
  report.notConfigured = cands.filter((c) => !known.has(`${c.device}:${c.interface}`)).map((c) => `${c.device}:${c.interface}`);
  return report;
}

export { interfaceKey };
