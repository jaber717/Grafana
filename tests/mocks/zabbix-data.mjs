// Deterministic SYNTHETIC interface rates (bit/s, 60 s samples) shared by the Zabbix mock and the accuracy validation. Never real data.
import { mulberry32 } from '../../reports/lib/demo.mjs';

// host, id, interfaces: [name, description, speed bit/s, in peak fraction, out peak fraction]
export const HOSTS = [
  { host: 'SITE-A', id: '10001', ifs: [['Gi0/0', 'TO-SAIX-A-Gi0/1', 1e9, 0.62, 0.27]] },
  { host: 'SITE-B', id: '10002', ifs: [['Gi0/0', 'TO-SAIX-B-Gi0/1', 1e9, 0.48, 0.2]] },
  { host: 'STC', id: '10003', ifs: [['Gi0/0', 'TO-INT-CORE-Gi0/0', 1e9, 0.1, 0.05]] },
];
export const ITEMS = [];
let nextId = 90000;
for (const h of HOSTS) {
  for (const [name, desc, speed, fin, fout] of h.ifs) {
    for (const [dir, key, frac] of [['received', `net.if.in[ifHCInOctets.1]`, fin], ['sent', `net.if.out[ifHCOutOctets.1]`, fout]]) {
      ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: `Interface ${name}(${desc}): Bits ${dir}`, key_: key, value_type: '0', units: 'bps', status: '0', state: '0', delay: '60s', history: '7d', trends: '365d', lastvalue: '0', lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }], speed, frac, seed: nextId });
    }
    ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: `Interface ${name}(${desc}): Speed`, key_: 'net.if.speed[ifHighSpeed.1]', value_type: '3', units: 'bps', status: '0', state: '0', delay: '1h', history: '7d', trends: '365d', lastvalue: String(speed), lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }] });
  }
  ITEMS.push({ itemid: String(nextId++), hostid: h.id, name: 'ICMP ping', key_: 'icmpping', value_type: '3', units: '', status: '0', state: '0', delay: '1m', history: '7d', trends: '365d', lastvalue: '1', lastclock: '0', tags: [], hosts: [{ hostid: h.id, host: h.host, name: h.host }] });
}

export function rateAt(item, tSec) {
  const dayStart = Math.floor((tSec + 3 * 3600) / 86400) * 86400 - 3 * 3600;       // Riyadh midnight
  const hour = (tSec - dayStart) / 3600;
  const rnd = mulberry32(item.seed * 100003 + Math.floor(tSec / 60));
  const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
  const peaks = Math.exp(-((hour - 11) ** 2) / 3) * 0.25 + Math.exp(-((hour - 20.5) ** 2) / 4) * 0.2;
  const night = hour < 5 ? 0.35 : 1;
  return Math.max(0, (diurnal + peaks) * night) * (item.speed * item.frac / 1.22) * (0.94 + 0.12 * rnd());
}

export function history(item, from, till, gapHost = null) {
  const out = [];
  const host = HOSTS.find((h) => h.id === item.hostid).host;
  const gapStart = Math.floor(from / 86400) * 86400 + 6 * 3600, gapEnd = gapStart + 90 * 60;
  for (let t = Math.ceil(from / 60) * 60; t <= till; t += 60) {
    if (gapHost === host && t >= gapStart && t < gapEnd) continue;
    out.push({ itemid: item.itemid, clock: String(t), value: String(Math.round(rateAt(item, t))), ns: '0' });
  }
  return out;
}

