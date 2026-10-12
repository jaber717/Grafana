// SYNTHETIC Zabbix inventory + metrics for ISOLATED validation of the Grafana Zabbix datasource plugin. Never real data.
// It is LAB-faithful where it matters: the LAB hosts, item names, keys and numeric item ids come from config/zabbix-item-descriptors.json
// (so the original Device Health tiles keep working), and it adds what a production inventory has: host groups ("Site/<name>", "Type/<name>"),
// host tags, interface error / discard / status items, and deliberately awkward devices:
//   SITE-A-SW1  reachable (ICMP + SNMP) but with NO CPU / Memory items           -> must be UP, metrics NO DATA, never DOWN
//   SITE-B-RTR2 ICMP down + SNMP unavailable since ~3 h                          -> DOWN
//   SITE-B-OLD  every item stopped reporting ~3 h ago                            -> NO DATA (stale), not DOWN
//   SITE-A-UNK1  no ICMP item, SNMP availability = unknown (0)                      -> UNKNOWN
//   SITE-B-NOMON host exists, availability items are disabled                    -> NOT MONITORED
// Values are deterministic functions of time; `addHost()` lets a test onboard a new device at runtime (no dashboard edit).
import { readFileSync } from 'node:fs';
import { mulberry32 } from '../../reports/lib/demo.mjs';

const DESCR = JSON.parse(readFileSync(new URL('../../config/zabbix-item-descriptors.json', import.meta.url), 'utf8')).items;
const STALE_AFTER_S = 3 * 3600;

export const GROUPS = [
  { groupid: '101', name: 'Site/SITE-A' }, { groupid: '102', name: 'Site/SITE-B' }, { groupid: '103', name: 'Site/CORE' }, { groupid: '104', name: 'Site/PROVIDERS' },
  { groupid: '110', name: 'Type/Router' }, { groupid: '111', name: 'Type/Switch' },
];
const G = (name) => GROUPS.find((g) => g.name === name).groupid;

// mode: normal | down | stale | pingonly | nomon | unknown.  ifs: [name, description, speed bit/s, in fraction, out fraction, full metric set?]
export const HOSTS = [
  { host: 'SITE-A', id: '10001', groups: ['Site/SITE-A', 'Type/Router'], tags: [{ tag: 'site', value: 'SITE-A' }, { tag: 'role', value: 'edge-router' }], mode: 'normal', ip: '10.1.0.1',
    ifs: [['Gi0/0', 'TO-SAIX-A-Gi0/1', 1e9, 0.62, 0.27, true], ['Gi0/1', 'LAN-SITE-A', 1e9, 0.35, 0.3, true]] },
  { host: 'SITE-B', id: '10002', groups: ['Site/SITE-B', 'Type/Router'], tags: [{ tag: 'site', value: 'SITE-B' }, { tag: 'role', value: 'edge-router' }], mode: 'normal', ip: '10.2.0.1',
    ifs: [['Gi0/0', 'TO-SAIX-B-Gi0/1', 1e9, 0.48, 0.2, false]] },
  { host: 'STC', id: '10003', groups: ['Site/PROVIDERS', 'Type/Router'], tags: [], mode: 'normal', ip: '10.9.0.3', ifs: [['Gi0/0', 'TO-INT-CORE-Gi0/0', 1e9, 0.1, 0.05, false]] },
  { host: 'MOBILY', id: '10004', groups: ['Site/PROVIDERS', 'Type/Router'], tags: [], mode: 'normal', ip: '10.9.0.4', ifs: [['Gi0/0', 'TO-INT-CORE-Gi0/1', 1e9, 0.1, 0.05, false]] },
  { host: 'SAIX-A', id: '10005', groups: ['Site/PROVIDERS', 'Type/Router'], tags: [], mode: 'normal', ip: '10.9.0.5', ifs: [['Gi0/0', 'TO-SAIX-CORE-Gi0/0', 1e9, 0.2, 0.1, false]] },
  { host: 'SAIX-B', id: '10006', groups: ['Site/PROVIDERS', 'Type/Router'], tags: [], mode: 'normal', ip: '10.9.0.6', ifs: [['Gi0/0', 'TO-SAIX-CORE-Gi0/1', 1e9, 0.2, 0.1, false]] },
  { host: 'INT-CORE', id: '10007', groups: ['Site/CORE', 'Type/Router'], tags: [{ tag: 'site', value: 'CORE' }], mode: 'normal', ip: '10.0.0.1', ifs: [] },
  { host: 'SITE-A-RTR2', id: '20001', groups: ['Site/SITE-A', 'Type/Router'], tags: [{ tag: 'site', value: 'SITE-A' }], mode: 'normal', ip: '10.1.0.2', ifs: [['Gi0/0', 'TO-SITE-A-RTR1', 1e9, 0.3, 0.25, true]] },
  { host: 'SITE-A-SW1', id: '20002', groups: ['Site/SITE-A', 'Type/Switch'], tags: [{ tag: 'site', value: 'SITE-A' }], mode: 'pingonly', ip: '10.1.0.10', ifs: [] },
  { host: 'SITE-B-RTR2', id: '20003', groups: ['Site/SITE-B', 'Type/Router'], tags: [{ tag: 'site', value: 'SITE-B' }], mode: 'down', ip: '10.2.0.2', ifs: [] },
  { host: 'SITE-B-OLD', id: '20004', groups: ['Site/SITE-B', 'Type/Router'], tags: [{ tag: 'site', value: 'SITE-B' }], mode: 'stale', ip: '10.2.0.3', ifs: [] },
  { host: 'SITE-A-UNK1', id: '20006', groups: ['Site/SITE-A', 'Type/Switch'], tags: [{ tag: 'site', value: 'SITE-A' }], mode: 'unknown', ip: '10.1.0.30', ifs: [] },
  { host: 'SITE-B-NOMON', id: '20005', groups: ['Site/SITE-B', 'Type/Switch'], tags: [{ tag: 'site', value: 'SITE-B' }], mode: 'nomon', ip: '10.2.0.20', ifs: [] },
];
export const ITEMS = [];
let nextId = 90000;
const hostRef = (h) => [{ hostid: h.id, host: h.host, name: h.host }];
const base = (h, o) => ({ hostid: h.id, value_type: '0', units: '', status: '0', state: '0', delay: '60s', history: '7d', trends: '365d', lastvalue: '0', lastclock: '0', tags: [], hosts: hostRef(h), ...o });

function itemsFor(h) {
  const out = [];
  // 1. the LAB descriptors give the original numeric ids / names / keys for the LAB hosts
  for (const [id, d] of Object.entries(DESCR)) {
    if (d.host !== h.host || d.unresolved) continue;
    const bits = /ifHC(In|Out)Octets/.exec(d.item_key);
    const kind = d.item_key === 'icmpping' ? 'ping' : /snmp,available/.test(d.item_key) ? 'snmpavail' : /cpu/.test(d.item_key) ? 'cpu' : /memory/.test(d.item_key) ? 'mem' : bits ? (bits[1] === 'In' ? 'bitsin' : 'bitsout') : 'other';
    const ifd = h.ifs[0];
    out.push(base(h, { itemid: id, name: d.item, key_: d.item_key, units: kind === 'cpu' || kind === 'mem' ? '%' : bits ? 'bps' : '', value_type: kind === 'ping' || kind === 'snmpavail' ? '3' : '0', kind, ...(bits ? { speed: ifd[2], frac: ifd[bits[1] === 'In' ? 3 : 4], ifname: ifd[0] } : {}) }));
  }
  const has = (kind) => out.some((i) => i.kind === kind);
  const add = (o) => out.push(base(h, { itemid: String(nextId++), ...o }));
  // 2. hosts that are not in the LAB descriptors get a standard SNMP router item set
  if (h.mode !== 'nomon') {
    if (!has('ping') && h.mode !== 'unknown') add({ name: 'ICMP ping', key_: 'icmpping', value_type: '3', kind: 'ping' });
    if (!has('snmpavail')) add({ name: 'SNMP agent availability', key_: 'zabbix[host,snmp,available]', value_type: '3', kind: 'snmpavail' });
  } else {
    add({ name: 'ICMP ping', key_: 'icmpping', value_type: '3', kind: 'ping', status: '1' });       // disabled item: not monitored
    add({ name: 'SNMP agent availability', key_: 'zabbix[host,snmp,available]', value_type: '3', kind: 'snmpavail', status: '1' });
  }
  if (!['pingonly', 'nomon', 'unknown'].includes(h.mode)) {
    if (!has('cpu')) add({ name: '#1: CPU utilization', key_: 'system.cpu.util[cpmCPUTotal5minRev.1]', units: '%', kind: 'cpu' });
    if (!has('mem')) add({ name: 'Processor: Memory utilization', key_: 'vm.memory.util[vm.memory.util.1]', units: '%', kind: 'mem' });
  }
  // 3. interfaces: bits (LAB ids where they exist), and for "full" interfaces status / errors / discards / speed
  h.ifs.forEach(([name, desc, speed, fin, fout, full], idx) => {
    const lab = idx === 0 && out.some((i) => i.kind === 'bitsin');
    const label = `Interface ${name}(${desc})`;
    if (!lab) {
      add({ name: `${label}: Bits received`, key_: `net.if.in[ifHCInOctets.${idx + 1}]`, units: 'bps', kind: 'bitsin', speed, frac: fin, ifname: name });
      add({ name: `${label}: Bits sent`, key_: `net.if.out[ifHCOutOctets.${idx + 1}]`, units: 'bps', kind: 'bitsout', speed, frac: fout, ifname: name });
    } else {
      for (const i of out) if (i.ifname === name) i.name = i.kind === 'bitsin' ? `${label}: Bits received` : `${label}: Bits sent`;
    }
    add({ name: `${label}: Speed`, key_: `net.if.speed[ifHighSpeed.${idx + 1}]`, value_type: '3', units: 'bps', kind: 'speed', speed, ifname: name, delay: '1h' });
    if (full) {
      add({ name: `${label}: Operational status`, key_: `net.if.status[ifOperStatus.${idx + 1}]`, value_type: '3', kind: 'ifstatus', ifname: name, delay: '5m' });
      add({ name: `${label}: Inbound packets with errors`, key_: `net.if.in.errors[ifInErrors.${idx + 1}]`, units: 'pps', kind: 'errin', ifname: name, noisy: name === 'Gi0/1' });
      add({ name: `${label}: Outbound packets with errors`, key_: `net.if.out.errors[ifOutErrors.${idx + 1}]`, units: 'pps', kind: 'errout', ifname: name });
      add({ name: `${label}: Inbound packets discarded`, key_: `net.if.in.discards[ifInDiscards.${idx + 1}]`, units: 'pps', kind: 'disin', ifname: name, noisy: name === 'Gi0/1' });
      add({ name: `${label}: Outbound packets discarded`, key_: `net.if.out.discards[ifOutDiscards.${idx + 1}]`, units: 'pps', kind: 'disout', ifname: name });
    }
  });
  for (const i of out) { i.seed = Number(i.itemid) % 100003; i.mode = h.mode; i.host = h.host; }
  return out;
}
for (const h of HOSTS) ITEMS.push(...itemsFor(h));

// onboarding at runtime: the host immediately shows up in every dashboard variable that lists hosts (nothing to edit anywhere)
export function addHost({ host, group = 'Site/SITE-A', type = 'Type/Router', mode = 'normal', interfaces = 1 }) {
  if (HOSTS.some((h) => h.host === host)) throw new Error(`host ${host} exists`);
  const id = String(30000 + HOSTS.length);
  const ifs = Array.from({ length: interfaces }, (_, i) => [`Gi0/${i}`, `LINK-${host}-${i}`, 1e9, 0.4, 0.2, true]);
  const h = { host, id, groups: [group, type], tags: [], mode, ip: `10.3.0.${HOSTS.length}`, ifs };
  HOSTS.push(h);
  ITEMS.push(...itemsFor(h));
  return h;
}
export function removeHost(host) {
  const i = HOSTS.findIndex((h) => h.host === host);
  if (i < 0) return false;
  const id = HOSTS[i].id;
  HOSTS.splice(i, 1);
  for (let k = ITEMS.length - 1; k >= 0; k--) if (ITEMS[k].hostid === id) ITEMS.splice(k, 1);
  return true;
}

// ---- values ------------------------------------------------------------------------------------------------------------------------
const riyadhHour = (t) => (((t + 3 * 3600) % 86400) / 3600);
function shape(item, t, peak) {
  const hour = riyadhHour(t);
  const rnd = mulberry32(item.seed * 100003 + Math.floor(t / 60));
  const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
  const peaks = Math.exp(-((hour - 11) ** 2) / 3) * 0.25 + Math.exp(-((hour - 20.5) ** 2) / 4) * 0.2;
  const night = hour < 5 ? 0.35 : 1;
  return Math.max(0, (diurnal + peaks) * night) * peak * (0.94 + 0.12 * rnd());
}
export function rateAt(item, tSec) { return shape(item, tSec, (item.speed * item.frac) / 1.22); }

// last second at which this item still reports (stale hosts stop 3 h before "now")
const lastReport = (item, nowS) => (item.mode === 'stale' ? nowS - STALE_AFTER_S : nowS);

export function valueAt(item, t, nowS = Math.floor(Date.now() / 1000)) {
  const down = item.mode === 'down' && t > nowS - STALE_AFTER_S;
  switch (item.kind) {
    case 'ping': return down ? 0 : 1;
    case 'snmpavail': return item.mode === 'unknown' ? 0 : down ? 2 : 1;
    case 'cpu': return Math.round(shape(item, t, 38) * 10) / 10 + 8;
    case 'mem': return Math.round((48 + 14 * Math.sin(t / 7200 + item.seed) + 2 * mulberry32(item.seed + t / 60 | 0)()) * 10) / 10;
    case 'bitsin': case 'bitsout': return Math.round(rateAt(item, t));
    case 'speed': return item.speed;
    case 'ifstatus': return 1;
    case 'errin': case 'errout': case 'disin': case 'disout': {
      const r = mulberry32(item.seed * 31 + Math.floor(t / 300))();
      return r < (item.noisy ? 0.45 : 0.04) ? Math.round(r * 40 * (item.noisy ? 3 : 1)) / 10 : 0;
    }
    default: return 0;
  }
}

const stepOf = (item) => (item.kind === 'speed' ? 3600 : item.kind === 'ifstatus' ? 300 : 60);
export function history(item, from, till, gapHost = null, nowS = Math.floor(Date.now() / 1000)) {
  if (item.status === '1') return [];                                    // disabled item: nothing is collected
  const out = [];
  const step = stepOf(item);
  const end = Math.min(till, lastReport(item, nowS));
  for (let t = Math.ceil(from / step) * step; t <= end; t += step) {
    const sinceMidnight = (t + 3 * 3600) % 86400;
    if (gapHost === item.host && sinceMidnight >= 6 * 3600 && sinceMidnight < 7.5 * 3600) continue;   // 06:00-07:30 Riyadh gap
    out.push({ itemid: item.itemid, clock: String(t), value: String(valueAt(item, t, nowS)), ns: '0' });
  }
  return out;
}

export function currentFields(item, nowS = Math.floor(Date.now() / 1000)) {
  if (item.status === '1') return { lastvalue: '0', lastclock: '0' };
  const t = Math.floor(lastReport(item, nowS) / stepOf(item)) * stepOf(item);
  return { lastvalue: String(valueAt(item, t, nowS)), lastclock: String(t) };
}
