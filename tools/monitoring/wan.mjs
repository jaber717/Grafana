// NOC - WAN Overview, enhanced with the unified scope (site / device type / device / interface type / interface / direction / metric).
// The ORIGINAL six panels (uid noc-wan-overview, item ids) stay in the collapsed row at the bottom, unchanged.
//
// Identity and counting rules:
//   * Interfaces are keyed by device + interface name (series are always labelled "<device> · <interface>"), never by an item id.
//   * Series are never summed across interfaces: a physical port, its port-channel and a VLAN on top would be counted twice.
//     KPI cards therefore count interfaces or take peaks / maxima, and the bandwidth chart draws every selected interface on its own line.
//   * "Interface type" narrows the interface list by name prefix (Gi, Te, Po, Vl, ...), so aggregates can be looked at separately from members.
//   * Utilisation is shown as capacity: the summary table lists each interface's speed next to its mean / peak traffic. A computed percentage needs
//     a per-interface division that Grafana can only do on a joined frame, which would require a fixed interface list.
import { DS, COLORS, siteVar, deviceGroupVar, siteHostsVar, deviceVar, interfaceVar, customVar, navLinks } from './scope.mjs';

const fn = (name, category, ptype, params) => ({ def: { name, category, params: ptype ? [{ name: 'value', type: ptype }] : [], defaultParams: [] }, params, added: false });
const zq = (refId, item, fns = []) => ({
  refId, datasource: DS.zabbix, queryType: '0', group: { filter: '/.*/' }, host: { filter: '$device' }, application: { filter: '' }, itemTag: { filter: '' },
  item: { filter: item }, functions: fns, options: { showDisabledItems: false }, resultFormat: 'time_series',
});
const IF = (suffix) => `/^Interface ($interface)\\(.*\\): ${suffix}$/`;
const colour = (c, text, index) => ({ color: c, text, index });
const prop = (id, value) => ({ id, value });
const byRegex = (re, props) => ({ matcher: { id: 'byRegexp', options: re }, properties: props });
const nice = { id: 'renameByRegex', options: { regex: '^(.*): Interface (.*)\\((.*)\\): (.*)$', renamePattern: '$1 · $2 · $4' } };

const IDS = { bw: 220, summary: 221, explorer: 222, legacyRow: 229 };
const DIRECTIONS = [['Inbound', 'received'], ['Outbound', 'sent']];
const METRICS = [['Inbound bandwidth', 'Bits received'], ['Outbound bandwidth', 'Bits sent'], ['Operational status', 'Operational status'], ['Inbound errors', 'Inbound packets with errors'],
  ['Outbound errors', 'Outbound packets with errors'], ['Inbound discards', 'Inbound packets discarded'], ['Outbound discards', 'Outbound packets discarded']];
const TYPES = [['Gigabit Ethernet', 'Gi'], ['Ten-Gigabit Ethernet', 'Te'], ['Fast Ethernet', 'Fa'], ['Ethernet', 'Eth'], ['Port-channel', 'Po'], ['VLAN', 'Vl'], ['Loopback', 'Lo'], ['Tunnel', 'Tu']];

function variables() {
  const ifaceType = customVar('interface_type', 'Interface type', 'Interface types by name prefix (Gi, Te, Po, Vl ...). All = every interface. Look at port-channels or VLANs separately to avoid counting overlapping interfaces twice.', TYPES, { multi: true, includeAll: true, current: { text: 'All', value: '$__all' } });
  ifaceType.current = { text: ['All'], value: ['$__all'] }; ifaceType.allValue = '.*';
  const iface = interfaceVar();
  iface.query = { queryType: 'item', group: '/.*/', host: '$device', application: '', item: '/^Interface ($interface_type)[^(]*\\(.*\\): Bits received$/' };
  iface.definition = JSON.stringify(iface.query);
  iface.regex = '/^Interface (?<text>(?<value>[^(]+)\\(.*\\)): Bits received$/';
  iface.allValue = '.*';
  const direction = customVar('direction', 'Direction', 'Inbound and / or outbound traffic (bandwidth chart and KPI cards).', DIRECTIONS, { multi: true, current: DIRECTIONS.map(([text, value]) => ({ text, value })) });
  const metric = customVar('metric', 'Metric', 'What the lower chart shows: bandwidth, operational status, errors or discards, for the selected interfaces. Only metrics monitored on the interface return data.', METRICS, { multi: true, current: [METRICS[2]].map(([text, value]) => ({ text, value })) });
  return [siteVar(), deviceGroupVar(), siteHostsVar(), deviceVar(), ifaceType, iface, direction, metric];
}

const statBase = (id, x, title, description, targets, transformations, calc, field, overrides = {}) => ({
  id, type: 'stat', title, description, gridPos: { x, y: 0, w: 4, h: 4 }, datasource: DS.zabbix, targets, transformations,
  fieldConfig: { defaults: { noValue: '—', decimals: 0, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: COLORS.neutral, value: null }] }, ...overrides }, overrides: [] },
  options: { reduceOptions: { values: false, calcs: [calc], fields: field }, colorMode: 'background', graphMode: 'none', textMode: 'value', justifyMode: 'center', text: { valueSize: 32, titleSize: 13 } },
});
const countWhere = (targets, filters) => [{ id: 'reduce', options: { mode: 'seriesToRows', reducers: ['lastNotNull'], labelsToFields: false } }, ...(filters ? [{ id: 'filterByValue', options: { type: 'include', match: 'any', filters } }] : [])];

const reduceMax = [{ id: 'reduce', options: { mode: 'seriesToRows', reducers: ['max'], labelsToFields: false } }];
function kpis() {
  const status = [zq('A', IF('Operational status'))];
  const rx = [zq('A', IF('Bits received'))], tx = [zq('A', IF('Bits sent'))];
  const prob = [zq('A', IF('(Inbound|Outbound) packets (with errors|discarded)'))];
  const k = [
    statBase(200, 0, 'Interfaces', 'Interfaces of the selected devices that report traffic counters.', rx, countWhere(rx), 'count', '/^Field$/', {}),
    statBase(201, 4, 'Oper UP', 'Interfaces whose operational status is up. Only interfaces monitored for status are counted.', status, countWhere(status, [{ fieldName: 'Last *', config: { id: 'equal', options: { value: 1 } } }]), 'count', '/^Field$/', { thresholds: { mode: 'absolute', steps: [{ color: COLORS.neutral, value: null }, { color: COLORS.up, value: 1 }] }, noValue: '0' }),
    statBase(202, 8, 'Oper DOWN / other', 'Interfaces whose operational status is not up (down, testing, lower-layer-down ...).', status, countWhere(status, [{ fieldName: 'Last *', config: { id: 'notEqual', options: { value: 1 } } }]), 'count', '/^Field$/', { thresholds: { mode: 'absolute', steps: [{ color: COLORS.neutral, value: null }, { color: COLORS.down, value: 1 }] }, noValue: '0' }),
    statBase(203, 12, 'Peak inbound', 'Highest inbound rate of any single selected interface in the time range (a maximum, not a sum, so overlapping interfaces are not counted twice).', rx, reduceMax, 'max', '/^Max$/', { unit: 'bps', decimals: 1 }),
    statBase(204, 16, 'Peak outbound', 'Highest outbound rate of any single selected interface in the time range.', tx, reduceMax, 'max', '/^Max$/', { unit: 'bps', decimals: 1 }),
    statBase(205, 20, 'Error / discard counters', 'Error and discard counters (per interface and direction) that counted at least one in the time range.', prob, [{ id: 'reduce', options: { mode: 'seriesToRows', reducers: ['sum'], labelsToFields: false } }, { id: 'filterByValue', options: { type: 'include', match: 'any', filters: [{ fieldName: 'Total', config: { id: 'greater', options: { value: 0 } } }] } }], 'count', '/^Field$/', { thresholds: { mode: 'absolute', steps: [{ color: COLORS.neutral, value: null }, { color: COLORS.unknown, value: 1 }] }, noValue: '0' }),
  ];
  return k;
}

function charts() {
  const bwTargets = [zq('A', IF('Bits ($direction)'))];
  return [
    { id: IDS.bw, type: 'timeseries', title: 'Bandwidth — ${direction:text}', gridPos: { x: 0, y: 4, w: 14, h: 10 }, datasource: DS.zabbix, targets: bwTargets, transformations: [nice],
      description: 'One line per selected device and interface. Lines are never added together.',
      fieldConfig: { defaults: { unit: 'bps', min: 0, noValue: 'NO DATA for the selected devices / interfaces', custom: { drawStyle: 'line', lineWidth: 1.5, fillOpacity: 10, showPoints: 'never', axisBorderShow: false } },
        overrides: [byRegex('.*received.*|.*Bits received.*', [prop('color', { mode: 'fixed', fixedColor: COLORS.inbound })]), byRegex('.*sent.*', [prop('color', { mode: 'fixed', fixedColor: COLORS.outbound })])] },
      options: { legend: { displayMode: 'table', placement: 'bottom', showLegend: true, calcs: ['lastNotNull', 'mean', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } } },
    { id: IDS.summary, type: 'table', title: 'Interface summary (capacity next to traffic)', gridPos: { x: 14, y: 4, w: 10, h: 10 }, datasource: DS.zabbix,
      description: 'Mean / peak / last value of each metric per interface for the time range; the interface speed (capacity) is its own row, so traffic can be compared with it.',
      targets: [zq('A', IF('Bits (received|sent)')), zq('B', IF('Speed'))],
      transformations: [nice, { id: 'reduce', options: { mode: 'seriesToRows', reducers: ['mean', 'max', 'lastNotNull'], labelsToFields: false } }, { id: 'organize', options: { renameByName: { Field: 'Interface · metric', Mean: 'Mean', Max: 'Peak', 'Last *': 'Last' } } }],
      fieldConfig: { defaults: { unit: 'bps', decimals: 1, noValue: '—', custom: { align: 'left', cellOptions: { type: 'auto' } } }, overrides: [{ matcher: { id: 'byName', options: 'Interface · metric' }, properties: [prop('unit', 'string')] }] },
      options: { showHeader: true, cellHeight: 'sm' } },
    { id: IDS.explorer, type: 'timeseries', title: 'Selected metric — ${metric:text}', gridPos: { x: 0, y: 14, w: 24, h: 9 }, datasource: DS.zabbix,
      description: 'Pick one or more metrics with the Metric selector. Operational status: up = green, down = red.',
      targets: [zq('A', IF('($metric)'))], transformations: [nice],
      fieldConfig: { defaults: { noValue: 'NO DATA — the selected metric is not monitored on these interfaces', custom: { drawStyle: 'line', lineWidth: 1.5, fillOpacity: 8, showPoints: 'never', axisBorderShow: false, spanNulls: false } },
        overrides: [
          byRegex('.*Operational status.*', [prop('unit', 'none'), prop('custom.lineInterpolation', 'stepAfter'), prop('custom.fillOpacity', 0), prop('custom.axisPlacement', 'right'), prop('custom.axisLabel', 'Oper status (1 = up)'), prop('mappings', [{ type: 'value', options: { 1: colour(COLORS.up, 'UP', 0), 2: colour(COLORS.down, 'DOWN', 1) } }, { type: 'range', options: { from: 3, to: 7, result: colour(COLORS.unknown, 'OTHER', 2) } }])]),
          byRegex('.*Bits.*', [prop('unit', 'bps')]), byRegex('.*(errors|discarded).*', [prop('unit', 'pps')])] },
      options: { legend: { displayMode: 'table', placement: 'bottom', showLegend: true, calcs: ['lastNotNull', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } } },
  ];
}

export function buildWan(base) {
  const legacy = base.panels.map((p) => ({ ...p, gridPos: { ...p.gridPos, y: 24 + p.gridPos.y } }));
  return {
    ...base,
    description: `${base.description || ''}\n\nUnified scope (Site / Device type / Device / Interface type / Interface / Direction / Metric). The collapsed row keeps the original fixed WAN link wall unchanged.`.trim(),
    time: { from: 'now-6h', to: 'now' }, graphTooltip: 1, links: navLinks(),
    templating: { list: variables() },
    panels: [...kpis(), ...charts(), { id: IDS.legacyRow, type: 'row', title: 'Original WAN link wall (fixed set of links, not filtered by the selectors)', collapsed: true, gridPos: { x: 0, y: 23, w: 24, h: 1 }, panels: legacy }],
  };
}
