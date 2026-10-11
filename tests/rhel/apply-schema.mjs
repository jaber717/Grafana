// Applies a ClickHouse schema file (one statement per CREATE line, as exported by Akvorado) statement by statement, retrying failed ones in
// later passes until a pass makes no progress (the file is alphabetical, so views can appear before the tables they read).
//   node apply-schema.mjs schema.sql [http://127.0.0.1:8123]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const CH = process.argv[3] || 'http://127.0.0.1:8123';
let pending = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^CREATE /.test(l)).map((l) => l.replace(/;$/, ''));
const total = pending.length;
for (let pass = 1; pending.length && pass <= 10; pass++) {
  const failed = [];
  let last = '';
  for (const stmt of pending) {
    const r = await fetch(`${CH}/?user=default&allow_suspicious_low_cardinality_types=1`, { method: 'POST', body: stmt });
    if (!r.ok) { failed.push(stmt); last = (await r.text()).split('\n')[0]; }
  }
  const progressed = failed.length < pending.length;
  pending = failed;
  if (!progressed) { console.error(`no progress with ${pending.length} statement(s) left; last error: ${last}`); break; }
}
console.log(`applied ${total - pending.length}/${total} statements`);
process.exit(pending.length ? 1 : 0);
