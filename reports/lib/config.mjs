// Interface-report configuration (YAML). Nothing is guessed:
//  - an interface is reported only if it is listed AND has include: true (include is mandatory, so nothing enters by accident);
//  - totals are computed only inside an explicit `boundary`; interfaces without one are never added together;
//  - two included interfaces of the same boundary may not overlap (a LAG and its members, a parent and a sub-interface): list the
//    overlap in `overlaps_with` and the loader refuses the configuration instead of double counting;
//  - Zabbix items are selected by host + item NAME (the Zabbix datasource plugin resolves them), never by numeric item id.
import { parseYaml } from './yaml.mjs';

const FACING = new Set(['provider-facing', 'customer-facing']);

export function parseSpeed(v) {
  if (v == null || v === '' || v === 'unknown') return null;
  if (typeof v === 'number') { if (!(v > 0)) throw new Error(`speed must be > 0, got ${v}`); return v; }
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgGtT]?)(?:bps|bit\/s)?$/);
  if (!m) throw new Error(`cannot read speed '${v}' (use e.g. 100M, 1G, 10Gbps or a number in bit/s)`);
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

export function interfaceKey(i) {
  return `${i.device}:${i.interface}`;
}

export function loadInterfaceConfig(text) {
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object') throw new Error('interface config is empty');
  const groups = new Map();
  for (const g of doc.groups || []) {
    if (!g.id || !g.title) throw new Error('every group needs id and title');
    if (groups.has(g.id)) throw new Error(`group '${g.id}' defined twice`);
    groups.set(g.id, { id: g.id, title: g.title });
  }
  if (!groups.size) throw new Error('define at least one group');
  const seen = new Set();
  const included = [], excluded = [];
  for (const [idx, raw] of (doc.interfaces || []).entries()) {
    const where = `interfaces[${idx}]`;
    for (const f of ['site', 'device', 'interface', 'group']) if (!raw[f]) throw new Error(`${where}: '${f}' is required`);
    if (typeof raw.include !== 'boolean') throw new Error(`${where} (${raw.device}:${raw.interface}): 'include' must be true or false - interfaces are never included implicitly`);
    if (!groups.has(raw.group)) throw new Error(`${where}: unknown group '${raw.group}'`);
    const facing = raw.traffic_direction || 'provider-facing';
    if (!FACING.has(facing)) throw new Error(`${where}: traffic_direction must be provider-facing or customer-facing`);
    const key = interfaceKey(raw);
    if (seen.has(key)) throw new Error(`${where}: ${key} is listed twice`);
    seen.add(key);
    const label = raw.description ? `Interface ${raw.interface}(${raw.description})` : `Interface ${raw.interface}`;
    const entry = {
      key,
      site: String(raw.site),
      device: String(raw.device),
      interface: String(raw.interface),
      description: raw.description || '',
      speedBps: parseSpeed(raw.speed),
      trafficDirection: facing,
      group: raw.group,
      include: raw.include,
      boundary: raw.boundary || null,
      overlapsWith: raw.overlaps_with || [],
      // provider-facing: received = inbound (download); customer-facing: received = traffic going out towards customers
      rxItem: raw.rx_item || `${label}: Bits received`,
      txItem: raw.tx_item || `${label}: Bits sent`,
    };
    entry.inboundItem = facing === 'provider-facing' ? entry.rxItem : entry.txItem;
    entry.outboundItem = facing === 'provider-facing' ? entry.txItem : entry.rxItem;
    (entry.include ? included : excluded).push(entry);
  }
  // overlap rule, applied to what is actually reported
  const byKey = new Map(included.map((e) => [e.key, e]));
  for (const e of included) {
    for (const o of e.overlapsWith) {
      const other = byKey.get(o);
      if (other && other.boundary && other.boundary === e.boundary) {
        throw new Error(`${e.key} overlaps ${o} inside boundary '${e.boundary}': include only one of them or give them different boundaries`);
      }
    }
  }
  return { groups: [...groups.values()], interfaces: included, excluded, boundaries: [...new Set(included.map((e) => e.boundary).filter(Boolean))] };
}

// A total is allowed only per boundary and only over non-overlapping members.
export function boundaryMembers(cfg, boundary) {
  return cfg.interfaces.filter((e) => e.boundary === boundary);
}
