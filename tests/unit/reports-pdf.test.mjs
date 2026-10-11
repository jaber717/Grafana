import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChromiumCmd } from '../../reports/lib/pdf.mjs';

test('chromium command: a container invocation is split on spaces with placeholders substituted', () => {
  const argv = parseChromiumCmd('docker run --rm --user {uid}:{gid} -v {workdir}:{workdir} --entrypoint chromium img@sha256:abc', '/tmp/w');
  assert.equal(argv[0], 'docker');
  assert.ok(argv.includes('/tmp/w:/tmp/w'));
  assert.ok(argv.includes('chromium'));
  assert.ok(argv.some((x) => /^\d+:\d+$/.test(x)));
  assert.ok(!argv.some((x) => x.includes('{')));
});

test('chromium command: a plain executable path (even with spaces) is used as one program', () => {
  assert.deepEqual(parseChromiumCmd(process.execPath, '/tmp/w'), [process.execPath]);
});
