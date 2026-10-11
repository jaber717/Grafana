// Interface report accuracy: compares the numbers in the generated model (interface.model.json, produced through the real Grafana Zabbix
// datasource plugin with groupBy 5m/avg) with an independent calculation from the raw 60-second samples of the Zabbix mock.
//   node tests/rhel/validate-interface-accuracy.mjs <out-dir/2026-10-11> [YYYY-MM-DD]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEMS, history } from '../mocks/zabbix-data.mjs';
import { windowForDate } from '../../reports/lib/window.mjs';

const dir = process.argv[2];
const win = windowForDate(process.argv[3] || '2026-10-11');
const model = JSON.parse(readFileSync(join(dir, 'interface.model.json'), 'utf8'));
let checks = 0, failures = 0;
const near = (name, got, want, tol = 1e-6) => { checks++; const ok = Math.abs(got - want) <= Math.max(tol * Math.abs(want), 1e-9); if (!ok) { failures++; console.log(`FAIL ${name}: report ${got}, independent ${want}`); } else console.log(`ok   ${name}: ${Number(got).toPrecision(8)}`); };

for (const s of model.interfaces) {
  for (const [dir_, label] of [['inbound', 'received'], ['outbound', 'sent']]) {
    const item = ITEMS.find((i) => i.name === `Interface ${s.interface}(${s.description}): Bits ${label}` && i.hosts[0].name === s.device);
    const samples = history(item, win.startMs / 1000, win.endMs / 1000 - 1).map((x) => Number(x.value));
    const bytes = samples.reduce((a, v) => a + (v * 60) / 8, 0);
    const buckets = []; for (let i = 0; i < samples.length; i += 5) buckets.push(samples.slice(i, i + 5).reduce((a, v) => a + v, 0) / 5);
    const m = s[dir_];
    near(`${s.key} ${dir_} volume (bytes)`, m.bytes, bytes);
    near(`${s.key} ${dir_} average (bit/s)`, m.avgBps, (bytes * 8) / 86400);
    near(`${s.key} ${dir_} peak of 5-minute averages (bit/s)`, m.peakBps, Math.max(...buckets));
    if (s.speedBps) near(`${s.key} ${dir_} peak utilisation (%)`, m.peakUtilPct, Math.round((Math.max(...buckets) / s.speedBps) * 1000) / 10, 1e-9);
    near(`${s.key} ${dir_} coverage`, m.coverage, 1);
  }
}
console.log(`\n${checks - failures}/${checks} checks agree with the independent calculation`);
process.exit(failures ? 1 : 0);
