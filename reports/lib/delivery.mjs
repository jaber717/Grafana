// Delivery orchestration: duplicate protection, retries, partial delivery, logging.
//
// A delivery is identified by (report date, channel). The ledger file <ledgerDir>/<date>.<channel>.json records which UNITS were delivered
// (email: each recipient; telegram: the summary message and each document). A repeated run skips every delivered unit, so a timer that
// fires twice, a manual re-run or a retry after a partial failure never sends the same thing twice. --force deliberately resends.
//
//   sendBatch(pendingUnits) -> {done: [unit], failed: [{unit, transient, error, retryAfterS?}]}
//   transient failures are retried with exponential backoff (a Telegram retry_after wins when larger); permanent failures stop at once.
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const STALE_LOCK_MS = 30 * 60 * 1000;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function writeAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o640 });
  renameSync(tmp, path);
}

function acquire(lockPath, now) {
  try {
    closeSync(openSync(lockPath, 'wx'));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (now - statSync(lockPath).mtimeMs > STALE_LOCK_MS) { unlinkSync(lockPath); closeSync(openSync(lockPath, 'wx')); return true; }
    } catch { /* lost the race for the stale lock */ }
    return false;
  }
}

export async function deliver({
  ledgerDir, channel, reportDate, units, contentHash = null, sendBatch, force = false,
  retry = {}, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { attempts = 4, baseMs = 5000, maxMs = 120000 } = retry;
  mkdirSync(ledgerDir, { recursive: true, mode: 0o750 });
  const ledgerPath = join(ledgerDir, `${reportDate}.${channel}.json`);
  const lockPath = join(ledgerDir, `${reportDate}.${channel}.lock`);
  if (!acquire(lockPath, now())) {
    log({ event: 'skipped', channel, reportDate, reason: 'another delivery for this report is running' });
    return { status: 'locked', delivered: [], failed: [], attempts: 0 };
  }
  try {
    const led = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { reportDate, channel, delivered: [], contentHash: null, history: [] };
    if (force) led.delivered = [];
    if (!force && led.delivered.length && contentHash && led.contentHash && led.contentHash !== contentHash) {
      log({ event: 'content-changed', channel, reportDate, note: 'the report differs from what was delivered earlier; not resent - use force to resend' });
    }
    let pending = units.filter((u) => !led.delivered.includes(u));
    if (!pending.length) {
      log({ event: 'duplicate-skipped', channel, reportDate, units: units.length });
      return { status: 'duplicate', delivered: led.delivered, failed: [], attempts: 0 };
    }
    led.contentHash = led.contentHash || contentHash;
    let failed = [];
    let n = 0;
    while (n < attempts && pending.length) {
      n++;
      let res;
      try {
        res = await sendBatch(pending);
      } catch (e) {
        res = { done: [], failed: pending.map((unit) => ({ unit, transient: e.transient ?? true, error: e.message, retryAfterS: e.retryAfterS })) };
      }
      for (const u of res.done) if (!led.delivered.includes(u)) led.delivered.push(u);
      pending = pending.filter((u) => !res.done.includes(u));
      failed = res.failed || [];
      led.history.push({ at: new Date(now()).toISOString(), attempt: n, done: res.done, failed: failed.map((f) => ({ unit: f.unit, transient: f.transient, error: f.error })) });
      writeAtomic(ledgerPath, led);
      log({ event: 'attempt', channel, reportDate, attempt: n, delivered: res.done.length, failed: failed.length });
      if (!failed.length) break;
      const permanent = failed.filter((f) => !f.transient);
      pending = pending.filter((u) => !permanent.some((f) => f.unit === u));
      if (!pending.length) break;
      if (n < attempts) {
        const waitS = Math.max(...failed.filter((f) => f.transient).map((f) => f.retryAfterS || 0), 0);
        const wait = Math.min(maxMs, Math.max(baseMs * 2 ** (n - 1), waitS * 1000));
        log({ event: 'retry-wait', channel, reportDate, attempt: n, waitMs: wait });
        await sleep(wait);
      }
    }
    const delivered = units.filter((u) => led.delivered.includes(u));
    const status = delivered.length === units.length ? 'sent' : delivered.length ? 'partial' : 'failed';
    led.status = status;
    writeAtomic(ledgerPath, led);
    log({ event: 'result', channel, reportDate, status, delivered: delivered.length, total: units.length, attempts: n });
    return { status, delivered, failed, attempts: n };
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
