// NetFlow report queries - ONE definition, used by the dashboard panels (so the panels draw exactly this) and by the KPI extraction
// (so the numbers in the PDF cards and tables come from the same SQL). Based on the existing NetFlow dashboards:
//  - volume = sum(Bytes * SamplingRate): an ESTIMATE for sampled exporters, observed volume when SamplingRate = 1;
//  - direction comes from verified interface boundary metadata (external <-> internal); nothing is guessed;
//  - the Akvorado demo exporter (::ffff:247.16.14.11) is always excluded from real reports;
//  - the window is half-open [FROM, TO): the 5-minute rollup gives 288 buckets for a day, the hourly one 24.
// Placeholders: {FROM} / {TO} are replaced by $__fromTime / $__toTime in dashboards and by explicit DateTime values by the client.

export const DEMO_EXPORTER = "toIPv6('::ffff:247.16.14.11')";
export const REAL = `ExporterAddress != ${DEMO_EXPORTER}`;
export const DIR = "multiIf(InIfBoundary = 'external' AND OutIfBoundary != 'external', 'inbound', OutIfBoundary = 'external' AND InIfBoundary != 'external', 'outbound', InIfBoundary = 'external' AND OutIfBoundary = 'external', 'transit', 'unclassified')";
const win = (extra = '') => `TimeReceived >= {FROM} AND TimeReceived < {TO} AND ${REAL}${extra ? ` AND ${extra}` : ''}`;
const edge = `${DIR} IN ('inbound', 'outbound')`;
const IP = (c) => `replaceRegexpOne(IPv6NumToString(${c}), '^::ffff:', '')`;
const SERVICE = `concat(multiIf(Proto = 6, 'TCP', Proto = 17, 'UDP', Proto = 1, 'ICMP', concat('proto ', toString(Proto))), '/', toString(DstPort))`;
const BYTES = 'sum(Bytes * SamplingRate)';

export const NETFLOW_QUERIES = {
  // ---- panels (and KPI sources) ----
  trend: {
    title: 'Traffic by direction - 5-minute average',
    sql: `SELECT toStartOfInterval(TimeReceived, INTERVAL 5 MINUTE) AS time, sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') * 8 / 300 AS Inbound, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') * 8 / 300 AS Outbound FROM default.flows_5m0s WHERE ${win()} GROUP BY time ORDER BY time`,
  },
  trend_total: {
    title: 'Day total (inbound + outbound)',
    sql: `SELECT toStartOfInterval(TimeReceived, INTERVAL 5 MINUTE) AS time, sumIf(Bytes * SamplingRate, ${DIR} IN ('inbound', 'outbound')) * 8 / 300 AS Today FROM default.flows_5m0s WHERE ${win()} GROUP BY time ORDER BY time`,
  },
  trend_prev: {
    title: 'Previous day (shifted by 24 h)',
    // the previous day, plotted on today's time axis
    sql: `SELECT toStartOfInterval(TimeReceived, INTERVAL 5 MINUTE) + INTERVAL 1 DAY AS time, sumIf(Bytes * SamplingRate, ${DIR} IN ('inbound', 'outbound')) * 8 / 300 AS \`Previous day\` FROM default.flows_5m0s WHERE TimeReceived >= {FROM} - INTERVAL 1 DAY AND TimeReceived < {TO} - INTERVAL 1 DAY AND ${REAL} GROUP BY time ORDER BY time`,
  },
  hourly: {
    title: 'Hourly volume',
    sql: `SELECT toStartOfInterval(TimeReceived, INTERVAL 1 HOUR) AS time, sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS Inbound, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS Outbound FROM default.flows_1h0m0s WHERE ${win()} GROUP BY time ORDER BY time`,
  },
  protocols: {
    title: 'Protocol mix',
    sql: `SELECT multiIf(Proto = 6, 'TCP', Proto = 17, 'UDP', Proto = 1, 'ICMP', 'Other') AS Protocol, ${BYTES} AS Bytes FROM default.flows_1h0m0s WHERE ${win(edge)} GROUP BY Protocol ORDER BY Bytes DESC`,
  },
  exporters: {
    title: 'Exporters',
    sql: `SELECT ExporterName AS Exporter, any(ExporterSite) AS Site, sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS InboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS OutboundBytes, max(SamplingRate) AS SamplingRate, uniqExact(TimeReceived) AS Buckets, toUnixTimestamp(max(TimeReceived)) AS LastSeen FROM default.flows_5m0s WHERE ${win()} GROUP BY Exporter ORDER BY InboundBytes + OutboundBytes DESC LIMIT 10`,
  },
  top_src: {
    title: 'Top 10 source IPs',
    sql: `SELECT ${IP('SrcAddr')} AS IP, if(any(SrcNetName) = '', '-', any(SrcNetName)) AS Network, ${BYTES} AS Bytes FROM default.flows WHERE ${win(edge)} GROUP BY IP ORDER BY Bytes DESC LIMIT 10`,
  },
  top_dst: {
    title: 'Top 10 destination IPs',
    sql: `SELECT ${IP('DstAddr')} AS IP, if(any(DstNetName) = '', '-', any(DstNetName)) AS Network, ${BYTES} AS Bytes FROM default.flows WHERE ${win(edge)} GROUP BY IP ORDER BY Bytes DESC LIMIT 10`,
  },
  top_conv: {
    title: 'Top 10 conversations',
    sql: `SELECT ${IP('SrcAddr')} AS Source, ${IP('DstAddr')} AS Destination, ${SERVICE} AS Service, ${BYTES} AS Bytes FROM default.flows WHERE ${win(edge)} GROUP BY Source, Destination, Service ORDER BY Bytes DESC LIMIT 10`,
  },
  top_ports: {
    title: 'Top 10 protocols / ports',
    sql: `SELECT ${SERVICE} AS Service, ${BYTES} AS Bytes FROM default.flows WHERE ${win(edge)} GROUP BY Service ORDER BY Bytes DESC LIMIT 10`,
  },
  by_site: {
    title: 'Traffic by site (exporter metadata)',
    sql: `SELECT ExporterSite AS Site, sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS InboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS OutboundBytes FROM default.flows_1h0m0s WHERE ${win("ExporterSite != ''")} GROUP BY Site ORDER BY InboundBytes + OutboundBytes DESC LIMIT 10`,
  },
  by_isp: {
    title: 'Traffic by ISP / provider (external interface metadata)',
    sql: `SELECT if(InIfBoundary = 'external', InIfProvider, OutIfProvider) AS Provider, sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS InboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS OutboundBytes FROM default.flows_1h0m0s WHERE ${win(`${edge} AND if(InIfBoundary = 'external', InIfProvider, OutIfProvider) != ''`)} GROUP BY Provider ORDER BY InboundBytes + OutboundBytes DESC LIMIT 10`,
  },
  // ---- KPI-only queries ----
  totals: {
    title: 'Window totals',
    sql: `SELECT sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS InboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS OutboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'transit') AS TransitBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'unclassified') AS UnclassifiedBytes, max(SamplingRate) AS MaxSamplingRate, uniqExact(TimeReceived) AS Buckets, uniqExact(ExporterAddress) AS Exporters, toUnixTimestamp(max(TimeReceived)) AS LastFlow FROM default.flows_5m0s WHERE ${win()}`,
  },
  totals_prev: {
    title: 'Previous-window totals',
    sql: `SELECT sumIf(Bytes * SamplingRate, ${DIR} = 'inbound') AS InboundBytes, sumIf(Bytes * SamplingRate, ${DIR} = 'outbound') AS OutboundBytes, uniqExact(TimeReceived) AS Buckets FROM default.flows_5m0s WHERE TimeReceived >= {FROM} - INTERVAL 1 DAY AND TimeReceived < {TO} - INTERVAL 1 DAY AND ${REAL}`,
  },
  newest_flow: {
    title: 'Collection freshness',
    sql: `SELECT toUnixTimestamp(max(TimeReceived)) AS LastFlow FROM default.flows_5m0s WHERE ${REAL}`,
  },
};

// Substitute the window placeholders. unix seconds -> DateTime literal; dashboards pass {macro: true}.
export function bind(sql, win_, { macro = false } = {}) {
  const from = macro ? '$__fromTime' : `toDateTime(${Math.floor(win_.startMs / 1000)})`;
  const to = macro ? '$__toTime' : `toDateTime(${Math.floor(win_.endMs / 1000)})`;
  return sql.replaceAll('{FROM}', from).replaceAll('{TO}', to);
}
