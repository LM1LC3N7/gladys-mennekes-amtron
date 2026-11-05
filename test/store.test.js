// -----------------------------------------------------------------------------
// /data: repaired and bounded, an unreadable file never taken for an empty
// one, a special file (FIFO) never read nor written; the real file in a
// temporary directory, removed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(normalizeMemory({ stop }, NOW).stops, [stop], 'an older file: its single pause');
  assert.deepEqual(normalizeMemory({ stops: [stop, stop, { ...stop, host: 'b' }] }, NOW).stops, [
    stop,
    { ...stop, host: 'b' },
  ]);
  assert.equal(
    normalizeMemory({ stops: [{ ...stop, since: NOW + 60_000 }] }, NOW).stops[0].since,
    NOW,
  );
  assert.equal(normalizeMemory({ stops: [{ ...stop, host: 'a\nb' }] }, NOW).stops.length, 0);
  assert.equal(normalizeMemory({ stops: [{ ...stop, from: 0 }] }, NOW).stops[0].from, null);
  assert.equal(normalizeMemory({ stops: [{ ...stop, unitId: 2 }] }, NOW).stops.length, 0);
  assert.equal(
    normalizeMemory({ stops: [{ ...stop, written: 'yes' }] }, NOW).stops[0].written,
    false,
  );
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
  assert.deepEqual(normalizeMemory([], NOW).stops, []);
  assert.equal(normalizeMemory({ keepAlive: 10_000 }, NOW).keepAlive, 10_000);
  assert.equal(normalizeMemory({ keepAlive: 1000 }, NOW).keepAlive, null);
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
  const folder = join(dir, 'folder.json');
  await mkdir(folder);
  assert.deepEqual(
    await fileStore(folder).load(),
    { unreadable: true },
    'a directory is not a file',
  );
  // The temporary file of a save that is a FIFO is removed, never written into.
  execFileSync('mkfifo', [`${path}.tmp`]);
  await store.save({ stop });
  assert.deepEqual((await store.load()).data, { stop });
});

test('a stuck disk never piles writes up: one running, the last one waiting', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amtron-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  const saves = [];
  for (let i = 0; i < 50; i += 1) saves.push(store.save({ n: i }));
  await Promise.all(saves);
  assert.deepEqual((await store.load()).data, { n: 49 }, 'the last one wins');
  assert.ok(new Set(saves).size <= 3, `${new Set(saves).size} writes for 50 saves`);
});
