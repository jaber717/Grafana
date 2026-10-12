// Saved report scopes: which part of the estate a daily report covers (site, device type, devices, interfaces, metrics).
// One scope can drive all three reports. Nothing here is a Zabbix item id: scopes are made of NAMES, and devices are resolved at run time
// from the Zabbix inventory, so a device added to Zabbix with the right host groups joins a "site" or "device type" scope without any edit.
//
//   site          Zabbix host group "Site/<NAME>"           (empty = every site)
//   device_group  Zabbix host group "Type/<NAME>"           (empty = every type)
//   devices       explicit Zabbix host names                (empty = every device that matches site and device_group)
//   interfaces    interface names (e.g. Gi0/0) for the interface report (empty = every configured interface)
//   metrics       availability, cpu, memory                 (network health report; empty = all three)
// Site, device_group and devices combine with AND. A scope that matches no device produces a NO DATA report that says so.
import { parseYaml } from './yaml.mjs';

export const SITE_PREFIX = 'Site/';
export const TYPE_PREFIX = 'Type/';
export const METRICS = ['availability', 'cpu', 'memory'];
const ID = /^[a-z0-9][a-z0-9_-]*$/;

const list = (v) => (v == null ? [] : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean));
// names end up inside SQL string literals and regular expressions: refuse anything that could break out of them
const SAFE = /^[^'"\\`,;|()[\]{}^$*+?<>\r\n]+$/;

export function makeScope(raw, where = 'scope') {
  const id = String(raw.id ?? '');
  if (!ID.test(id)) throw new Error(`${where}: id '${id}' must be lowercase letters, digits, '-' or '_'`);
  const s = { id, title: String(raw.title || id), sites: list(raw.site), types: list(raw.device_group), devices: list(raw.devices), interfaces: list(raw.interfaces), metrics: list(raw.metrics).map((m) => m.toLowerCase()) };
  for (const m of s.metrics) if (!METRICS.includes(m)) throw new Error(`${where} '${id}': unknown metric '${m}' (${METRICS.join(', ')})`);
  if (!s.metrics.length) s.metrics = [...METRICS];
  for (const k of ['sites', 'types', 'devices', 'interfaces']) for (const n of s[k]) if (!SAFE.test(n)) throw new Error(`${where} '${id}': '${n}' contains a character that is not allowed in a name (quotes, comma, backslash, regex or SQL characters)`);
  return s;
}

export const ALL_SCOPE = makeScope({ id: 'all', title: 'All monitored devices' });

// text = scopes.yaml content (or null/'' for "no saved scopes": the single built-in scope "all")
export function loadScopes(text) {
  const out = new Map([[ALL_SCOPE.id, ALL_SCOPE]]);
  let defaultId = ALL_SCOPE.id;
  const doc = text && text.trim() ? parseYaml(text) : null;
  if (doc) {
    for (const [i, raw] of (doc.scopes || []).entries()) {
      const s = makeScope(raw, `scopes[${i}]`);
      if (s.id === ALL_SCOPE.id) throw new Error(`scopes[${i}]: 'all' is the built-in scope and cannot be redefined`);
      if (out.has(s.id)) throw new Error(`scopes[${i}]: scope '${s.id}' is defined twice`);
      out.set(s.id, s);
    }
    if (doc.default_scope) { defaultId = String(doc.default_scope); if (!out.has(defaultId)) throw new Error(`default_scope '${defaultId}' is not defined`); }
  }
  return { scopes: out, defaultId };
}

export function pickScope(cfg, id = null) {
  const want = id || cfg.defaultId;
  const s = cfg.scopes.get(want);
  if (!s) throw new Error(`unknown scope '${want}' (defined: ${[...cfg.scopes.keys()].join(', ')})`);
  return s;
}

export const isAllScope = (s) => !s.sites.length && !s.types.length && !s.devices.length && !s.interfaces.length && s.metrics.length === METRICS.length;
export const needsInventory = (s) => s.sites.length > 0 || s.types.length > 0;

// inventory rows: {host, name, sites:[...], types:[...]} (group names WITHOUT the Site/ or Type/ prefix)
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
export function resolveDevices(scope, inventory) {
  return inventory.filter((d) =>
    (!scope.sites.length || d.sites.some((x) => scope.sites.some((y) => eq(x, y)))) &&
    (!scope.types.length || d.types.some((x) => scope.types.some((y) => eq(x, y)))) &&
    (!scope.devices.length || scope.devices.some((y) => eq(d.host, y)))).sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

// Interface report: keep the configured interfaces that belong to the scope. Interfaces are never added by a scope, only filtered.
export function scopeInterfaces(scope, cfg, devices = null) {
  if (isAllScope(scope)) return cfg;
  const hosts = devices ? new Set(devices.map((d) => d.host.toLowerCase())) : null;
  if (needsInventory(scope) && !hosts) throw new Error(`scope '${scope.id}' selects by site / device type: the Zabbix inventory is needed to resolve it`);
  const keep = (it) => (!hosts || hosts.has(it.device.toLowerCase())) && (!scope.devices.length || scope.devices.some((d) => eq(d, it.device))) &&
    (!scope.interfaces.length || scope.interfaces.some((n) => eq(n, it.interface)));
  const interfaces = cfg.interfaces.filter(keep);
  const used = new Set(interfaces.map((i) => i.boundary).filter(Boolean));
  return { ...cfg, interfaces, excluded: cfg.excluded, boundaries: cfg.boundaries.filter((b) => used.has(b)) };
}

export function scopeLabel(scope, n = null) {
  if (isAllScope(scope)) return scope.title;
  const bits = [];
  if (scope.sites.length) bits.push(`site ${scope.sites.join(', ')}`);
  if (scope.types.length) bits.push(`type ${scope.types.join(', ')}`);
  if (scope.devices.length) bits.push(`${scope.devices.length} named device${scope.devices.length === 1 ? '' : 's'}`);
  if (scope.interfaces.length) bits.push(`interfaces ${scope.interfaces.join(', ')}`);
  if (scope.metrics.length !== METRICS.length) bits.push(`metrics ${scope.metrics.join(', ')}`);
  return `${scope.title} (${bits.join(' · ')}${n == null ? '' : ` · ${n} device${n === 1 ? '' : 's'}`})`;
}

// regex-literal for the Zabbix host filter / series-name filters used by the report dashboards (names were validated by SAFE)
export const hostRegex = (hosts) => (hosts.length ? `/^(${hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')).join('|')})$/` : '/^$/');
