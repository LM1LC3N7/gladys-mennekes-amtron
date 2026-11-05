// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are 1.5 s,
// but it is the real clock: it moves between any two reads of it), against a
// real local TCP server answering Modbus TCP like the fake AMTRON: the polls
// really start at the interval, never sooner, on one connection at a time,
// and a pause goes at once. Everything is closed in `t.after` (a test that
// fails never leaves a timer or a server behind).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AmtronApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { SERIAL, fakeAmtron } from './fixtures/fakeAmtron.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { tcpServer } from './kit/tcp.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20: a poll every interval, one connection, a pause at once', async (t) => {
  const immediate = { setTimeout: (fn) => (fn(), 0), clearTimeout() {} };
  const dev = fakeAmtron({ timers: immediate });
  // The fake answers through a socket-like object: its answer is the TCP answer.
  const device = await tcpServer({
    onData: (chunk) =>
      new Promise((resolve) => {
        dev.handle({ destroyed: false, emit: (_event, data) => resolve(data) }, chunk);
      }),
    latencyMs: 2,
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new AmtronApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    readIdentity: dev.identityFn,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  t.after(async () => {
    spy.restore();
    app.shutdown();
    clock.close();
    await device.close();
  });
  await app.connected({ host: `127.0.0.1:${device.port}`, poll_interval: INTERVAL / 1000 });
  const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
  assert.equal(gaps.length, 2);
  assert.ok(device.peak <= 1, `${device.peak} connections at once`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const started = clock.monotonic();
  await app.setValue(undefined, {
    external_id: `ext:test-integration:mennekes-amtron:${SERIAL}:pause`,
  });
  assert.equal(dev.get(2000), 0);
  assert.ok(clock.monotonic() - started < 3500, 'within the ack budget');
  assert.ok(clock.timersSet < 300, `${clock.timersSet} timers`);
});
