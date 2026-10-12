// Zabbix item-name patterns for availability, CPU and memory, read from config/monitoring-items.json (override: MONITORING_ITEMS_FILE).
// One definition for the dashboards (tools/monitoring), the daily reports and the LAB compatibility checker, so supporting another vendor's
// CPU / memory items is a configuration change, not a code change. The patterns are Zabbix-plugin regex literals: /a|b/ (substring) or /^(a|b)$/.
import { readFileSync } from 'node:fs';

const FILE = process.env.MONITORING_ITEMS_FILE || new URL('../../config/monitoring-items.json', import.meta.url);
export const CONFIG = JSON.parse(readFileSync(FILE, 'utf8'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
for (const list of [...Object.values(CONFIG.availability), CONFIG.cpu.names, CONFIG.memory.names]) {
  if (!Array.isArray(list) || !list.length) throw new Error('monitoring-items.json: every list needs at least one name');
  for (const n of list) if (typeof n !== 'string' || !n.trim() || /raw/i.test(n)) throw new Error(`monitoring-items.json: unusable item name '${n}' (raw counters are not utilisation percentages)`);
}
const lit = (names, match) => (match === 'exact' ? `/^(${names.map(esc).join('|')})$/` : `/${names.map(esc).join('|')}/`);

export const PATTERN = {
  icmp: lit(CONFIG.availability.icmp, 'exact'),
  snmp: lit(CONFIG.availability.snmp, 'exact'),
  agent: lit(CONFIG.availability.agent, 'exact'),
  cpu: lit(CONFIG.cpu.names, CONFIG.cpu.match),
  memory: lit(CONFIG.memory.names, CONFIG.memory.match),
};
// JS RegExp equivalents (for the checker and tests)
const re = (p) => new RegExp(p.slice(1, -1).replace(/\\\//g, '/'));
export const REGEX = Object.fromEntries(Object.entries(PATTERN).map(([k, v]) => [k, re(v)]));

// ---- precedence tiers --------------------------------------------------------------------------------------------------------------------
// One pattern per configured name, in precedence order. Dashboards query one target per tier and keep the first tier that has a value per
// device (Grafana 'coalesce'); the reports and the checker do the same with resolveItem()/pickTier(). Same item matched by two tiers is fine:
// the value of the first tier wins, so no device ever shows two CPU or two memory series in the table / report.
export const TIERS = { cpu: CONFIG.cpu.names.map((n) => lit([n], CONFIG.cpu.match)), memory: CONFIG.memory.names.map((n) => lit([n], CONFIG.memory.match)) };
export const TIER_REGEX = { cpu: TIERS.cpu.map(re), memory: TIERS.memory.map(re) };
// which of a device's items (names) is used for 'cpu' / 'memory': {tier, names} of the first tier that matches, else null
export function resolveItem(kind, itemNames) {
  for (let i = 0; i < TIER_REGEX[kind].length; i++) {
    const names = itemNames.filter((n) => TIER_REGEX[kind][i].test(n));
    if (names.length) return { tier: i, pattern: CONFIG[kind].names[i], names };
  }
  return null;
}
// samples of one device per tier ([tier0Samples, tier1Samples, ...]) -> the samples of the first tier that has any (never a mix of two items)
export const pickTier = (perTier) => perTier.find((s) => s && s.length) || [];
