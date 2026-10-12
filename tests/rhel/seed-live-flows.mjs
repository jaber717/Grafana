// Adds a few CURRENT synthetic flow rows to the TEST ClickHouse so the NetFlow dashboards can be exercised with traffic (the LAB has none by design):
//   SITE-A  flows during the last 20 minutes  -> ACTIVE
//   SITE-B  flows 25-45 minutes ago           -> IDLE / NO RECENT FLOWS
//   every other inventory device sends nothing -> NO DATA
// ExporterName equals the Zabbix host name, which is how the dashboards map an inventory device to its flows. Disposable test data only;
// run with  --clean  to remove it again (rows are recognisable by their documentation-range addresses and the SEEDLIVE site tag).
//   node tests/rhel/seed-live-flows.mjs [--clean]
import { insertSql } from './netflow-fixture.mjs';

const CH = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const ch = async (sql) => { const r = await fetch(`${CH}/?user=default&allow_suspicious_low_cardinality_types=1`, { method: 'POST', body: sql }); const t = await r.text(); if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${t.slice(0, 300)}`); return t; };
const v4 = (a) => `::ffff:${a}`;

if (process.argv.includes('--clean')) {
  for (const t of ['flows', 'flows_1m0s', 'flows_5m0s', 'flows_1h0m0s']) await ch(`ALTER TABLE default.${t} DELETE WHERE ExporterName IN ('SITE-A', 'SITE-B') SETTINGS mutations_sync = 1`);
  console.log('seeded live rows removed');
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const E = { 'SITE-A': { addr: v4('10.1.0.1'), name: 'SITE-A', site: 'SEEDLIVE' }, 'SITE-B': { addr: v4('10.2.0.1'), name: 'SITE-B', site: 'SEEDLIVE' } };
const row = (e, t, o) => ({ t, rate: 1, exporter: e.addr, exporterName: e.name, site: e.site, srcNet: '', dstNet: '', inProv: '', outProv: '', proto: 6, srcPort: 40000, dstPort: 443, packets: 10, ...o });
const rows = [];
for (let s = 10; s <= 20 * 60; s += 60) {
  rows.push(row(E['SITE-A'], now - s, { src: v4('203.0.113.10'), dst: v4('10.1.4.15'), inIf: 'Gi0/0', outIf: 'Gi0/1', inB: 'external', outB: 'internal', inProv: 'ISP-A', bytes: 120000 }));
  rows.push(row(E['SITE-A'], now - s, { src: v4('10.1.4.15'), dst: v4('203.0.113.10'), inIf: 'Gi0/1', outIf: 'Gi0/0', inB: 'internal', outB: 'external', outProv: 'ISP-A', bytes: 40000 }));
}
for (let s = 25 * 60; s <= 45 * 60; s += 60) rows.push(row(E['SITE-B'], now - s, { src: v4('198.51.100.24'), dst: v4('10.2.4.88'), inIf: 'Gi0/0', outIf: 'Gi0/1', inB: 'external', outB: 'internal', inProv: 'ISP-B', bytes: 80000 }));
await ch(insertSql(rows));
console.log(`seeded ${rows.length} rows (SITE-A active, SITE-B idle)`);
