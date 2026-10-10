// Generates the five NetFlow NOC dashboards (dashboards/netflow/*.json).  Run from the repository root: node tools/netflow/generate.mjs
// The committed JSON is the deployed state; this generator reproduces it (checked by tests/check-generator.sh). Edit here, regenerate, run scripts/apply.mjs.
//
// Design rules
//  * Aggregates read the Akvorado rollups (flows_1m0s / 5m0s / 1h0m0s) picked from the time range.
//  * Raw `flows` only for what rollups do not keep (IPs, ports, conversations, flow counts, exact
//    last-flow age) and ALWAYS capped to the last 24 h.
//  * Neutral colours for traffic; semantic colours (green/amber/red/grey) only for health/status.
//  * An exporter is never "DOWN" from NetFlow alone: no recent flows = IDLE / NO RECENT FLOWS.
import { writeFileSync, mkdirSync } from 'node:fs';

const DS = { type: 'grafana-clickhouse-datasource', uid: 'netflow-clickhouse' };
const DEMO = "toIPv6('::ffff:247.16.14.11')";
const g = (s) => s.replaceAll('@{', '${').replace(/\s+\n/g, '\n');

// ---------------------------------------------------------------- SQL fragments
const SC = `(('@{scope}'='real' AND ExporterAddress != ${DEMO}) OR ('@{scope}'='demo' AND ExporterAddress = ${DEMO}) OR '@{scope}'='all')`;
const REAL = `ExporterAddress != ${DEMO}`;
const EX = `has([@{exporter:singlequote}], ExporterName)`;
const IF = `(has([@{iface:singlequote}], InIfName) OR has([@{iface:singlequote}], OutIfName))`;
const DIRC = `multiIf(InIfBoundary = 'external' AND OutIfBoundary != 'external', 'inbound', OutIfBoundary = 'external' AND InIfBoundary != 'external', 'outbound', InIfBoundary = 'external' AND OutIfBoundary = 'external', 'transit', 'unclassified')`;
const DIRL = `multiIf(InIfBoundary = 'external' AND OutIfBoundary != 'external', 'External → Internal', OutIfBoundary = 'external' AND InIfBoundary != 'external', 'Internal → External', InIfBoundary = 'external' AND OutIfBoundary = 'external', 'External → External', 'Unclassified')`;
const DR = `('@{direction}'='all' OR ${DIRC}='@{direction}')`;
const PR = `('@{proto}'='all' OR Proto = toUInt32OrZero('@{proto}'))`;
const F = [SC, EX, IF, DR, PR].join(' AND ');
const FX = [SC, EX, DR, PR].join(' AND '); // without interface filter (interface table)
const TF = `$__timeFilter(TimeReceived)`;
const RAWT = `TimeReceived >= greatest($__fromTime, now() - INTERVAL 24 HOUR) AND TimeReceived <= $__toTime`;
const RNG = `greatest(1, toUnixTimestamp($__toTime) - toUnixTimestamp($__fromTime))`;
const RAWRNG = `greatest(1, toUnixTimestamp($__toTime) - toUnixTimestamp(greatest($__fromTime, now() - INTERVAL 24 HOUR)))`;
const RES = `default.@{res}`;
const BK = `greatest(@{res_s}, $__interval_s)`;
const BUCKET = `toStartOfInterval(TimeReceived, INTERVAL ${BK} SECOND)`;
const BYTES = `sum(Bytes*SamplingRate)`;
const BPS = `${BYTES}*8/${BK}`;
const ip = (c) => `replaceRegexpOne(IPv6NumToString(${c}), '^::ffff:', '')`;
const SRCIP = `('@{src_ip}'='' OR ${ip('SrcAddr')}='@{src_ip}')`;
const DSTIP = `('@{dst_ip}'='' OR ${ip('DstAddr')}='@{dst_ip}')`;
const PNAME = `multiIf(Proto=6,'TCP',Proto=17,'UDP',Proto=1,'ICMP',concat('proto ',toString(Proto)))`;
const PORTS = [22, 23, 25, 53, 67, 80, 110, 123, 143, 161, 162, 179, 389, 443, 445, 514, 993, 995, 1194, 3306, 3389, 5001, 5060, 8080, 8443];
const SVC = ['SSH', 'Telnet', 'SMTP', 'DNS', 'DHCP', 'HTTP', 'POP3', 'NTP', 'IMAP', 'SNMP', 'SNMP trap', 'BGP', 'LDAP', 'HTTPS', 'SMB', 'Syslog', 'IMAPS', 'POP3S', 'OpenVPN', 'MySQL', 'RDP', 'iperf', 'SIP', 'HTTP-alt', 'HTTPS-alt'];
const svcName = (p) => `transform(${p}, [${PORTS.join(',')}], [${SVC.map((s) => `'${s}'`).join(',')}], '')`;
const appLabel = (p) => `concat(${PNAME}, '/', toString(${p}), if(${svcName(p)} = '', '', concat(' (', ${svcName(p)}, ')')))`;
// ASN label: never blank, lab/private ranges named honestly
const asn = (c) => `multiIf(${c} = 0, 'Private / Unknown ASN', ${c} BETWEEN 64496 AND 64511, concat('AS', toString(${c}), ' (lab / documentation)'), ${c} BETWEEN 64512 AND 65534, concat('AS', toString(${c}), ' (private)'), ${c} BETWEEN 4200000000 AND 4294967294, concat('AS', toString(${c}), ' (private)'), concat('AS', toString(${c})))`;
const ISPUB = (c) => `(${c} != 0 AND NOT (${c} BETWEEN 64496 AND 65534) AND NOT (${c} BETWEEN 4200000000 AND 4294967294))`;

// ---------------------------------------------------------------- panel helpers
let nid = 1;
const NEUTRAL = '#6E8CAE';
const target = (sql, format) => ({ refId: 'A', datasource: DS, editorType: 'sql', format, rawSql: g(sql) });
const base = (type, title, grid, sql, format, extra = {}) => ({ id: nid++, type, title, datasource: DS, gridPos: grid, targets: [target(sql, format)], ...extra });
const G = (x, y, w, h) => ({ x, y, w, h });
const FMT_TS = 0, FMT_TABLE = 1;
const col = (name, props) => ({ matcher: { id: 'byName', options: name }, properties: props });
const unit = (name, u, dec) => col(name, [{ id: 'unit', value: u }, ...(dec !== undefined ? [{ id: 'decimals', value: dec }] : [])]);
const share = (name = 'Share') => col(name, [{ id: 'unit', value: 'percent' }, { id: 'decimals', value: 1 }, { id: 'min', value: 0 }, { id: 'max', value: 100 },
  { id: 'custom.cellOptions', value: { type: 'gauge', mode: 'basic', valueDisplayMode: 'text' } }, { id: 'color', value: { mode: 'fixed', fixedColor: NEUTRAL } }, { id: 'custom.width', value: 150 }]);
const width = (name, w) => col(name, [{ id: 'custom.width', value: w }]);
const STATUS_MAP = { ACTIVE: { color: 'green', text: 'ACTIVE', index: 0 }, 'IDLE / NO RECENT FLOWS': { color: 'orange', text: 'IDLE / NO RECENT FLOWS', index: 1 }, UNKNOWN: { color: 'gray', text: 'UNKNOWN', index: 2 } };
const statusCol = (name = 'Status') => col(name, [{ id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: [{ type: 'value', options: STATUS_MAP }] }, { id: 'custom.width', value: 170 }]);

const KPI_TEXT = { titleSize: 11, valueSize: 26 };
const stat = (title, grid, sql, u, o = {}) => base('stat', title, grid, sql, FMT_TABLE, {
  description: o.description,
  fieldConfig: { defaults: { unit: u, decimals: o.decimals, mappings: o.mappings || [], color: { mode: o.steps ? 'thresholds' : 'fixed', fixedColor: o.fixed || '#C7D0DC' },
    thresholds: { mode: 'absolute', steps: o.steps || [{ color: 'blue', value: null }] }, noValue: o.noValue || '—' }, overrides: [] },
  options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' }, colorMode: o.colorMode || 'value', graphMode: o.graph ? 'area' : 'none',
    justifyMode: 'center', textMode: o.textMode || 'auto', orientation: 'auto', text: o.text || KPI_TEXT },
});

const ts = (title, grid, sql, u, o = {}) => base('timeseries', title, grid, sql, FMT_TS, {
  description: o.description,
  fieldConfig: { defaults: { unit: u, min: 0, decimals: o.decimals ?? 1, color: { mode: o.colors ? 'palette-classic' : 'continuous-BlPu' },
    custom: { drawStyle: 'line', lineWidth: 1.5, fillOpacity: o.fill ?? 18, showPoints: 'never', spanNulls: false, axisBorderShow: false, stacking: { mode: o.stack ? 'normal' : 'none', group: 'A' } },
    noValue: o.noValue || 'No data in the selected range' }, overrides: o.overrides || [] },
  options: { legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'mean', 'max'], showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
});

const table = (title, grid, sql, overrides = [], o = {}) => base('table', title, grid, sql, FMT_TABLE, {
  description: o.description,
  fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: false, inspect: false }, noValue: o.noValue || 'No data', links: [] }, overrides },
  options: { showHeader: true, cellHeight: 'sm', footer: { show: false }, sortBy: o.sortBy || [] },
});

const text = (title, grid, md) => ({ id: nid++, type: 'text', title, gridPos: grid, options: { mode: 'markdown', content: md } });

// small status/notice strips
const rawNotice = (grid) => stat('Detail window', grid,
  `SELECT toUInt8(toUnixTimestamp($__toTime) - toUnixTimestamp($__fromTime) > 86400) AS over24`, 'none', {
  description: 'IP, port, conversation and flow-count panels read raw flow records, which are always limited to the latest 24 hours.',
  colorMode: 'none', textMode: 'value', text: { valueSize: 12 },
  mappings: [{ type: 'value', options: {
    0: { text: 'IP / port / conversation detail covers the selected range (raw data is kept for 24 h).', color: '#8F9BAA', index: 0 },
    1: { text: '⚠ Detailed IP / Port / Conversation data is limited to the latest 24 hours (selected range is longer).', color: 'orange', index: 1 } } }],
  noValue: '' });

const statusKPI = (grid) => stat('STATUS', grid,
  `SELECT multiIf(active > 0, 2, known > 0, 1, 0) AS s FROM (
     SELECT uniqExactIf(ExporterAddress, TimeReceived > now() - INTERVAL 5 MINUTE AND ${SC}) AS active, uniqExactIf(ExporterAddress, ${SC}) AS known
     FROM default.flows_1m0s WHERE TimeReceived > now() - INTERVAL 24 HOUR)`, 'none', {
  description: 'REAL DATA = at least one real exporter sent flows in the last 5 minutes. IDLE = real exporters known, but no recent flows (not proof of failure). NO REAL EXPORTER DATA = nothing from a real exporter in 24 h.',
  colorMode: 'background', textMode: 'value', text: { valueSize: 18, titleSize: 11 },
  mappings: [{ type: 'value', options: {
    2: { text: 'REAL DATA', color: 'green', index: 0 }, 1: { text: 'IDLE / NO RECENT FLOWS', color: 'orange', index: 1 }, 0: { text: 'NO REAL EXPORTER DATA', color: 'red', index: 2 } } }],
  steps: [{ color: 'red', value: null }], noValue: 'NO REAL EXPORTER DATA' });

const activeExp = (grid) => stat('ACTIVE EXPORTERS', grid,
  `SELECT concat(toString(uniqExactIf(ExporterAddress, TimeReceived > now() - INTERVAL 5 MINUTE)), ' / ', toString(uniqExact(ExporterAddress))) AS v
   FROM default.flows_1m0s WHERE TimeReceived > now() - INTERVAL 7 DAY AND ${SC}`, 'none', {
  description: 'Exporters that sent flows in the last 5 minutes / exporters seen in the last 7 days.', textMode: 'value', noValue: '0 / 0' });

const flowAge = (grid, title = 'LAST REAL FLOW') => stat(title, grid,
  `SELECT dateDiff('second', max(TimeReceived), now()) AS age FROM default.flows WHERE TimeReceived > now() - INTERVAL 24 HOUR AND ${SC}`, 's', {
  description: 'Seconds since the newest flow record (raw table, last 24 h, same data scope as every other panel).',
  decimals: 0, steps: [{ color: 'green', value: null }, { color: 'orange', value: 300 }, { color: 'red', value: 3600 }], noValue: 'none in 24 h' });

// exporter summary: status never DOWN from traffic alone
const exporterSummary = (grid, o = {}) => table(o.title || 'Exporters', grid,
  `SELECT r.exporter AS Exporter,
          multiIf(isNull(r.age), 'UNKNOWN', ifNull(x.age, r.age) <= 300, 'ACTIVE', 'IDLE / NO RECENT FLOWS') AS Status,
          ifNull(x.bps, 0) AS Traffic, ifNull(x.fps, 0) AS \`Flows/s\`, ifNull(x.age, r.age) AS \`Last flow\`
   FROM (SELECT ExporterName AS exporter, dateDiff('second', max(TimeReceived), now()) AS age FROM default.flows_1m0s
         WHERE TimeReceived > now() - INTERVAL 7 DAY AND ${SC} GROUP BY exporter) AS r
   LEFT JOIN (SELECT ExporterName AS exporter, ${BYTES}*8/300 AS bps, count()/300 AS fps, dateDiff('second', max(TimeReceived), now()) AS age
              FROM default.flows WHERE TimeReceived > now() - INTERVAL 5 MINUTE AND ${SC} GROUP BY exporter) AS x ON r.exporter = x.exporter
   ORDER BY \`Last flow\``,
  [statusCol(), unit('Traffic', 'bps', 1), unit('Flows/s', 'none', 2), unit('Last flow', 's', 0), width('Exporter', 110)],
  { description: 'ACTIVE: flows in the last 5 min. IDLE / NO RECENT FLOWS: seen in the last 7 days but quiet — this is not proof of failure (NetFlow alone cannot prove a router is down). Traffic and flows/s are 5-minute averages.',
    noValue: 'No exporter has sent flows in the last 7 days (for the selected data scope)' });

// top-N list with share of total
const topIP = (title, grid, col_, net, filter, linkVar) => table(title, grid,
  `SELECT ipaddr AS IP, nm AS Network, round(bytes*8/${RAWRNG}) AS Traffic, round(100*bytes/sum(bytes) OVER (), 1) AS Share FROM (
     SELECT ${ip(col_)} AS ipaddr, if(any(${net}) = '', '—', any(${net})) AS nm, ${BYTES} AS bytes
     FROM default.flows WHERE ${RAWT} AND ${F} AND ${SRCIP} AND ${DSTIP} GROUP BY ipaddr)
   ORDER BY bytes DESC LIMIT ${filter}`,
  [unit('Traffic', 'bps', 1), share(), width('IP', 150), width('Network', 90), col('IP', [{ id: 'links', value: [{ title: 'Filter this dashboard on this IP', url: `/d/netflow-top-talkers?\${__url_time_range}&\${__all_variables}&var-${linkVar}=\${__value.raw}` }] }])],
  { noValue: 'No flows in the selected scope (raw data: latest 24 h)', description: 'Average rate over the selected range (max 24 h). Network = name from Akvorado network definitions, "—" if not defined. Click an IP to filter Top Talkers.' });

const topASN = (title, grid, c, limit) => table(title, grid,
  `SELECT label AS ASN, round(bytes*8/${RNG}) AS Traffic, round(100*bytes/sum(bytes) OVER (), 1) AS Share FROM (
     SELECT ${asn(c)} AS label, ${BYTES} AS bytes FROM ${RES} WHERE ${TF} AND ${F} GROUP BY label)
   ORDER BY bytes DESC LIMIT ${limit}`,
  [unit('Traffic', 'bps', 1), share()], { noValue: 'No traffic in the selected scope',
    description: 'Private / Unknown ASN = no ASN available (private or unrouted address). AS64496–64511 are documentation ASNs used by the lab. Organization names are not part of the enrichment data.' });

const topConv = (title, grid, limit) => table(title, grid,
  `SELECT conv AS Conversation, app AS Service, round(bytes*8/${RAWRNG}) AS Traffic, round(100*bytes/sum(bytes) OVER (), 1) AS Share FROM (
     SELECT concat(${ip('SrcAddr')}, ' → ', ${ip('DstAddr')}) AS conv, ${appLabel('DstPort')} AS app, ${BYTES} AS bytes
     FROM default.flows WHERE ${RAWT} AND ${F} AND ${SRCIP} AND ${DSTIP} GROUP BY conv, app)
   ORDER BY bytes DESC LIMIT ${limit}`,
  [unit('Traffic', 'bps', 1), share(), width('Service', 130)], { noValue: 'No conversation data in the selected range (raw data: latest 24 h)',
    description: 'Source → destination, protocol/destination port. Average rate over the selected range (max 24 h).' });

const topApps = (title, grid, limit) => table(title, grid,
  `SELECT app AS Application, round(bytes*8/${RAWRNG}) AS Traffic, round(100*bytes/sum(bytes) OVER (), 1) AS Share FROM (
     SELECT ${appLabel('DstPort')} AS app, ${BYTES} AS bytes FROM default.flows
     WHERE ${RAWT} AND ${F} AND ${SRCIP} AND ${DSTIP} AND DstPort > 0 GROUP BY app)
   ORDER BY bytes DESC LIMIT ${limit}`,
  [unit('Traffic', 'bps', 1), share()], { noValue: 'No TCP/UDP flows in the selected scope (raw data: latest 24 h)',
    description: 'Destination protocol/port with well-known service names.' });

const protoMix = (title, grid) => table(title, grid,
  `SELECT arr.1 AS Protocol, round(arr.2*8/${RNG}) AS Traffic, round(100*arr.2/greatest(1, t + u + i + o), 1) AS Share FROM (
     SELECT sumIf(b, c = 'TCP') AS t, sumIf(b, c = 'UDP') AS u, sumIf(b, c = 'ICMP') AS i, sumIf(b, c = 'Other') AS o FROM (
       SELECT multiIf(Proto = 6, 'TCP', Proto = 17, 'UDP', Proto = 1, 'ICMP', 'Other') AS c, ${BYTES} AS b FROM ${RES} WHERE ${TF} AND ${F} GROUP BY c))
   ARRAY JOIN [('TCP', t), ('UDP', u), ('ICMP', i), ('Other', o)] AS arr`,
  [unit('Traffic', 'bps', 1), share()], { noValue: 'No traffic in the selected scope' });

// ---------------------------------------------------------------- variables
const custom = (name, label, query, def, desc) => ({ type: 'custom', name, label, query, description: desc, hide: 0,
  current: { text: def[0], value: def[1], selected: true }, options: query.split(',').map((o) => { const [t, v] = o.split(' : ').map((s) => s.trim()); return { text: t, value: v, selected: v === def[1] }; }) });
const qvar = (name, label, sql) => ({ type: 'query', name, label, datasource: DS, query: g(sql), definition: g(sql), refresh: 2, sort: 1, multi: true, includeAll: true, current: { text: 'All', value: '$__all', selected: true }, hide: 0 });
const hidden = (name, sql) => ({ type: 'query', name, datasource: DS, query: g(sql), definition: g(sql), refresh: 2, hide: 2, multi: false, includeAll: false, current: {}, options: [] });
const V = {
  scope: custom('scope', 'Data scope', 'Real only : real,Demo only : demo,Real + demo : all', ['Real only', 'real'], 'Real = synthetic demo exporter excluded (default).'),
  exporter: qvar('exporter', 'Exporter', `SELECT DISTINCT ExporterName FROM default.flows_1h0m0s WHERE TimeReceived > now() - INTERVAL 30 DAY AND ${SC} ORDER BY 1`),
  iface: qvar('iface', 'Interface', `SELECT DISTINCT InIfName FROM default.flows_1h0m0s WHERE InIfName != '' AND TimeReceived > now() - INTERVAL 30 DAY AND ${SC} AND ${EX} UNION DISTINCT SELECT DISTINCT OutIfName FROM default.flows_1h0m0s WHERE OutIfName != '' AND TimeReceived > now() - INTERVAL 30 DAY AND ${SC} AND ${EX} ORDER BY 1`),
  direction: custom('direction', 'Direction', 'All : all,External → Internal : inbound,Internal → External : outbound,External → External : transit,Unclassified : unclassified', ['All', 'all'], 'Derived from verified interface boundary metadata; never guessed.'),
  proto: custom('proto', 'Protocol', 'All : all,TCP : 6,UDP : 17,ICMP : 1', ['All', 'all']),
  src_ip: { type: 'textbox', name: 'src_ip', label: 'Source IP', query: '', current: { text: '', value: '' }, options: [{ text: '', value: '', selected: true }], hide: 0 },
  dst_ip: { type: 'textbox', name: 'dst_ip', label: 'Dest IP', query: '', current: { text: '', value: '' }, options: [{ text: '', value: '', selected: true }], hide: 0 },
  res: hidden('res', `SELECT multiIf(@{__to:raw} - @{__from:raw} <= 43200000, 'flows_1m0s', @{__to:raw} - @{__from:raw} <= 604800000, 'flows_5m0s', 'flows_1h0m0s')`),
  res_s: hidden('res_s', `SELECT multiIf(@{__to:raw} - @{__from:raw} <= 43200000, 60, @{__to:raw} - @{__from:raw} <= 604800000, 300, 3600)`),
};
const std = [V.scope, V.exporter, V.iface, V.direction, V.proto];
const stdH = [V.res, V.res_s];

const dashboards = [];
function dash(uid, title, refresh, from, vars, panels, description) {
  dashboards.push({ uid, d: { uid, title, description, tags: ['netflow', 'netops'], timezone: 'browser', editable: true, graphTooltip: 1, schemaVersion: 39, version: 1,
    refresh, time: { from, to: 'now' }, timepicker: { refresh_intervals: ['30s', '1m', '5m', '15m'] }, templating: { list: vars }, annotations: { list: [] }, panels,
    links: [{ type: 'dashboards', title: 'NetFlow', tags: ['netflow'], asDropdown: false, includeVars: true, keepTime: true, icon: 'external link' }] } });
}
const DIR_OVERRIDES = [
  col('External → Internal', [{ id: 'color', value: { mode: 'fixed', fixedColor: '#5B9BD5' } }]),
  col('Internal → External', [{ id: 'color', value: { mode: 'fixed', fixedColor: '#A78BDA' } }]),
  col('External → External', [{ id: 'color', value: { mode: 'fixed', fixedColor: '#7F8C9A' } }]),
  col('Unclassified', [{ id: 'color', value: { mode: 'fixed', fixedColor: '#4F5B6B' } }]),
];
const dirSeries = (title, grid, desc) => ts(title, grid,
  `SELECT ${BUCKET} AS time, ${DIRL} AS direction, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} GROUP BY time, direction ORDER BY time`, 'bps',
  { stack: false, overrides: DIR_OVERRIDES, fill: 22, description: desc || 'Direction is derived from verified interface boundary metadata: External → Internal = enters through an external interface. "Unclassified" = neither side is marked external. Nothing is guessed.' });

// ================================================================= 1. NOC Overview
nid = 1;
dash('netflow-overview', 'NetFlow | NOC Overview', '30s', 'now-6h', [...std, ...stdH], [
  statusKPI(G(0, 0, 4, 3)), activeExp(G(4, 0, 4, 3)),
  stat('CURRENT TRAFFIC', G(8, 0, 4, 3), `SELECT ${BYTES}*8/300 AS bps FROM default.flows_1m0s WHERE TimeReceived > now() - INTERVAL 5 MINUTE AND ${F}`, 'bps', { decimals: 1, description: '5-minute average.', noValue: '0 bps' }),
  stat('PEAK TRAFFIC', G(12, 0, 4, 3), `SELECT max(bps) FROM (SELECT ${BUCKET} AS t, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} GROUP BY t)`, 'bps', { decimals: 1, description: 'Highest rate in the selected range.', noValue: '0 bps' }),
  stat('FLOW RATE', G(16, 0, 4, 3), `SELECT count()/300 AS fps FROM default.flows WHERE TimeReceived > now() - INTERVAL 5 MINUTE AND ${F}`, 'suffix: flows/s', { description: 'Flow records received per second (5-minute average).', noValue: '0 flows/s' }),
  flowAge(G(20, 0, 4, 3)),
  dirSeries('Traffic by direction', G(0, 3, 16, 8)),
  exporterSummary(G(16, 3, 8, 8)),
  topIP('Top source IPs', G(0, 11, 8, 7), 'SrcAddr', 'SrcNetName', 6, 'src_ip'),
  topIP('Top destination IPs', G(8, 11, 8, 7), 'DstAddr', 'DstNetName', 6, 'dst_ip'),
  topConv('Top conversations', G(16, 11, 8, 7), 6),
  topASN('Top source ASN', G(0, 18, 6, 6), 'SrcAS', 5),
  topASN('Top destination ASN', G(6, 18, 6, 6), 'DstAS', 5),
  topApps('Top applications / ports', G(12, 18, 6, 6), 5),
  protoMix('Protocol mix', G(18, 18, 6, 6)),
  rawNotice(G(0, 24, 24, 1)),
], 'Ten-second operational overview. Real traffic only by default.');

// ================================================================= 2. Top Talkers
nid = 1;
dash('netflow-top-talkers', 'NetFlow | Top Talkers', '1m', 'now-1h', [...std, V.src_ip, V.dst_ip, ...stdH], [
  stat('TOTAL TRAFFIC', G(0, 0, 4, 3), `SELECT ${BYTES}*8/${RNG} AS bps FROM ${RES} WHERE ${TF} AND ${F}`, 'bps', { decimals: 1, description: 'Average over the selected range.', noValue: '0 bps' }),
  stat('TOTAL DATA', G(4, 0, 4, 3), `SELECT ${BYTES} FROM ${RES} WHERE ${TF} AND ${F}`, 'bytes', { decimals: 1, noValue: '0 B' }),
  stat('PACKETS', G(8, 0, 4, 3), `SELECT sum(Packets*SamplingRate) FROM ${RES} WHERE ${TF} AND ${F}`, 'short', { decimals: 1, noValue: '0' }),
  stat('FLOW RECORDS (≤24 h)', G(12, 0, 4, 3), `SELECT count() FROM default.flows WHERE ${RAWT} AND ${F} AND ${SRCIP} AND ${DSTIP}`, 'short', { noValue: '0' }),
  statusKPI(G(16, 0, 4, 3)), flowAge(G(20, 0, 4, 3)),
  topIP('Top source IPs', G(0, 3, 8, 8), 'SrcAddr', 'SrcNetName', 8, 'src_ip'),
  topIP('Top destination IPs', G(8, 3, 8, 8), 'DstAddr', 'DstNetName', 8, 'dst_ip'),
  topApps('Top applications / ports', G(16, 3, 8, 8), 8),
  topConv('Top conversations', G(0, 11, 16, 9), 12),
  protoMix('Protocol mix', G(16, 11, 8, 5)),
  table('Top source ports', G(16, 16, 8, 4),
    `SELECT app AS Port, round(bytes*8/${RAWRNG}) AS Traffic, round(100*bytes/sum(bytes) OVER (), 1) AS Share FROM (
       SELECT concat(${PNAME}, '/', toString(SrcPort)) AS app, ${BYTES} AS bytes FROM default.flows WHERE ${RAWT} AND ${F} AND ${SRCIP} AND ${DSTIP} AND SrcPort > 0 GROUP BY app)
     ORDER BY bytes DESC LIMIT 3`, [unit('Traffic', 'bps', 1), share()], { noValue: 'No TCP/UDP flows in the selected scope' }),
  rawNotice(G(0, 20, 24, 1)),
], 'Top IPs, conversations, applications and protocols. Raw-flow panels are capped to the latest 24 h. Use the Source/Dest IP variables (or click an IP) to investigate one host.');

// ================================================================= 3. ASN & Internet
nid = 1;
dash('netflow-asn', 'NetFlow | ASN & Internet', '1m', 'now-24h', [...std, ...stdH], [
  statusKPI(G(0, 0, 6, 3)),
  stat('SOURCE ASNs', G(6, 0, 6, 3), `SELECT uniqExact(SrcAS) FROM ${RES} WHERE ${TF} AND ${F}`, 'short', { description: 'Distinct source ASNs (0 = unknown counts as one).', noValue: '0' }),
  stat('DESTINATION ASNs', G(12, 0, 6, 3), `SELECT uniqExact(DstAS) FROM ${RES} WHERE ${TF} AND ${F}`, 'short', { noValue: '0' }),
  stat('PUBLIC-ASN TRAFFIC', G(18, 0, 6, 3),
    `SELECT round(100 * sumIf(Bytes*SamplingRate, ${ISPUB('SrcAS')} OR ${ISPUB('DstAS')}) / greatest(1, ${BYTES}), 1) FROM ${RES} WHERE ${TF} AND ${F}`, 'percent',
    { decimals: 1, description: 'Share of traffic with a public (non-private, non-lab) ASN on either side. 0 % is expected for the private lab.', noValue: '0 %' }),
  ts('Traffic by destination ASN (top 6)', G(0, 3, 12, 8),
    `WITH top AS (SELECT DstAS FROM ${RES} WHERE ${TF} AND ${F} GROUP BY DstAS ORDER BY ${BYTES} DESC LIMIT 6)
     SELECT ${BUCKET} AS time, ${asn('DstAS')} AS asn, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} AND DstAS IN (SELECT DstAS FROM top) GROUP BY time, asn ORDER BY time`, 'bps', { stack: true }),
  ts('Traffic by source ASN (top 6)', G(12, 3, 12, 8),
    `WITH top AS (SELECT SrcAS FROM ${RES} WHERE ${TF} AND ${F} GROUP BY SrcAS ORDER BY ${BYTES} DESC LIMIT 6)
     SELECT ${BUCKET} AS time, ${asn('SrcAS')} AS asn, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} AND SrcAS IN (SELECT SrcAS FROM top) GROUP BY time, asn ORDER BY time`, 'bps', { stack: true }),
  topASN('Top source ASN', G(0, 11, 8, 8), 'SrcAS', 8),
  topASN('Top destination ASN', G(8, 11, 8, 8), 'DstAS', 8),
  dirSeries('External vs internal', G(16, 11, 8, 8)),
  table('Provider / peer classification', G(0, 19, 12, 4),
    `SELECT InIfProvider AS Provider, InIfConnectivity AS Type, ExporterName AS Exporter, round(${BYTES}*8/${RNG}) AS Traffic FROM ${RES}
     WHERE ${TF} AND ${F} AND InIfProvider != '' GROUP BY Provider, Type, Exporter ORDER BY Traffic DESC LIMIT 6`,
    [unit('Traffic', 'bps', 1)], { noValue: 'Provider classification pending — appears when interfaces carry provider metadata.' }),
  table('Top destination countries', G(12, 19, 12, 4),
    `SELECT replaceAll(toString(DstCountry), '\\0', '') AS Country, round(${BYTES}*8/${RNG}) AS Traffic FROM ${RES}
     WHERE ${TF} AND ${F} AND DstCountry != '' GROUP BY Country HAVING Country != '' ORDER BY Traffic DESC LIMIT 5`,
    [unit('Traffic', 'bps', 1)], { noValue: 'No public destinations in the current scope (private lab addresses have no GeoIP).' }),
], 'ASN, boundary and provider visibility. Provider and organization data are shown only when they exist in the data; nothing is inferred.');

// ================================================================= 4. Exporters & Interfaces
nid = 1;
const ifaceRow = (side) => {
  const n = side === 'in' ? 'InIfName' : 'OutIfName', b = side === 'in' ? 'InIfBoundary' : 'OutIfBoundary';
  const label = `multiIf(${n} = '', 'Router-local', ${n} = 'ifindex-unmapped', 'Unresolved interface', ${n})`;
  const role = `multiIf(${n} = '', 'Router', ${b} = 'external', 'External', ${b} = 'internal', 'Internal', 'Unclassified')`;
  const dir = side === 'in' ? `if(${b} = 'external', 'Inbound', 'Ingress')` : `if(${b} = 'external', 'Outbound', 'Egress')`;
  return `SELECT ExporterName AS Exporter, ${label} AS Interface, ${role} AS Role, ${dir} AS Direction, ${BYTES} AS bytes, count() AS flows, max(TimeReceived) AS lastts
          FROM default.flows WHERE ${RAWT} AND ${FX} AND (${n} = '' OR has([@{iface:singlequote}], ${n})) GROUP BY Exporter, Interface, Role, Direction`;
};
dash('netflow-exporters', 'NetFlow | Exporters & Interfaces', '30s', 'now-6h', [...std, ...stdH], [
  statusKPI(G(0, 0, 6, 3)), activeExp(G(6, 0, 6, 3)),
  stat('SILENT EXPORTERS', G(12, 0, 6, 3),
    `SELECT countIf(last < now() - INTERVAL 5 MINUTE) FROM (SELECT ExporterAddress, max(TimeReceived) AS last FROM default.flows_1m0s WHERE TimeReceived > now() - INTERVAL 7 DAY AND ${SC} GROUP BY ExporterAddress)`, 'short',
    { description: 'Exporters seen in the last 7 days with no flows in the last 5 minutes. Idle is not proof of failure.', steps: [{ color: 'green', value: null }, { color: 'orange', value: 1 }], noValue: '0' }),
  stat('FLOW RATE', G(18, 0, 6, 3), `SELECT count()/300 FROM default.flows WHERE TimeReceived > now() - INTERVAL 5 MINUTE AND ${SC} AND ${EX}`, 'suffix: flows/s', { noValue: '0 flows/s' }),
  ts('Traffic by exporter', G(0, 3, 12, 7),
    `SELECT ${BUCKET} AS time, ExporterName AS exporter, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} GROUP BY time, exporter ORDER BY time`, 'bps', { stack: true }),
  ts('Traffic by ingress interface', G(12, 3, 12, 7),
    `SELECT ${BUCKET} AS time, concat(ExporterName, ' / ', if(InIfName = '', 'Router-local', InIfName)) AS interface, ${BPS} AS bps FROM ${RES} WHERE ${TF} AND ${F} GROUP BY time, interface ORDER BY time`, 'bps', { stack: true,
      description: 'Interface names come from static/SNMP metadata. "Unresolved interface" = no name known for that ifIndex.' }),
  table('Interfaces (last ≤24 h)', G(0, 10, 24, 8),
    `SELECT Exporter, Interface, Role, Direction, round(bytes*8/${RAWRNG}) AS Traffic, round(flows/${RAWRNG}, 3) AS \`Flows/s\`, dateDiff('second', lastts, now()) AS \`Last flow\` FROM (
       ${ifaceRow('in')} UNION ALL ${ifaceRow('out')}) ORDER BY bytes DESC LIMIT 20`,
    [unit('Traffic', 'bps', 1), unit('Flows/s', 'none', 2), unit('Last flow', 's', 0),
      col('Role', [{ id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: [{ type: 'value', options: { External: { text: 'External', color: '#5B9BD5', index: 0 }, Internal: { text: 'Internal', color: '#A9B4C2', index: 1 }, Router: { text: 'Router-local', color: '#8F9BAA', index: 2 }, Unclassified: { text: 'Unclassified', color: '#6B7788', index: 3 } } }] }]),
      width('Exporter', 110), width('Role', 110), width('Direction', 100)],
    { noValue: 'No recent flows on any interface for the selected scope.',
      description: 'Role comes from verified interface boundary metadata. Router-local = traffic to/from the router itself (no output interface). Inbound/Outbound apply to external interfaces; Ingress/Egress to other interfaces. Utilization % is intentionally not shown: interface speed is not verified.' }),
  exporterSummary(G(0, 18, 24, 5), { title: 'Exporter status' }),
], 'Which exporter sends, on which interface, and whether it is still sending.');

// ================================================================= 5. Platform Health
nid = 1;
const sysOne = (m) => `SELECT value FROM system.asynchronous_metrics WHERE metric = '${m}'`;
dash('netflow-health', 'NetFlow | Platform Health', '30s', 'now-24h', [V.scope], [
  stat('PIPELINE', G(0, 0, 4, 3),
    `SELECT multiIf(age IS NULL, 0, age <= 300, 2, 1) FROM (SELECT min(dateDiff('second', TimeReceived, now())) AS age FROM default.flows WHERE TimeReceived > now() - INTERVAL 24 HOUR AND ${SC})`, 'none', {
    description: 'FLOWING: a flow arrived in the last 5 minutes (exporters → inlet → Kafka → outlet → ClickHouse all working). IDLE: flows exist but none recently — can be an idle lab, not a failure. Container-level state: status.sh.',
    colorMode: 'background', textMode: 'value', text: { valueSize: 18, titleSize: 11 },
    mappings: [{ type: 'value', options: { 2: { text: 'FLOWING', color: 'green', index: 0 }, 1: { text: 'IDLE / NO RECENT FLOWS', color: 'orange', index: 1 }, 0: { text: 'UNKNOWN', color: 'gray', index: 2 } } }],
    steps: [{ color: 'gray', value: null }], noValue: 'UNKNOWN' }),
  flowAge(G(4, 0, 4, 3), 'LAST REAL FLOW AGE'),
  activeExp(G(8, 0, 4, 3)),
  stat('CLICKHOUSE MEMORY', G(12, 0, 4, 3), sysOne('MemoryResident'), 'bytes', { decimals: 1, description: 'Resident memory; container cap 3 GiB.',
    steps: [{ color: 'green', value: null }, { color: 'orange', value: 2400000000 }, { color: 'red', value: 2900000000 }] }),
  stat('DISK UTILIZATION', G(16, 0, 4, 3), `SELECT round(100 * (total_space - free_space) / total_space, 1) FROM system.disks WHERE name = 'default'`, 'percent', { decimals: 1,
    description: 'Data disk. Ingestion is frozen by disk-guard at 95 %.', steps: [{ color: 'green', value: null }, { color: 'orange', value: 70 }, { color: 'red', value: 85 }] }),
  stat('QUERY HEALTH (p95)', G(20, 0, 4, 3),
    `SELECT round(quantile(0.95)(query_duration_ms)) FROM system.query_log WHERE type = 'QueryFinish' AND user = 'grafana_ro' AND event_time > now() - INTERVAL 15 MINUTE`, 'ms', { decimals: 0,
    description: 'p95 duration of Grafana queries in the last 15 minutes (limit is 30 s per query).', steps: [{ color: 'green', value: null }, { color: 'orange', value: 2000 }, { color: 'red', value: 10000 }], noValue: 'no queries' }),
  ts('Ingestion rate', G(0, 3, 12, 7),
    `SELECT toStartOfInterval(TimeReceived, INTERVAL greatest(60, $__interval_s) SECOND) AS time, count()/greatest(60, $__interval_s) AS fps
     FROM default.flows WHERE ${RAWT} AND ${SC} GROUP BY time ORDER BY time`, 'suffix: flows/s', { decimals: 2, description: 'Flow records per second (raw table, latest ≤24 h).', noValue: 'No flows in the selected range' }),
  ts('New flow data per hour', G(12, 3, 12, 7),
    `SELECT toStartOfHour(modification_time) AS time, sum(bytes_on_disk) AS bytes FROM system.parts
     WHERE active AND database = 'default' AND table = 'flows' AND $__timeFilter(modification_time) GROUP BY time ORDER BY time`, 'bytes',
    { description: 'Approximation from part modification time (merges rewrite parts).', noValue: 'No new flow data in the selected range' }),
  exporterSummary(G(0, 10, 10, 7), { title: 'Exporter freshness' }),
  table('Data by table', G(10, 10, 6, 7),
    `SELECT table AS Table, sum(bytes_on_disk) AS Size, round(100*sum(bytes_on_disk)/sum(sum(bytes_on_disk)) OVER (), 1) AS Share FROM system.parts
     WHERE active AND database = 'default' GROUP BY table ORDER BY Size DESC LIMIT 6`, [unit('Size', 'bytes', 1), share()], { noValue: 'No tables' }),
  ts('Grafana query duration', G(16, 10, 8, 7),
    `SELECT toStartOfInterval(event_time, INTERVAL 5 MINUTE) AS time, quantile(0.95)(query_duration_ms) AS p95, max(query_duration_ms) AS max
     FROM system.query_log WHERE type = 'QueryFinish' AND user = 'grafana_ro' AND $__timeFilter(event_time) GROUP BY time ORDER BY time`, 'ms', { decimals: 0, noValue: 'No Grafana queries in the selected range' }),
], 'Pipeline freshness, ClickHouse health, storage growth and Grafana query cost. Container state (inlet/outlet/Kafka) is available only via status.sh.');

mkdirSync('dashboards/netflow', { recursive: true });
for (const { d } of dashboards) {
  writeFileSync(`dashboards/netflow/${d.uid}.json`, JSON.stringify(d, null, 2) + '\n');
  console.log(d.uid.padEnd(22), 'panels:', String(d.panels.length).padStart(2), ' height rows:', Math.max(...d.panels.map((p) => p.gridPos.y + p.gridPos.h)));
}
