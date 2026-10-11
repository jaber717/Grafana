import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterfaceItemName, discoverInterfaces, candidatesYaml, compareConfig } from '../../reports/lib/discover.mjs';
import { loadInterfaceConfig } from '../../reports/lib/config.mjs';

const host = (name, tech = name) => [{ host: tech, name }];
const item = (hostName, name, extra = {}) => ({ itemid: String(Math.random()), name, key_: 'x', hosts: host(hostName, extra.tech || hostName), lastvalue: extra.lastvalue ?? '0', status: '0' });

function fakeZabbix(items) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'item.get', 'discovery is read-only: only item.get is ever called');
    const needle = params.search.name;
    return items.filter((i) => i.name.includes(needle));
  };
  return { call, calls };
}

const ITEMS = [
  item('SITE-A', 'Interface Gi0/0(TO-SAIX-A-Gi0/1): Bits received'), item('SITE-A', 'Interface Gi0/0(TO-SAIX-A-Gi0/1): Bits sent'),
  item('SITE-A', 'Interface Gi0/0(TO-SAIX-A-Gi0/1): Speed', { lastvalue: '1000000000' }),
  item('SITE-B', 'Interface Gi0/0(TO-SAIX-B-Gi0/1): Bits received'), item('SITE-B', 'Interface Gi0/0(TO-SAIX-B-Gi0/1): Bits sent'),
  item('SITE-B', 'Interface Gi0/1(LAN: users #1): Bits received'),
  item('SITE-B', 'CPU utilization'),
];

test('item names are parsed into interface, description and direction', () => {
  assert.deepEqual(parseInterfaceItemName('Interface Gi0/0(TO-SAIX-A-Gi0/1): Bits received'), { interface: 'Gi0/0', description: 'TO-SAIX-A-Gi0/1', direction: 'received' });
  assert.deepEqual(parseInterfaceItemName('Interface Te1/0/1(): Bits sent'), { interface: 'Te1/0/1', description: '', direction: 'sent' });
  assert.equal(parseInterfaceItemName('CPU utilization'), null);
});

test('discovery is read-only, groups rx/tx per interface, suggests speed only when Zabbix has it, flags incomplete pairs', async () => {
  const z = fakeZabbix(ITEMS);
  const c = await discoverInterfaces(z.call);
  assert.ok(z.calls.every((x) => x.method === 'item.get'));
  assert.deepEqual(c.map((x) => `${x.device}:${x.interface}`), ['SITE-A:Gi0/0', 'SITE-B:Gi0/0', 'SITE-B:Gi0/1']);
  assert.equal(c[0].speedBps, 1e9);
  assert.equal(c[1].speedBps, null);
  assert.deepEqual(c[0].issues, []);
  assert.deepEqual(c[2].issues, ["0 'Bits sent' items"]);
});

test('ambiguous visible host names are flagged', async () => {
  const z = fakeZabbix([item('SW1', 'Interface Gi0/1(x): Bits received', { tech: 'sw1-a' }), item('SW1', 'Interface Gi0/1(x): Bits sent', { tech: 'sw1-a' }), item('SW1', 'Interface Gi0/2(y): Bits received', { tech: 'sw1-b' }), item('SW1', 'Interface Gi0/2(y): Bits sent', { tech: 'sw1-b' })]);
  const c = await discoverInterfaces(z.call);
  assert.ok(c.every((x) => x.issues.some((i) => /several Zabbix hosts/.test(i))));
});

test('the candidates file includes NOTHING and is valid input for the configuration loader', async () => {
  const c = await discoverInterfaces(fakeZabbix(ITEMS).call);
  const text = candidatesYaml(c, { generatedAt: '2026-10-12T00:00:00Z' });
  const cfg = loadInterfaceConfig(text);
  assert.equal(cfg.interfaces.length, 0, 'no candidate is included');
  assert.equal(cfg.excluded.length, 3);
  assert.match(text, /speed: 1G/);
  assert.match(text, /# PROBLEM: 0 'Bits sent' items/);
  assert.equal(cfg.excluded.find((e) => e.key === 'SITE-B:Gi0/0').speedBps, null);
  assert.match(text, /description: "LAN: users #1"/, 'special characters are quoted');
});

test('mapping check: matches, wrong item names, missing interfaces and unconfigured candidates', async () => {
  const c = await discoverInterfaces(fakeZabbix(ITEMS).call);
  const yaml = `groups:\n  - id: wan\n    title: WAN\ninterfaces:\n  - site: SITE-A\n    device: SITE-A\n    interface: Gi0/0\n    description: TO-SAIX-A-Gi0/1\n    speed: 1G\n    group: wan\n    include: true\n  - site: SITE-B\n    device: SITE-B\n    interface: Gi0/0\n    description: WRONG-DESCRIPTION\n    group: wan\n    include: true\n  - site: SITE-C\n    device: SITE-C\n    interface: Gi0/0\n    group: wan\n    include: true\n`;
  const r = compareConfig(yaml, c);
  assert.deepEqual(r.ok, ['SITE-A:Gi0/0']);
  assert.ok(r.problems.some((p) => /SITE-B:Gi0\/0.*received item is "Interface Gi0\/0\(TO-SAIX-B-Gi0\/1\): Bits received"/.test(p)));
  assert.ok(r.problems.some((p) => /SITE-C:Gi0\/0: no matching device\/interface/.test(p)));
  assert.deepEqual(r.notConfigured, ['SITE-B:Gi0/1']);
});
