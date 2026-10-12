// Generates the enhanced NOC dashboards from the frozen v1.0.1 base JSON:  node tools/monitoring/build.mjs [outDir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeviceHealth } from './device-health.mjs';
import { buildWan } from './wan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = process.argv[2] || join(root, 'dashboards', 'noc');
const base = (n) => JSON.parse(readFileSync(join(here, 'base', n), 'utf8'));
const write = (n, d) => { mkdirSync(out, { recursive: true }); writeFileSync(join(out, n), JSON.stringify(d, null, 2) + '\n'); console.log('wrote', n); };

write('noc-device-health.json', buildDeviceHealth(base('noc-device-health.json')));
write('noc-wan-overview.json', buildWan(base('noc-wan-overview.json')));
