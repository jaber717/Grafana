import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, renderDatasources, substitute, applyItemMap, itemIds, loadItemMap } from '../../scripts/lib/envcfg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

test('lab.env.example renders to exactly the datasource definitions captured from the running grafana-01', () => {
  const rendered = renderDatasources(parseEnv(rd('env/lab.env.example')));
  const captured = JSON.parse(rd('config/datasources.json'));
  const key = (a) => JSON.stringify([...a].sort((x, y) => x.uid.localeCompare(y.uid)));
  assert.equal(key(rendered), key(captured));
});

test('production example renders with TLS verification on and no LAB addresses', () => {
  const ds = renderDatasources(parseEnv(rd('env/production.env.example')));
  const z = ds.find((d) => d.uid === 'zabbix-lab'), c = ds.find((d) => d.uid === 'netflow-clickhouse');
  assert.equal(z.jsonData.tlsSkipVerify, false);
  assert.equal(c.jsonData.secure, true);
  assert.equal(c.jsonData.port, 8443);
  assert.ok(!JSON.stringify(ds).includes('192.168.'));
  assert.equal(z.uid, 'zabbix-lab');
});

test('missing or invalid values fail loudly', () => {
  assert.throws(() => renderDatasources({}), /required/);
  assert.throws(() => substitute({ a: '@@X:int@@' }, { X: 'abc' }), /integer/);
  assert.throws(() => substitute({ a: '@@X:bool@@' }, { X: 'maybe' }), /true\/false/);
});

test('parseEnv handles comments, quotes and refuses garbage', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\nC=x # trailing\nexport D=4\n'), { A: '1', B: 'two words', C: 'x', D: '4' });
  assert.throws(() => parseEnv('not a line'), /unparsable/);
});

test('item map rewrites only queryType 3 itemids and reports unmapped ids', () => {
  const dash = { panels: [{ targets: [{ itemids: '1', queryType: '3' }, { itemids: '2,3', queryType: '3' }, { itemids: '9', queryType: '1' }] }] };
  assert.deepEqual(itemIds(dash), ['1', '2', '3']);
  const r = applyItemMap(dash, { 1: '10', 2: '20' });
  assert.equal(r.dashboard.panels[0].targets[0].itemids, '10');
  assert.equal(r.dashboard.panels[0].targets[1].itemids, '20,3');
  assert.equal(r.dashboard.panels[0].targets[2].itemids, '9');
  assert.deepEqual(r.missing, ['3']);
  assert.equal(dash.panels[0].targets[0].itemids, '1', 'input must not be mutated');
  assert.deepEqual(applyItemMap(dash, null).missing, []);
});

test('loadItemMap returns null for a missing file', () => {
  assert.equal(loadItemMap('/nonexistent/file.json'), null);
});

test('every Zabbix item used by the shipped NOC dashboards has a descriptor', () => {
  const desc = JSON.parse(rd('config/zabbix-item-descriptors.json'));
  for (const f of ['noc-wan-overview', 'noc-device-health']) {
    for (const id of itemIds(JSON.parse(rd(`dashboards/noc/${f}.json`)))) assert.ok(desc.items[id], `item ${id} of ${f} has no descriptor`);
  }
});
