import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { NETFLOW_QUERIES, bind, REAL } from '../../reports/lib/queries.mjs';

// Every report module must at least load (a syntax error in a rarely used module must fail the suite, not a 07:00 run).
test('every reports/lib module imports cleanly', async () => {
  const dir = new URL('../../reports/lib/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    await assert.doesNotReject(import(new URL(f, dir)), `reports/lib/${f}`);
  }
});

test('queries: every query binds to a half-open window and never reads the demo exporter', () => {
  const win = { startMs: Date.UTC(2026, 9, 10, 21), endMs: Date.UTC(2026, 9, 11, 21) };
  for (const [id, q] of Object.entries(NETFLOW_QUERIES)) {
    const sql = bind(q.sql, win);
    assert.ok(!sql.includes('{FROM}') && !sql.includes('{TO}'), `${id}: unbound placeholder`);
    assert.ok(sql.includes(REAL), `${id}: must exclude the demo exporter`);
    assert.ok(/default\.flows(_5m0s|_1h0m0s)?\b/.test(sql), `${id}: reads a flows table`);
    assert.ok(!/\bflows_1m0s\b/.test(sql), `${id}: the 1-minute rollup is not used for daily reports`);
  }
  assert.match(bind('x {FROM} y {TO}', win, { macro: true }), /\$__fromTime y \$__toTime/);
  assert.match(bind('{FROM}', win), /toDateTime\(1791666000\)/);
});

test('queries: volumes are always scaled by SamplingRate', () => {
  for (const id of ['trend', 'trend_total', 'trend_prev', 'hourly', 'protocols', 'exporters', 'top_src', 'top_dst', 'top_conv', 'top_ports', 'by_site', 'by_isp', 'totals', 'totals_prev']) {
    assert.match(NETFLOW_QUERIES[id].sql, /Bytes \* SamplingRate/, id);
  }
});
