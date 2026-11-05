// -----------------------------------------------------------------------------
// /data: repaired and bounded, an unreadable file never taken for an empty
// one, a special file (FIFO) never read nor written; the real file in a
// temporary directory, removed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE as R } from '../src/constants.js';
import { fileStore, normalizeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 10, 5, 10);
const stop = {
  host: '192.168.1.80',
  port: 502,
  unitId: 1,
  since: NOW - 1000,
  written: true,
  from: 16,
};

test('a pause: kept when valid, its date never in the future, its limit of before a running one', () => {
  assert.deepEqual(normalizeMemory({ stop }, NOW).stop, stop);
  assert.equal(normalizeMemory({ stop: { ...stop, since: NOW + 60_000 } }, NOW).stop.since, NOW);
  assert.equal(normalizeMemory({ stop: { ...stop, host: 'a\nb' } }, NOW).stop, null);
  assert.equal(normalizeMemory({ stop: { ...stop, from: 0 } }, NOW).stop.from, null);
  assert.equal(normalizeMemory({ stop: { ...stop, unitId: 2 } }, NOW).stop, null);
  assert.equal(normalizeMemory({ stop: { ...stop, written: 'yes' } }, NOW).stop.written, false);
});

test('identity, counters and resume value: valid only', () => {
  const identity = {
    host: '192.168.1.80',
    port: 502,
    unitId: 1,
    serial: '1234567890',
    model: 'AMTRON 4You 560 11',
  };
  assert.deepEqual(normalizeMemory({ identity }, NOW).identity, identity);
  assert.equal(normalizeMemory({ identity: { ...identity, serial: '../x' } }, NOW).identity, null);
  const counters = {
    serial: '1234567890',
    guards: { [R.ENERGY_INDEX]: { last: { value: 10, at: NOW }, held: null } },
  };
  assert.deepEqual(normalizeMemory({ counters }, NOW).counters, counters);
  assert.equal(
    normalizeMemory(
      { counters: { ...counters, guards: { [R.ENERGY_INDEX]: { last: { value: 0, at: NOW } } } } },
      NOW,
    ).counters.guards[R.ENERGY_INDEX],
    undefined,
  );
  assert.deepEqual(normalizeMemory({ resume: { serial: '1234567890', current: 16 } }, NOW).resume, {
    serial: '1234567890',
    current: 16,
  });
  assert.equal(
    normalizeMemory({ resume: { serial: '1234567890', current: 40 } }, NOW).resume,
    null,
  );
  assert.equal(normalizeMemory({ lastAttemptAt: NOW + 5000 }, NOW).lastAttemptAt, NOW);
  assert.deepEqual(normalizeMemory([], NOW).stop, null);
});

test('the file: 0600, a round trip, unreadable is not empty, a FIFO never read nor written', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amtron-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ stop });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await store.load()).data, { stop });
  await writeFile(path, '{not json');
  assert.deepEqual(await store.load(), { unreadable: true });
  await writeFile(path, 'x'.repeat(20_000));
  assert.deepEqual(await store.load(), { unreadable: true });
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  const special = fileStore(fifo);
  assert.deepEqual(await special.load(), { unreadable: true }, 'a FIFO is never read');
  // The temporary file of a save that is a FIFO is removed, never written into.
  execFileSync('mkfifo', [`${path}.tmp`]);
  await store.save({ stop });
  assert.deepEqual((await store.load()).data, { stop });
});
