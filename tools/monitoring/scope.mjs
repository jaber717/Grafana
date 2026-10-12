// Unified monitoring scope: the variables, links and building blocks every compatible NOC dashboard shares.
//
// Inventory source of truth = ZABBIX (read natively by Grafana, no sync, no extra service):
//   site          Zabbix host group  "Site/<NAME>"          (host group prefix is configurable here, see SITE_PREFIX)
//   device_group  Zabbix host group  "Type/<NAME>"          (device type / role)
//   device        Zabbix host (visible name), listed from the groups above; All = every host in the selected scope
//   interface     Zabbix items "Interface <name>(<alias>): Bits received" of the selected devices
// A new device appears in every selector as soon as it exists in Zabbix with its groups - nothing to edit in Grafana.
//
// Variable NAMES are the same on every dashboard so the dashboard links can carry the selection (var-site, var-device, ...).
// Each dashboard defines the variables itself (own "All" semantics for its datasource); only the current VALUES travel in the URL.
export const SITE_PREFIX = 'Site/';
export const TYPE_PREFIX = 'Type/';

export const DS = {
  zabbix: { type: 'alexanderzobnin-zabbix-datasource', uid: 'zabbix-lab' },
  clickhouse: { type: 'grafana-clickhouse-datasource', uid: 'netflow-clickhouse' },
  inventory: { type: 'grafana-testdata-datasource', uid: process.env.NOC_INVENTORY_DS_UID || 'noc-inventory' },   // built-in TestData: local, no network; builds the device list frame
  dashboard: { type: 'datasource', uid: '-- Dashboard --' },
  mixed: { type: 'datasource', uid: '-- Mixed --' },
};

export const COLORS = { up: '#2E8B57', down: '#C53030', unknown: '#D98E04', nodata: '#5B7A99', notmon: '#8A94A3', inbound: '#2F6EBA', outbound: '#E0861B', neutral: '#6E8CAE' };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const ALL = { text: 'All', value: '$__all' };

const qvar = (name, label, description, query, o = {}) => ({
  type: 'query', name, label, description, datasource: DS.zabbix, query, definition: JSON.stringify(query), refresh: 1, sort: 1,
  multi: false, includeAll: true, current: ALL, options: [], skipUrlSync: false, ...o,
});

// ---- Zabbix-backed selectors --------------------------------------------------------------------------------------------------------
export function siteVar() {
  return qvar('site', 'Site', `Site = Zabbix host group "${SITE_PREFIX}<name>". All = every monitored host, including hosts without a site group.`,
    { queryType: 'group', group: `/^${esc(SITE_PREFIX)}.*/` },
    { regex: `/^(?<value>${esc(SITE_PREFIX)}(?<text>.*))$/`, allValue: '.*' });
}
export function deviceGroupVar() {
  return qvar('device_group', 'Device type', `Device type = Zabbix host group "${TYPE_PREFIX}<name>" (router, switch, ...).`,
    { queryType: 'group', group: `/^${esc(TYPE_PREFIX)}.*/` },
    { regex: `/^(?<value>${esc(TYPE_PREFIX)}(?<text>.*))$/`, allValue: '.*' });
}
// hidden helper: hosts of the selected site(s). "All" expands to the list of these hosts, which is what lets the next variable intersect site and type.
export function siteHostsVar() {
  return qvar('site_hosts', 'Hosts of the site', 'internal helper', { queryType: 'host', group: '$site', host: '/.*/' }, { multi: true, hide: 2 });
}
export function deviceVar({ includeAll = true } = {}) {
  return qvar('device', 'Device', 'Devices of the selected site and type. Pick one or several to compare. New Zabbix hosts appear here automatically.',
    { queryType: 'host', group: '$device_group', host: '$site_hosts' }, { multi: true, includeAll });
}
// interface list of the selected devices; value = "<ifName>(<alias>)" taken from the Zabbix item name
export function interfaceVar() {
  return qvar('interface', 'Interface', 'Interfaces of the selected devices. Series always show "device: interface", so equal names on different devices stay distinguishable.',
    { queryType: 'item', group: '/.*/', host: '$device', application: '', item: '/^Interface .*: Bits received$/' },
    { regex: '/^Interface (.*): Bits received$/', multi: true });
}
export function customVar(name, label, description, options, { multi = false, current = null, includeAll = false } = {}) {
  const opts = options.map(([text, value]) => ({ text, value, selected: false }));
  const cur = current || opts[0];
  return { type: 'custom', name, label, description, query: options.map(([t, v]) => `${t} : ${v}`).join(', '), multi, includeAll, current: multi ? { text: [].concat(cur).map((c) => c.text), value: [].concat(cur).map((c) => c.value) } : cur, options: opts, skipUrlSync: false };
}

// ---- navigation: every NOC dashboard links to every other one and carries the selection and the time range ------------------------
export function navLinks() {
  return [{ type: 'dashboards', title: 'NOC dashboards', tags: ['netops'], asDropdown: true, includeVars: true, keepTime: true, icon: 'dashboard', targetBlank: false, tooltip: 'Switch dashboard and keep site, device and time range' }];
}

export const DASH_REF = (panelId) => ({ refId: 'A', datasource: DS.dashboard, panelId, withTransforms: true });
