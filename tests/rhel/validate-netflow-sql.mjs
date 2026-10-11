// Runs EVERY NetFlow report query (reports/lib/queries.mjs) against a real ClickHouse that holds the synthetic fixture and compares each
// result with the independently computed expectation (netflow-fixture.mjs). Run on the test machine:
//   node tests/rhel/validate-netflow-sql.mjs [--seed]       (--seed loads the fixture first; ClickHouse HTTP on 127.0.0.1:8123)
import { NETFLOW_QUERIES, bind } from '../../reports/lib/queries.mjs';
import { buildFixture, expected, insertSql } from './netflow-fixture.mjs';

const CH = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
async function ch(sql, { user = 'default', password = '', json = true } = {}) {
  const r = await fetch(`${CH}/?user=${user}${password ? `&password=${password}` : ''}&default_format=${json ? 'JSONEachRow' : 'TSV'}&output_format_json_quote_64bit_integers=0&allow_suspicious_low_cardinality_types=1`, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${t.slice(0, 400)}`);
  return json ? t.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : t;
}

const fx = buildFixture('2026-10-11');
const exp = expected(fx);
let failures = 0, checks = 0;
const eq = (name, got, want) => {
  checks++;
  const ok = typeof want === 'number' ? Math.abs(Number(got) - want) <= Math.max(1e-6 * Math.abs(want), 1e-6) : String(got) === String(want);
  if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, expected ${want}`); }
};

if (process.argv.includes('--seed')) {
  await ch('TRUNCATE TABLE default.flows', { json: false }); for (const t of ['flows_1m0s', 'flows_5m0s', 'flows_1h0m0s']) await ch(`TRUNCATE TABLE default.${t}`, { json: false });
  for (let i = 0; i < fx.rows.length; i += 2000) await ch(insertSql(fx.rows.slice(i, i + 2000)), { json: false });
  console.log(`seeded ${fx.rows.length} rows; flows=${(await ch('SELECT count() AS c FROM default.flows'))[0].c} flows_5m0s=${(await ch('SELECT count() AS c FROM default.flows_5m0s'))[0].c}`);
}
const run = async (id) => ch(bind(NETFLOW_QUERIES[id].sql, fx.win).replaceAll('$__fromTime', `toDateTime(${fx.win.startMs / 1000})`).replaceAll('$__toTime', `toDateTime(${fx.win.endMs / 1000})`), { user: 'grafana_ro', password: 'dummy-ro-pw-test' });

// every query executes (syntax, columns, types) as the READ-ONLY user
for (const id of Object.keys(NETFLOW_QUERIES)) { try { await run(id); checks++; } catch (e) { failures++; console.log(`FAIL ${id}: does not execute: ${e.message}`); } }

const t = (await run('totals'))[0];
for (const k of Object.keys(exp.totals)) eq(`totals.${k}`, t[k], exp.totals[k]);
const tp = (await run('totals_prev'))[0];
for (const k of Object.keys(exp.totals_prev)) eq(`totals_prev.${k}`, tp[k], exp.totals_prev[k]);
const trend = await run('trend');
eq('trend.rows', trend.length, exp.trend.length);
exp.trend.forEach((e, i) => { if (i % 29 === 0 || i === 287) { eq(`trend[${i}].Inbound`, trend[i].Inbound, e.Inbound); eq(`trend[${i}].Outbound`, trend[i].Outbound, e.Outbound); } });
eq('trend.sum matches totals', trend.reduce((a, r) => a + (r.Inbound * 300) / 8, 0), exp.totals.InboundBytes);
const hourly = await run('hourly');
eq('hourly.rows', hourly.length, 24);
exp.hourly.forEach((e, i) => { eq(`hourly[${i}].Inbound`, hourly[i].Inbound, e.Inbound); eq(`hourly[${i}].Outbound`, hourly[i].Outbound, e.Outbound); });
eq('hourly.sum matches totals', hourly.reduce((a, r) => a + Number(r.Inbound), 0), exp.totals.InboundBytes);
const prevRows = await run('trend_prev');
eq('trend_prev.rows', prevRows.length, 288);
eq('trend_prev is shifted onto the report day', Date.parse(prevRows[0].time.replace(' ', 'T') + 'Z'), fx.win.startMs);
const totalRows = await run('trend_total');
eq('trend_total.rows', totalRows.length, 288);
const named = (rows, key, val) => rows.map((r) => [r[key], Number(r[val])]);
for (const [id, key] of [['protocols', 'Protocol'], ['top_src', 'IP'], ['top_dst', 'IP'], ['top_ports', 'Service']]) {
  const got = named(await run(id), key, 'Bytes');
  eq(`${id}.count`, got.length, exp[id].length);
  exp[id].forEach(([k, v], i) => { eq(`${id}[${i}].key`, got[i]?.[0], k); eq(`${id}[${i}].bytes`, got[i]?.[1], v); });
}
const conv = await run('top_conv');
eq('top_conv.count', conv.length, exp.top_conv.length);
exp.top_conv.forEach(([k, v], i) => { eq(`top_conv[${i}].key`, `${conv[i].Source}>${conv[i].Destination}>${conv[i].Service}`, k); eq(`top_conv[${i}].bytes`, conv[i].Bytes, v); });
const exps = await run('exporters');
eq('exporters.count', exps.length, exp.exporters.length);
exp.exporters.forEach((e, i) => { for (const k of ['Exporter', 'InboundBytes', 'OutboundBytes', 'MaxSamplingRate', 'Buckets']) eq(`exporters[${i}].${k}`, exps[i][k], e[k]); });
for (const [id, key] of [['by_site', 'Site'], ['by_isp', 'Provider']]) {
  const got = await run(id);
  eq(`${id}.count`, got.length, exp[id].length);
  exp[id].forEach((e, i) => { eq(`${id}[${i}].key`, got[i][key], e[key]); eq(`${id}[${i}].in`, got[i].InboundBytes, e.InboundBytes); eq(`${id}[${i}].out`, got[i].OutboundBytes, e.OutboundBytes); });
}
const nf = await run('newest_flow');
eq('newest_flow ignores the demo exporter and is in the window or later', nf[0].LastFlow >= exp.totals.LastFlow, true);
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
