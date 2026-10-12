// NOC - Device Health, enhanced with the unified scope (site / device type / device / metric).
// The ORIGINAL dashboard (uid noc-device-health, its 10 panels, item ids, expressions) is kept as-is in the collapsed row at the bottom; the new
// section above it is driven by the selectors and works for any Zabbix host, including devices added tomorrow.
//
// Device state (from monitoring data only - never from NetFlow):
//   Three DIFFERENT availability sources, decided in this order: ICMP reachability, SNMP availability, Zabbix agent availability.
//   UP            ICMP answers, else SNMP available, else the Zabbix agent answers   (agent = only the agent on the host, NOT its interfaces)
//   DOWN          ICMP failing, else SNMP unavailable, else the agent failing
//   UNKNOWN       nothing decisive and SNMP availability unknown
//   NO DATA       availability items exist and have data in the last 8 days, but none in the last 10 minutes (stale collection; NOT down)
//   NOT MONITORED no availability data at all in the last 8 days (no/disabled ICMP and SNMP availability items)
// "Reachable but no CPU/Memory items" stays UP: CPU/MEM show "-" for that device.
import { PATTERN, CONFIG, TIERS } from '../../reports/lib/item-patterns.mjs';
import { stateOf, NO_ICMP_CODES } from '../../reports/lib/health-report.mjs';
import { DS, COLORS, siteVar, deviceGroupVar, siteHostsVar, deviceVar, customVar, navLinks, DASH_REF } from './scope.mjs';

export const FRESH = '10m';
export const LOOKBACK = '8d';                               // beyond the plugin's 7-day threshold: answered from trends, so it is cheap

const fn = (name, category, ptype, params) => ({ def: { name, category, params: ptype ? [{ name: 'value', type: ptype }] : [], defaultParams: [] }, params, added: false });
const alias = (a) => fn('setAlias', 'Alias', 'string', [a]);
const offset = (n) => fn('offset', 'Transform', 'float', [n]);
const scale = (n) => fn('scale', 'Transform', 'float', [n]);
const zq = (refId, item, aliasName, fns = []) => ({
  refId, datasource: DS.zabbix, queryType: '0', group: { filter: '/.*/' }, host: { filter: '$device' }, application: { filter: '' }, itemTag: { filter: '' },
  item: { filter: item }, functions: [...fns, ...(aliasName ? [alias(aliasName)] : [])], options: { showDisabledItems: false }, resultFormat: 'time_series',
});

const gb = (interval, agg) => ({ def: { name: 'groupBy', category: 'Transform', params: [{ name: 'interval', type: 'string' }, { name: 'function', options: ['avg', 'min', 'max', 'sum', 'count', 'median', 'first', 'last'], type: 'string' }], defaultParams: ['1m', 'avg'] }, params: [interval, agg], added: false });
const PING = PATTERN.icmp, SNMP = PATTERN.snmp, AGENT = PATTERN.agent, CPU = PATTERN.cpu, MEM = PATTERN.memory;
const pct = (extra = {}) => ({ unit: 'percent', decimals: 0, min: 0, max: 100, noValue: '—', thresholds: { mode: 'absolute', steps: [{ color: COLORS.up, value: null }, { color: COLORS.unknown, value: 70 }, { color: COLORS.down, value: 90 }] }, ...extra });
const colour = (c, text, index) => ({ color: c, text, index });
const byName = (name, props) => ({ matcher: { id: 'byName', options: name }, properties: props });
const prop = (id, value) => ({ id, value });
const cell = (type = 'color-background') => prop('custom.cellOptions', { type, mode: 'basic' });

// ---- value mappings ------------------------------------------------------------------------------------------------------------------
const LABEL = { UP: ['UP', COLORS.up], DOWN: ['DOWN', COLORS.down], UNKNOWN: ['UNKNOWN', COLORS.unknown], NO_DATA: ['NO DATA', COLORS.nodata], NOT_MONITORED: ['NOT MONITORED', COLORS.notmon] };
const STATE_IDX = { UP: 1, DOWN: 2, UNKNOWN: 3, NO_DATA: 4, NOT_MONITORED: 5 };
const STATE_MAP = [{ type: 'value', options: Object.fromEntries([0, ...NO_ICMP_CODES].map((c) => { const st = stateOf(c); return [c, colour(LABEL[st][1], LABEL[st][0], STATE_IDX[st])]; })) },
  { type: 'range', options: { from: 1200, to: 1299, result: colour(COLORS.up, 'UP', 0) } }, { type: 'range', options: { from: 1100, to: 1199, result: colour(COLORS.down, 'DOWN', 6) } },
  { type: 'special', options: { match: 'null+nan', result: colour(COLORS.notmon, 'NOT MONITORED', 7) } }];
// filterByValue filters selecting the devices of one state (a state is a set of codes: the ICMP ranges plus the codes of NO_ICMP_CODES)
const stateFilters = (...states) => states.flatMap((st) => [
  ...(st === 'UP' ? [{ id: 'between', options: { from: 1200, to: 1299 } }] : st === 'DOWN' ? [{ id: 'between', options: { from: 1100, to: 1199 } }] : []),
  ...([0, ...NO_ICMP_CODES].filter((c) => stateOf(c) === st).map((c) => ({ id: 'equal', options: { value: c } }))),
]);
const LASTDATA_MAP = [{ type: 'range', options: { from: 1001, to: 2000, result: colour('#5F6B7A', 'within 10 min', 0) } },
  { type: 'value', options: { 1000: colour(COLORS.unknown, 'older than 10 min', 1), 0: colour(COLORS.notmon, 'none in 8 days', 2) } }];
const PING_MAP = [{ type: 'value', options: { 200: colour(COLORS.up, 'UP', 0), 100: colour(COLORS.down, 'DOWN', 1) } }];
const AGENT_MAP = [{ type: 'value', options: { 20: colour(COLORS.up, 'ANSWERS', 0), 10: colour(COLORS.down, 'FAILING', 1) } }];
const SNMP_MAP = [{ type: 'value', options: { 2: colour(COLORS.up, 'OK', 0), 1: colour(COLORS.unknown, 'UNKNOWN', 1), 3: colour(COLORS.down, 'DOWN', 2) } }];

// ---- helper panels (data behind the status table) -------------------------------------------------------------------------------------
const IDS = { inv: 130, fresh: 131, seen: 132, status: 120, attention: 121, timeline: 122, explorer: 123, legacyRow: 124, helperRow: 125 };

function helperPanels(y) {
  const base = { type: 'table', transparent: false, options: { showHeader: true, cellHeight: 'sm' }, fieldConfig: { defaults: { custom: { cellOptions: { type: 'auto' } } }, overrides: [] } };
  return [
    { ...base, id: IDS.inv, title: 'Devices in the selected scope', description: 'The device list is built from the selectors above (Zabbix inventory), so a device with no data at all still appears in the status table.', gridPos: { x: 0, y, w: 6, h: 9 },
      datasource: DS.inventory, targets: [{ refId: 'I', datasource: DS.inventory, scenarioId: 'csv_content', csvContent: '_,${device:csv}\n_,${device:csv}' }],
      transformations: [{ id: 'transpose', options: {} }, { id: 'filterByValue', options: { type: 'exclude', match: 'any', filters: [{ fieldName: 'Field', config: { id: 'equal', options: { value: '_' } } }] } },
        { id: 'organize', options: { renameByName: { Field: 'host' }, includeByName: { Field: true } } }] },
    { ...base, id: IDS.fresh, title: `Latest values (last ${FRESH})`, description: 'ICMP 200=UP 100=DOWN, Zabbix agent 20=answers 10=failing, SNMP 2=OK 1=UNKNOWN 3=DOWN (encoded for the state logic). A device without a sample in the last 10 minutes has no row here.', gridPos: { x: 6, y, w: 10, h: 9 },
      datasource: DS.mixed, timeFrom: FRESH, hideTimeOverride: false,
      targets: [zq('A', PING, 'PING', [offset(1), scale(100)]), zq('B', SNMP, 'SNMP', [offset(1)]), ...TIERS.cpu.map((p, i) => zq(`C${i}`, p, `CPU${i}`)), ...TIERS.memory.map((p, i) => zq(`D${i}`, p, `MEM${i}`)), zq('E', AGENT, 'AGENT', [offset(1), scale(10)])],
      transformations: [{ id: 'reduce', options: { mode: 'seriesToRows', reducers: ['lastNotNull'], labelsToFields: true } },
        { id: 'groupingToMatrix', options: { columnField: 'Field', rowField: 'host', valueField: 'Last *', emptyValue: 'null' } }, { id: 'renameByRegex', options: { regex: '^host.Field$', renamePattern: 'host' } }] },
    { ...base, id: IDS.seen, title: `Availability data seen (last ${LOOKBACK})`, description: '1000 = at least one availability sample (ICMP, SNMP or Zabbix agent) exists in the last 8 days. Separates NO DATA (stale) from NOT MONITORED (never collected / disabled).', gridPos: { x: 16, y, w: 8, h: 9 },
      datasource: DS.mixed, timeFrom: LOOKBACK,
      targets: [zq('A', PING, 'SEEN', [scale(0), offset(1000)]), zq('B', SNMP, 'SEEN', [scale(0), offset(1000)]), zq('C', AGENT, 'SEEN', [scale(0), offset(1000)])],
      transformations: [{ id: 'reduce', options: { mode: 'seriesToRows', reducers: ['lastNotNull'], labelsToFields: true } },
        { id: 'groupBy', options: { fields: { host: { operation: 'groupby' }, 'Last *': { operation: 'aggregate', aggregations: ['max'] } } } }, { id: 'organize', options: { renameByName: { 'Last * (max)': 'SEEN' } } }] },
  ];
}

// ---- the status table and the cards computed from it ------------------------------------------------------------------------------------
function statusTable(y) {
  return {
    id: IDS.status, type: 'table', title: 'Device status', gridPos: { x: 0, y, w: 15, h: 10 }, datasource: DS.dashboard,
    description: 'One row per device in the selected scope. State comes from monitoring data, never from NetFlow traffic, decided by ICMP first, then SNMP availability, then the Zabbix agent (which only shows that the agent on the host answers, not that its interfaces or services are reachable). "—" = no value in the last 10 minutes. A device that is reachable but has no CPU or Memory data stays UP.',
    targets: [{ ...DASH_REF(IDS.inv), refId: 'A' }, { ...DASH_REF(IDS.fresh), refId: 'B' }, { ...DASH_REF(IDS.seen), refId: 'C' }],
    transformations: [
      { id: 'joinByField', options: { byField: 'host', mode: 'outer' } },
      // CPU / memory: one column per configured item name, in precedence order; the first one that has a value is used (a device with a vendor item
      // AND a generic one never shows two values). organize fixes the column order first, then 'first not null' picks the value.
      { id: 'organize', options: { indexByName: Object.fromEntries([...TIERS.cpu.map((_, i) => `CPU${i}`), ...TIERS.memory.map((_, i) => `MEM${i}`)].map((n, i) => [n, 10 + i])) } },
      { id: 'calculateField', options: { mode: 'reduceRow', reduce: { reducer: 'firstNotNull', include: TIERS.cpu.map((_, i) => `CPU${i}`) }, alias: 'CPU', replaceFields: false } },
      { id: 'calculateField', options: { mode: 'reduceRow', reduce: { reducer: 'firstNotNull', include: TIERS.memory.map((_, i) => `MEM${i}`) }, alias: 'MEM', replaceFields: false } },
      { id: 'calculateField', options: { mode: 'reduceRow', reduce: { reducer: 'sum', include: ['PING', 'SNMP', 'AGENT', 'SEEN'] }, alias: 'STATE', replaceFields: false } },
      { id: 'calculateField', options: { mode: 'reduceRow', reduce: { reducer: 'sum', include: ['STATE'] }, alias: 'LAST DATA', replaceFields: false } },
      { id: 'organize', options: { excludeByName: { SEEN: true, ...Object.fromEntries([...TIERS.cpu.map((_, i) => `CPU${i}`), ...TIERS.memory.map((_, i) => `MEM${i}`)].map((n) => [n, true])) }, indexByName: { host: 0, STATE: 1, PING: 2, SNMP: 3, AGENT: 4, CPU: 5, MEM: 6, 'LAST DATA': 7 }, renameByName: { host: 'Device', STATE: 'State', PING: 'ICMP', SNMP: 'SNMP', AGENT: 'Zabbix agent', CPU: 'CPU', MEM: 'Memory', 'LAST DATA': 'Last data' } } },
    ],
    fieldConfig: { defaults: { noValue: '—', custom: { align: 'left', cellOptions: { type: 'auto' } } }, overrides: [
      byName('State', [prop('mappings', STATE_MAP), cell(), prop('custom.width', 150)]),
      byName('ICMP', [prop('mappings', PING_MAP), cell('color-text'), prop('custom.width', 70)]), byName('Zabbix agent', [prop('mappings', AGENT_MAP), cell('color-text'), prop('custom.width', 110)]),
      byName('SNMP', [prop('mappings', SNMP_MAP), cell('color-text'), prop('custom.width', 90)]),
      byName('CPU', [prop('unit', 'percent'), prop('decimals', 0), prop('thresholds', pct().thresholds), prop('color', { mode: 'thresholds' }), cell('color-text'), prop('custom.width', 70)]),
      byName('Memory', [prop('unit', 'percent'), prop('decimals', 0), prop('thresholds', pct().thresholds), prop('color', { mode: 'thresholds' }), cell('color-text'), prop('custom.width', 80)]),
      byName('Last data', [prop('mappings', LASTDATA_MAP), prop('custom.width', 150)]),
    ] },
    options: { showHeader: true, cellHeight: 'sm', sortBy: [{ displayName: 'State', desc: false }] },
  };
}

// "State" and "Last data" are overridden under their renamed names; the table keeps the field called LAST DATA renamed below
const KPIS = [
  { title: 'Devices in scope', filters: null, fixed: COLORS.neutral },
  { title: 'UP', filters: [{ f: 'STATE', c: { id: 'between', options: { from: 1200, to: 1299 } } }, { f: 'STATE', c: { id: 'equal', options: { value: 1002 } } }], fixed: COLORS.up },
  { title: 'DOWN', filters: [{ f: 'STATE', c: { id: 'between', options: { from: 1100, to: 1199 } } }, { f: 'STATE', c: { id: 'equal', options: { value: 1003 } } }], alert: COLORS.down },
  { title: 'UNKNOWN', filters: [{ f: 'STATE', c: { id: 'equal', options: { value: 1001 } } }], alert: COLORS.unknown },
  { title: 'NO DATA', filters: [{ f: 'STATE', c: { id: 'equal', options: { value: 1000 } } }], alert: COLORS.nodata },
  { title: 'NOT MONITORED', filters: [{ f: 'STATE', c: { id: 'equal', options: { value: 0 } } }], alert: COLORS.notmon },
];
const KPI_STATE = { UP: ['UP'], DOWN: ['DOWN'], UNKNOWN: ['UNKNOWN'], 'NO DATA': ['NO_DATA'], 'NOT MONITORED': ['NOT_MONITORED'] };
function kpiPanels(y) {
  for (const k of KPIS) if (KPI_STATE[k.title]) k.filters = stateFilters(...KPI_STATE[k.title]).map((c) => ({ c }));
  return KPIS.map((k, i) => ({
    id: 140 + i, type: 'stat', title: k.title, gridPos: { x: i * 4, y, w: 4, h: 4 }, datasource: DS.dashboard,
    description: { 'Devices in scope': 'Devices selected by Site / Device type / Device (Zabbix inventory).', UP: 'ICMP answered in the last 10 minutes (or, without ICMP, SNMP available, or the Zabbix agent answering - see the Basis in the table).', DOWN: 'ICMP failing in the last 10 minutes (or, without ICMP, SNMP unavailable or the Zabbix agent failing).',
      UNKNOWN: 'Availability reported as unknown by Zabbix.', 'NO DATA': 'Monitored (data in the last 8 days) but no availability sample in the last 10 minutes: stale collection, NOT the same as DOWN.', 'NOT MONITORED': 'No availability data in the last 8 days: add or enable ICMP, SNMP availability or Zabbix agent monitoring in Zabbix.' }[k.title],
    targets: [{ ...DASH_REF(IDS.status), refId: 'A' }],
    transformations: k.filters ? [{ id: 'filterByValue', options: { type: 'include', match: 'any', filters: k.filters.map((x) => ({ fieldName: 'State', config: x.c })) } }] : [],
    fieldConfig: { defaults: { noValue: '0', decimals: 0, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: k.alert ? [{ color: '#8A94A3', value: null }, { color: k.alert, value: 1 }] : [{ color: k.fixed, value: null }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['count'], fields: '/^Device$/' }, colorMode: 'background', graphMode: 'none', textMode: 'value', justifyMode: 'center', text: { valueSize: 34, titleSize: 13 } },
  }));
}

// KPI filters reference the renamed field "State"; the status table's organize step renames STATE -> State, so the same names are used above.
function attentionTable(y) {
  return {
    id: IDS.attention, type: 'table', title: 'Devices requiring attention', gridPos: { x: 0, y, w: 24, h: 6 }, datasource: DS.dashboard,
    description: 'Not UP, SNMP down, or CPU / Memory at or above 90 %. Not monitored and stale devices are listed too: they need an action in Zabbix.',
    targets: [{ ...DASH_REF(IDS.status), refId: 'A' }],
    transformations: [{ id: 'filterByValue', options: { type: 'include', match: 'any', filters: [
      { fieldName: 'State', config: { id: 'equal', options: { value: 0 } } }, { fieldName: 'State', config: { id: 'equal', options: { value: 1000 } } }, { fieldName: 'State', config: { id: 'equal', options: { value: 1001 } } }, { fieldName: 'State', config: { id: 'equal', options: { value: 1003 } } }, { fieldName: 'State', config: { id: 'between', options: { from: 1100, to: 1199 } } }, { fieldName: 'SNMP', config: { id: 'equal', options: { value: 3 } } },
      { fieldName: 'CPU', config: { id: 'greaterOrEqual', options: { value: 90 } } }, { fieldName: 'Memory', config: { id: 'greaterOrEqual', options: { value: 90 } } }] } }],
    fieldConfig: { defaults: { noValue: '—', custom: { align: 'left', cellOptions: { type: 'auto' } } }, overrides: [
      byName('State', [prop('mappings', STATE_MAP), cell(), prop('custom.width', 150)]), byName('ICMP', [prop('mappings', PING_MAP), cell('color-text'), prop('custom.width', 70)]), byName('Zabbix agent', [prop('mappings', AGENT_MAP), cell('color-text'), prop('custom.width', 110)]),
      byName('SNMP', [prop('mappings', SNMP_MAP), cell('color-text'), prop('custom.width', 90)]),
      byName('CPU', [prop('unit', 'percent'), prop('decimals', 0), prop('thresholds', pct().thresholds), prop('color', { mode: 'thresholds' }), cell('color-text')]),
      byName('Memory', [prop('unit', 'percent'), prop('decimals', 0), prop('thresholds', pct().thresholds), prop('color', { mode: 'thresholds' }), cell('color-text')]),
      byName('Last data', [prop('mappings', LASTDATA_MAP)])] },
    options: { showHeader: true, cellHeight: 'sm' },
  };
}

function timeline(y) {
  return {
    id: IDS.timeline, type: 'status-history', title: 'Availability timeline (ICMP)', gridPos: { x: 15, y, w: 9, h: 10 }, datasource: DS.zabbix,
    description: 'ICMP reachability of each selected device over the selected time range. One cell per 10 minutes (DOWN if any ping in it failed). An empty stretch means nothing was collected (a stale or missing collection, NOT the same as DOWN).',
    // one cell per 10 minutes, DOWN when any ping in the cell failed; no cell where nothing was collected (status-history refuses more than a few hundred points)
    targets: [zq('A', PING, null, [gb('10m', 'min')])],
    fieldConfig: { defaults: { displayName: '${__field.labels.host}', noValue: 'NO DATA', color: { mode: 'thresholds' },
      mappings: [{ type: 'range', options: { from: 0.5, to: 1, result: colour(COLORS.up, 'UP', 0) } }, { type: 'range', options: { from: 0, to: 0.4999, result: colour(COLORS.down, 'DOWN', 1) } }], thresholds: { mode: 'absolute', steps: [{ color: COLORS.down, value: null }, { color: COLORS.up, value: 0.5 }] }, custom: { fillOpacity: 90, lineWidth: 0 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.8, colWidth: 1, cellGap: 0, legend: { showLegend: false }, tooltip: { mode: 'single' } },
  };
}

function explorer(y) {
  return {
    id: IDS.explorer, type: 'timeseries', title: 'Metric explorer - ${metric}', gridPos: { x: 0, y, w: 24, h: 10 }, datasource: DS.zabbix,
    description: 'Choose one or several metrics with the Metric selector; every selected device is drawn so devices can be compared.',
    targets: [{ ...zq('A', '/$metric/', null), item: { filter: '/$metric/' } }],
    fieldConfig: { defaults: { displayName: '${__field.labels.host} · ${__field.labels.item}', unit: 'percent', min: 0, max: 100, noValue: 'NO DATA for the selected devices and metric',
      custom: { drawStyle: 'line', lineWidth: 1.5, fillOpacity: 0, showPoints: 'never', spanNulls: false, axisBorderShow: false } },
    overrides: [{ matcher: { id: 'byRegexp', options: '.*(ICMP|agent) ping.*' }, properties: [prop('unit', 'none'), prop('max', 1), prop('custom.lineInterpolation', 'stepAfter'), prop('custom.axisPlacement', 'right'), prop('custom.axisLabel', 'Availability (1 = UP)'),
      prop('mappings', [{ type: 'value', options: { 1: colour(COLORS.up, 'UP', 0), 0: colour(COLORS.down, 'DOWN', 1) } }])] }] },
    options: { legend: { displayMode: 'table', placement: 'bottom', showLegend: true, calcs: ['lastNotNull', 'mean', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

// ---- assembly --------------------------------------------------------------------------------------------------------------------------
// one explorer option per configured CPU / memory item name (config/monitoring-items.json), plus the availability items
const METRIC_OPTIONS = [
  ...CONFIG.cpu.names.map((n, i) => [i ? `CPU - ${n}` : 'CPU', n]), ...CONFIG.memory.names.map((n, i) => [i ? `Memory - ${n}` : 'Memory', n]),
  ...CONFIG.availability.icmp.map((n) => ['Availability (ICMP)', n]), ...CONFIG.availability.agent.map((n) => ['Availability (Zabbix agent)', n]),
];
// devices requiring attention: any state except UP, SNMP down, CPU / memory at or above 90 %
const attentionFilters = () => [
  ...stateFilters('DOWN', 'UNKNOWN', 'NO_DATA', 'NOT_MONITORED').map((config) => ({ fieldName: 'State', config })),
  { fieldName: 'SNMP', config: { id: 'equal', options: { value: 3 } } }, { fieldName: 'CPU', config: { id: 'greaterOrEqual', options: { value: 90 } } }, { fieldName: 'Memory', config: { id: 'greaterOrEqual', options: { value: 90 } } },
];
export function buildDeviceHealth(base) {
  const legacy = base.panels.map((p) => ({ ...p, gridPos: { ...p.gridPos, y: 31 + p.gridPos.y } }));
  const metric = customVar('metric', 'Metric', 'CPU, Memory and/or Availability for the metric explorer. Only metrics that are monitored on the selected devices return data.',
    METRIC_OPTIONS, { multi: true, current: METRIC_OPTIONS.filter(([t]) => t.startsWith('CPU')).map(([text, value]) => ({ text, value })) });
  const panels = [
    ...kpiPanels(0), statusTable(4), timeline(4), { ...attentionTable(14), transformations: [{ id: 'filterByValue', options: { type: 'include', match: 'any', filters: attentionFilters() } }] }, explorer(20),
    { id: IDS.legacyRow, type: 'row', title: 'Original router wall (fixed set of routers, not filtered by the selectors)', collapsed: true, gridPos: { x: 0, y: 30, w: 24, h: 1 }, panels: legacy },
    // the three tables the status table is built from; collapsed so they stay out of the way (Grafana still runs them for the panels that read them)
    { id: IDS.helperRow, type: 'row', title: 'Data behind the status table (do not edit)', collapsed: true, gridPos: { x: 0, y: 31, w: 24, h: 1 }, panels: helperPanels(32) },
  ];
  return {
    ...base,
    description: `${base.description}\n\nUnified scope (Site / Device type / Device / Metric): the section above the collapsed row follows the selectors; the collapsed row keeps the original fixed router wall unchanged.`,
    time: { from: 'now-6h', to: 'now' }, graphTooltip: 1, links: navLinks(),
    templating: { list: [siteVar(), deviceGroupVar(), siteHostsVar(), deviceVar(), metric] },
    panels,
  };
}
