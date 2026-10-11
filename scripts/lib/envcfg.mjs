// Environment configuration for the content tooling: parse an env file, render config/datasources.tmpl.json, apply the Zabbix item map.
// Pure functions (no network, no Grafana) so they can be unit-tested (tests/unit/*.test.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './grafana.mjs';

/** Parse KEY=VALUE lines (no shell evaluation, no expansion). '#' comments and blank lines ignored; optional single/double quotes stripped. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) throw new Error(`unparsable line in env file: ${l.slice(0, 40)}`);
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
export function loadEnvFile(path) { return parseEnv(readFileSync(path, 'utf8')); }

const toBool = (v, name) => { if (/^(true|yes|1)$/i.test(v)) return true; if (/^(false|no|0)$/i.test(v)) return false; throw new Error(`${name} must be true/false (got "${v}")`); };

/** Replace "@@NAME@@", "@@NAME:int@@", "@@NAME:bool@@" string values in a parsed JSON structure. Unknown / empty required values throw. */
export function substitute(node, env) {
  if (Array.isArray(node)) return node.map((x) => substitute(x, env));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, env)]));
  if (typeof node !== 'string') return node;
  const whole = node.match(/^@@([A-Z0-9_]+)(?::(int|bool))?@@$/);
  const get = (name) => { const v = env[name]; if (v === undefined || v === '') throw new Error(`environment value ${name} is required but not set`); return v; };
  if (whole) {
    const v = get(whole[1]);
    if (whole[2] === 'int') { if (!/^\d+$/.test(v)) throw new Error(`${whole[1]} must be an integer (got "${v}")`); return Number(v); }
    if (whole[2] === 'bool') return toBool(v, whole[1]);
    return v;
  }
  return node.replace(/@@([A-Z0-9_]+)@@/g, (_, n) => get(n));
}

/** config/datasources.tmpl.json rendered with the environment. */
export function renderDatasources(env, root = ROOT) {
  return substitute(JSON.parse(readFileSync(join(root, 'config', 'datasources.tmpl.json'), 'utf8')), env);
}

// ---- Zabbix item map ----------------------------------------------------------------------------------------------
/** All "itemids" values (queryType 3) of a dashboard, in order of appearance. */
export function itemIds(dash) {
  const ids = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.itemids === 'string' && String(o.queryType) === '3') o.itemids.split(',').map((s) => s.trim()).filter(Boolean).forEach((i) => ids.push(i));
    Object.values(o).forEach(walk);
  })(dash);
  return ids;
}

/** Returns { dashboard, missing:[ids without a mapping] }. Does not mutate the input. A null/undefined map = identity (LAB). */
export function applyItemMap(dash, map) {
  const copy = JSON.parse(JSON.stringify(dash));
  if (!map) return { dashboard: copy, missing: [] };
  const missing = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.itemids === 'string' && String(o.queryType) === '3') {
      o.itemids = o.itemids.split(',').map((s) => s.trim()).filter(Boolean).map((i) => { if (map[i] === undefined || map[i] === '') { missing.add(i); return i; } return String(map[i]); }).join(',');
    }
    Object.values(o).forEach(walk);
  })(copy);
  return { dashboard: copy, missing: [...missing].sort() };
}

export function loadItemMap(path) {
  if (!path || !existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${path}: item map must be a JSON object {"<lab item id>": "<item id here>"}`);
  for (const [k, v] of Object.entries(m)) if (!/^\d+$/.test(k) || !/^\d+$/.test(String(v))) throw new Error(`${path}: bad entry ${k} -> ${v} (ids are numeric)`);
  return m;
}
