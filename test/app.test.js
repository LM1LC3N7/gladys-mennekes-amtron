// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, the exact wiring of the
// container, a fake AMTRON (Modbus and PublicInfo), the virtual clock of the
// kit (it moves at every read).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE as R } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, MODEL, NOW, SERIAL, fakeAmtron } from './fixtures/fakeAmtron.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, feature, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

/** Advances the clock by `step` until `cond()`, at most `rounds` times: throws then (never hangs). */
async function until(cond, advance, step, rounds) {
  for (let i = 0; i < rounds; i += 1) {
    if (cond()) return;
    await advance(step, step);
  }
  if (!cond()) throw new Error(`condition not met after ${rounds} steps of ${step} ms`);
}

const limitWrites = (dev) => dev.writes().filter((w) => w.address === 2000);
const pauses = (dev) => limitWrites(dev).filter((w) => w.value === 0);

test('a read: the device of its serial, the states, the badge, the status', async () => {
  const { gladys, state, stop, dev } = await setup();
  try {
    const device = gladys.fake.discoveredDevices[0];
    assert.equal(device.external_id, DEVICE);
    assert.ok(device.params.some((p) => p.name === 'AMTRON_SERIAL' && p.value === SERIAL));
    assert.equal(device.model, `MENNEKES ${MODEL}`);
    assert.equal(state(R.STATUS).text, 'Charging');
    assert.equal(state(R.CONNECTOR).state, 1);
    assert.equal(state(R.CHARGING_STATE).state, 0);
    assert.equal(state(R.PLUGGED).state, 1);
    assert.equal(state(R.ERROR).state, 0);
    assert.equal(state(R.PAUSED).state, 0);
    assert.equal(state(R.POWER).state, 11040);
    assert.equal(state(R.CURRENT_L2).state, 16);
    assert.equal(state(R.VOLTAGE_L3).state, 229);
    assert.equal(state(R.ENERGY_INDEX).state, 1234.567);
    assert.equal(state(R.SESSION_ENERGY).state, 5.432);
    assert.equal(state(R.SESSION_DURATION).state, 60);
    assert.equal(state(R.SIGNALED_CURRENT).state, 16);
    assert.equal(state(R.CURRENT_LIMIT).state, 16);
    assert.equal(state(R.SET_CURRENT).text, '16');
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.match(gladys.fake.connectionStatus.message.fr, new RegExp(SERIAL));
    assert.equal(dev.maxOpen, 1);
    assert.equal(dev.writes().length, 0);
    assert.equal(dev.infoCalls, 1);
    const select = device.features.find((f) => f.external_id === feature(R.SET_CURRENT));
    assert.deepEqual(
      select.supported_options.map((o) => o.value),
      ['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'],
    );
    for (const role of [R.PAUSE, R.RESUME, R.SET_CURRENT]) {
      const f = device.features.find((x) => x.external_id === feature(role));
      assert.notEqual(f.type, 'binary', `${role} is never a switch`);
    }
  } finally {
    stop();
  }
});

test('nothing published before the serial number is read; another serial is another device', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  dev.infoFails = true;
  const { gladys, stop, advance } = await setup({ clock, dev, create: false });
  try {
    assert.equal(gladys.fake.discoveredDevices.length, 0);
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.fr, /numéro de série n’a pas pu être lu/);
    // Failing: tried again with every read (one each), never more.
    const calls = dev.infoCalls;
    await advance(5 * MINUTE, 500);
    assert.ok(dev.infoCalls - calls <= 11, `${dev.infoCalls - calls} reads of PublicInfo in 5 min`);
    dev.infoFails = false;
    await advance(MINUTE + 5 * SECOND, 100);
    assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, DEVICE);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    // Another charger of the same model at the address: found at the next identity check.
    dev.info.serialNumber = 'OTHER0001';
    await advance(61 * MINUTE, 1000);
    assert.ok(
      gladys.fake.discoveredDevices.some((d) =>
        d.external_id.endsWith(':mennekes-amtron:OTHER0001'),
      ),
    );
  } finally {
    stop();
  }
});

test('a model that changed at the address: nothing published until the serial is read again', async () => {
  const { gladys, app, stop, dev, advance } = await setup();
  try {
    const calls = dev.infoCalls;
    dev.infoFails = true;
    dev.setModel('AMTRON 4Business 730');
    const count = gladys.fake.states.length;
    await advance(31 * SECOND, 100);
    assert.equal(gladys.fake.states.length, count, 'nothing published for an uncertain identity');
    assert.ok(dev.infoCalls > calls);
    assert.equal(app.unit.values, undefined);
    dev.infoFails = false;
    await advance(MINUTE + 5 * SECOND, 100);
    // The same serial: its device keeps going, the new model kept with it.
    assert.equal(app.memory.identity.model, 'AMTRON 4Business 730');
    assert.equal(app.unit.values.serial, SERIAL);
    assert.equal(gladys.fake.connectionStatus.connected, true);
  } finally {
    stop();
  }
});

test('a device that is not an AMTRON: nothing published, the status says why', async () => {
  const { gladys, stop, dev, advance, state } = await setup();
  try {
    dev.set(141, 0x5858);
    dev.set32(220, 4321);
    const count = gladys.fake.states.length;
    await advance(31 * SECOND, 100);
    assert.equal(gladys.fake.states.length, count);
    assert.notEqual(state(R.POWER).state, 4321);
    assert.match(gladys.fake.connectionStatus.message.fr, /ne se présente pas comme une AMTRON/);
  } finally {
    stop();
  }
});

test('the pause: without the option, confirmed by the read back, within the ack budget', async () => {
  const { app, fire, stop, dev, advance, state, clock } = await setup();
  try {
    const started = clock.monotonic();
    const ack = fire(R.PAUSE, 1);
    await advance(3500, 10);
    ok(await ack);
    assert.ok(clock.monotonic() - started <= 3600);
    assert.equal(dev.get(2000), 0);
    assert.deepEqual(
      dev.writes().map((w) => [w.fc, w.address, w.value]),
      [[6, 2000, 0]],
    );
    assert.equal(app.stopGuard, undefined);
    await advance(10 * SECOND, 100);
    assert.equal(state(R.PAUSED).state, 1);
    assert.equal(state(R.CURRENT_LIMIT).state, 0);
    // Any value of the button pauses (never refused for its value).
    const again = fire(R.PAUSE, 'anything');
    await advance(4 * SECOND, 50);
    ok(await again);
  } finally {
    stop();
  }
});

test('a pause not applied is written again every 15 s, kept in /data, never ended by time', async () => {
  const store = memoryStore();
  const { app, press, stop, dev, advance } = await setup({ store });
  try {
    dev.ignoreWrites = true;
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    assert.ok(app.stopGuard);
    assert.equal(store.data.stops[0].from, 16);
    const before = pauses(dev).length;
    await advance(10 * MINUTE, 100);
    assert.ok(pauses(dev).length - before >= 30, `${pauses(dev).length - before} rewrites`);
    assert.ok(app.stopGuard, 'never ended by time');
    dev.ignoreWrites = false;
    await advance(20 * SECOND, 100);
    assert.equal(app.stopGuard, undefined);
    assert.deepEqual(store.data.stops, []);
  } finally {
    stop();
  }
});

test('/data stuck: several pauses still leave at once, the checks keep their pace, the reads go on', async () => {
  const store = memoryStore();
  const { app, fire, stop, dev, advance, clock } = await setup({ store });
  try {
    store.hang = new Promise(() => {});
    dev.ignoreWrites = true;
    // The first byte of a pause never waits for the stuck /data longer than 200 ms.
    const first = fire(R.PAUSE, 1);
    await advance(400, 10);
    assert.equal(pauses(dev).length, 1, 'left within 400 ms of the click');
    await advance(4 * SECOND, 50);
    refused(await first, /sans confirmation/);
    const acks = [fire(R.PAUSE, 1)];
    await advance(4 * SECOND, 50);
    acks.push(fire(R.PAUSE, 1));
    await advance(4 * SECOND, 50);
    for (const ack of acks) refused(await ack, /sans confirmation/);
    assert.ok(pauses(dev).length >= 3, `${pauses(dev).length} pauses left`);
    // The checks: every 15 s, the next one armed before any save (never 15 s + a stuck save).
    const times = [];
    let count = pauses(dev).length;
    for (let i = 0; i < 600; i += 1) {
      await advance(100, 100);
      if (pauses(dev).length !== count) {
        count = pauses(dev).length;
        times.push(clock.monotonic());
      }
    }
    assert.ok(times.length >= 3, 'checked and written again with /data stuck');
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(
        times[i] - times[i - 1] <= 15_600,
        `${times[i] - times[i - 1]} ms between two checks`,
      );
    }
    assert.ok(app.stopGuard);
    // The reads go on (each waits 2 s at most for the stuck /data).
    await advance(2 * MINUTE, 500);
    const reads = dev.reads().filter((r) => r.address === 141).length;
    await advance(2 * MINUTE, 500);
    assert.ok(dev.reads().filter((r) => r.address === 141).length > reads, 'the reads go on');
  } finally {
    stop();
  }
});

test('after a restart, a pause kept in /data is written before the configuration is read', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  const store = memoryStore({
    stop: { host: HOST, port: 502, unitId: 1, since: NOW - MINUTE, written: true, from: 16 },
  });
  const { stop } = await setup({ clock, dev, store, boot: true, getConfigFails: 3 });
  try {
    assert.equal(dev.get(2000), 0);
    assert.equal(dev.writes()[0].address, 2000);
    assert.equal(dev.writes()[0].value, 0);
  } finally {
    stop();
  }
});

test('a pause never sent (charger down) is kept, retried every 15 s, never abandoned, then applied', async () => {
  const store = memoryStore();
  const { app, fire, stop, dev, advance } = await setup({ store });
  try {
    dev.down = true;
    const ack = fire(R.PAUSE, 1);
    await advance(5 * SECOND, 50);
    refused(await ack, /pas encore pu partir/);
    assert.equal(store.data.stops.length, 1);
    assert.equal(store.data.stops[0].written, false);
    await advance(30 * MINUTE, 1000);
    assert.ok(app.stopGuard, 'still held while the charger is down, whatever the time');
    dev.down = false;
    await advance(20 * SECOND, 100);
    assert.equal(dev.get(2000), 0);
    assert.equal(app.stopGuard, undefined);
  } finally {
    stop();
  }
});

test('the pause goes whatever: read stuck, backoff, queue full, identity unreadable', async () => {
  const { app, fire, press, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    // A read stuck on a silent block: the pause ends it and goes.
    dev.silent.add(200);
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    const reading = app.tick();
    await advance(200, 10);
    dev.silent.clear();
    const quick = fire(R.PAUSE, 1);
    await advance(400, 10);
    assert.equal(dev.get(2000), 0, 'written within 400 ms');
    await advance(5 * SECOND, 50);
    ok(await quick);
    await advance(SECOND);
    await reading;
    // Backoff: the charger was down for the reads, back for the pause.
    dev.set(2000, 16);
    dev.down = true;
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    const failing = app.tick();
    await advance(SECOND);
    await failing;
    assert.equal(app.unit.online, false);
    dev.down = false;
    dev.infoFails = true;
    ok(await press(R.PAUSE, 1));
    assert.equal(dev.get(2000), 0);
    // Queue full of slow commands: the pause still goes, at once.
    dev.infoFails = false;
    dev.delay = 100;
    const acks = [];
    for (let i = 0; i < 20; i += 1) acks.push(fire(R.SET_CURRENT, String(6 + (i % 5))));
    await advance(50, 10);
    const full = await Promise.race([
      Promise.all(acks.slice(17)),
      new Promise((r) => setImmediate(r)),
    ]);
    assert.ok(full, 'the commands beyond the queue are refused at once');
    for (const ack of full) refused(ack, /Trop de commandes/);
    const paused = fire(R.PAUSE, 1);
    await advance(5 * SECOND, 50);
    ok(await paused);
    assert.equal(dev.get(2000), 0);
    await advance(20 * SECOND, 100);
    await Promise.all(acks);
    assert.equal(dev.maxOpen, 1);
  } finally {
    stop();
  }
});

test('nothing clicked before a pause leaves after it', async () => {
  const { fire, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.delay = 200;
    const current = fire(R.SET_CURRENT, '10');
    await advance(150, 10);
    const paused = fire(R.PAUSE, 1);
    await advance(10 * SECOND, 50);
    ok(await paused);
    refused(await current);
    const writes = limitWrites(dev);
    const at = writes.findIndex((w) => w.value === 0);
    assert.ok(at >= 0);
    assert.equal(writes.slice(at + 1).length, 0, 'nothing after the pause');
    assert.equal(dev.get(2000), 0);
  } finally {
    stop();
  }
});

test('a pause is let go when another limit set elsewhere is read twice in a row', async () => {
  const { app, press, stop, dev, advance } = await setup();
  try {
    dev.ignoreWrites = true;
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    assert.equal(app.stopGuard.from, 16);
    dev.ignoreWrites = false;
    // Another energy manager sets 10 A.
    dev.set(2000, 10);
    const before = dev.writes().length;
    await advance(20 * SECOND, 100);
    assert.equal(app.stopGuard, undefined);
    assert.equal(dev.writes().length, before, 'never written over a change made elsewhere');
    assert.equal(dev.get(2000), 10);
  } finally {
    stop();
  }
});

test('a pause clicked while the configuration cannot be read goes to the charger of the last read', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  const store = memoryStore({ target: { host: HOST, port: 502, unitId: 1 } });
  const { press, stop } = await setup({ clock, dev, store, getConfigFails: 100, create: false });
  try {
    ok(await press(R.PAUSE, 1));
    assert.equal(dev.get(2000), 0);
  } finally {
    stop();
  }
});

test('resume: refused without the option; with it, the current read before the pause', async () => {
  const { app, press, fire, stop, dev, advance } = await setup();
  try {
    ok(await press(R.PAUSE, 1));
    const opened = [dev.connections, dev.infoCalls];
    // Refused at once, before any connection (no clock advance needed).
    refused(await fire(R.RESUME, 1), /désactivés/);
    assert.deepEqual(
      [dev.connections, dev.infoCalls],
      opened,
      'refused on arrival, nothing opened',
    );
    assert.equal(dev.get(2000), 0);
    await app.configUpdated(ALLOW);
    ok(await press(R.RESUME, 1));
    assert.equal(dev.get(2000), 16);
    // Not paused: nothing sent.
    const count = dev.writes().length;
    ok(await press(R.RESUME, 1));
    assert.equal(dev.writes().length, count);
    refused(await press(R.RESUME, 0), /Valeur inattendue/);
    await advance(SECOND);
  } finally {
    stop();
  }
});

test('resume without a current read before: refused, nothing sent', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  dev.set(2000, 0);
  const { press, stop } = await setup({ clock, dev, config: ALLOW });
  try {
    refused(await press(R.RESUME, 1), /Aucun courant de charge/);
    assert.equal(dev.writes().length, 0);
  } finally {
    stop();
  }
});

test('the charging current: bounded on arrival, by the model and the minimum read', async () => {
  const { press, fire, stop, dev, state, advance } = await setup({ config: ALLOW });
  try {
    const opened = [dev.connections, dev.infoCalls];
    refused(await fire(R.SET_CURRENT, '33'), /entre 6 A et 16 A/);
    assert.deepEqual(
      [dev.connections, dev.infoCalls],
      opened,
      'refused on arrival, nothing opened',
    );
    refused(await press(R.SET_CURRENT, '5'), /entre 6 A et 16 A/);
    refused(await press(R.SET_CURRENT, '10.5'), /nombre entier/);
    refused(await press(R.SET_CURRENT, ' 10'), /nombre entier/);
    ok(await press(R.SET_CURRENT, '10'));
    assert.equal(dev.get(2000), 10);
    await advance(20 * SECOND, 100);
    assert.equal(state(R.SET_CURRENT).text, '10');
    // The minimum read on the charger raises the floor.
    dev.set(712, 8);
    refused(await press(R.SET_CURRENT, '7'), /entre 8 A et 16 A/);
    assert.equal(dev.get(2000), 10);
    // A 22 kW model: still 16 A at most (the document says 6 A to 16 A).
    dev.maxCurrent = 32;
    dev.setModel('AMTRON 4You 560 22');
    await advance(2 * MINUTE, 500);
    refused(await press(R.SET_CURRENT, '20'), /entre 6 A et 16 A/);
    ok(await press(R.SET_CURRENT, '16'));
    assert.equal(dev.get(2000), 16);
    assert.ok(limitWrites(dev).every((w) => w.value === 0 || (w.value >= 6 && w.value <= 16)));
  } finally {
    stop();
  }
});

test('commands: refused in read-only HEMS mode, with the identity unreadable, for another charger', async () => {
  const { press, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.set(2010, 1);
    refused(await press(R.SET_CURRENT, '10'), /HEMS lecture et écriture/);
    dev.set(2010, 2);
    dev.infoFails = true;
    refused(await press(R.SET_CURRENT, '10'), /numéro de série de la borne n’a pas pu être lu/);
    dev.infoFails = false;
    dev.info.serialNumber = 'OTHER0001';
    refused(await press(R.SET_CURRENT, '10'), /autre borne/);
    dev.info.serialNumber = SERIAL;
    dev.setModel('AMTRON 4Business 730');
    refused(await press(R.SET_CURRENT, '10'), /autre borne/);
    assert.equal(dev.writes().length, 0);
    await advance(SECOND);
  } finally {
    stop();
  }
});

test('the option is checked again right before the write', async () => {
  const { app, fire, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.delay = 300;
    const ack = fire(R.SET_CURRENT, '10');
    await advance(400, 10);
    await app.configUpdated(CFG);
    await advance(5 * SECOND, 50);
    refused(await ack, /désactivés|configuration a changé/);
    assert.equal(dev.writes().length, 0, 'nothing written after the option was turned off');
  } finally {
    stop();
  }
});

test('a command while a pause runs is refused; a newer current that left ends the pause held', async () => {
  const { app, fire, press, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.delay = 300;
    const paused = fire(R.PAUSE, 1);
    await advance(50, 10);
    refused(await fire(R.SET_CURRENT, '10'), /pause est en cours/);
    await advance(5 * SECOND, 50);
    ok(await paused);
    dev.delay = 10;
    dev.ignoreWrites = true;
    dev.set(2000, 16);
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    assert.ok(app.stopGuard);
    dev.ignoreWrites = false;
    ok(await press(R.SET_CURRENT, '12'));
    assert.equal(app.stopGuard, undefined);
    assert.equal(dev.get(2000), 12);
    await advance(MINUTE, 100);
    assert.equal(dev.get(2000), 12, 'the older pause is never written again');
  } finally {
    stop();
  }
});

test('a write acknowledged but not applied: "sent, without confirmation", never success', async () => {
  const { press, stop, dev } = await setup({ config: ALLOW });
  try {
    dev.ignoreWrites = true;
    refused(await press(R.SET_CURRENT, '10'), /Envoyée, sans confirmation/);
    dev.ignoreWrites = false;
    dev.silent.add(2000);
    refused(
      await press(R.SET_CURRENT, '11'),
      /Rien envoyé|Envoyée, sans confirmation|état de la borne/,
    );
    dev.silent.clear();
    dev.down = true;
    refused(await press(R.SET_CURRENT, '12'), /Rien envoyé|numéro de série/);
  } finally {
    stop();
  }
});

test('a read begun before a command left is never applied', async () => {
  const { app, gladys, fire, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    // A read starts and is slow; a command takes the line, the read is dropped.
    dev.delay = 200;
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    const reading = app.tick();
    await advance(100, 10);
    const ack = fire(R.SET_CURRENT, '9');
    await advance(10 * SECOND, 50);
    ok(await ack);
    await reading;
    const limits = gladys.fake.states
      .filter((s) => s.device_feature_external_id === feature(R.CURRENT_LIMIT))
      .map((s) => s.state);
    assert.equal(limits.at(-1), 9, 'never the limit of before published after the command');
  } finally {
    stop();
  }
});

test('the configuration cannot be read in `connected`: tried again forever, then the charger is read', async () => {
  const { gladys, stop, advance, dev } = await setup({ getConfigFails: 3, create: false });
  try {
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
    assert.equal(dev.connections, 0);
    await advance(2 * MINUTE, 100);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.ok(dev.connections > 0);
  } finally {
    stop();
  }
});

test('the energy index: never 0, a drop or a jump held (status), accepted in two presses only', async () => {
  const store = memoryStore();
  const { gladys, app, stop, dev, advance, state } = await setup({ store });
  try {
    const published = () =>
      gladys.fake.states
        .filter((s) => s.device_feature_external_id === feature(R.ENERGY_INDEX))
        .map((s) => s.state);
    assert.equal(state(R.ENERGY_INDEX).state, 1234.567);
    dev.set32(218, 0);
    await advance(31 * SECOND, 100);
    assert.ok(!published().includes(0));
    dev.set32(218, 10000);
    await advance(31 * SECOND, 100);
    assert.ok(!published().includes(10));
    assert.match(gladys.fake.connectionStatus.message.fr, /baissé de 1234\.567 kWh à 10 kWh/);
    assert.equal(store.data.counters.guards[R.ENERGY_INDEX].held.to, 10);
    await advance(10 * MINUTE, 500);
    assert.ok(!published().includes(10), 'held, whatever the time');
    const first = await app.acceptIndex();
    assert.match(first.fr, /1234\.567 kWh → 10 kWh/);
    // Too soon: a double click is not a confirmation.
    assert.match((await app.acceptIndex()).fr, /Retenu/);
    await advance(5 * SECOND, 100);
    assert.match((await app.acceptIndex()).fr, /Index accepté/);
    await advance(31 * SECOND, 100);
    assert.equal(state(R.ENERGY_INDEX).state, 10);
    assert.doesNotMatch(gladys.fake.connectionStatus.message.fr, /baissé/);
    dev.set32(218, 9_000_000);
    await advance(31 * SECOND, 100);
    assert.ok(!published().includes(9000));
    assert.match(gladys.fake.connectionStatus.message.fr, /sauté de 10 kWh à 9000 kWh/);
    assert.match((await app.acceptIndex()).fr, /Aucun|Retenu/);
  } finally {
    stop();
  }
});

test('never read sooner than the interval: button, scan, reconnection, restart', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const first = await setup({ clock, store });
  const reads = () => first.dev.reads().filter((r) => r.address === 141).length;
  try {
    assert.equal(reads(), 1);
    const answer = await first.app.testConnection();
    assert.match(answer.fr, /Prochaine lecture de la borne dans/);
    await first.gladys.fake.scanRequest();
    await first.app.connected({ host: HOST });
    await first.advance(20 * SECOND, 100);
    assert.equal(reads(), 1);
    await first.advance(15 * SECOND, 100);
    assert.equal(reads(), 2);
  } finally {
    first.stop();
  }
  const second = await setup({ clock, store });
  try {
    assert.equal(second.dev.reads().length, 0);
    await second.advance(MINUTE + 31 * SECOND, 100);
    assert.ok(second.dev.reads().length > 0);
  } finally {
    second.stop();
  }
});

test('/data unreadable is never overwritten and keeps no identity; a failed save never blocks the pause', async () => {
  const store = memoryStore(
    { identity: { host: HOST, port: 502, unitId: 1, serial: 'KEPT0001', model: MODEL } },
    { unreadable: true },
  );
  const { app, press, stop, dev } = await setup({ store, config: ALLOW });
  try {
    ok(await press(R.PAUSE, 1));
    assert.equal(store.saves, 0);
    assert.equal(store.data.identity.serial, 'KEPT0001', 'never overwritten');
    assert.equal(dev.get(2000), 0);
    assert.equal(app.memoryUnreadable, true);
  } finally {
    stop();
  }
  const failing = memoryStore(null, { failSave: true });
  const again = await setup({ store: failing, config: ALLOW });
  try {
    ok(await again.press(R.PAUSE, 1));
    assert.equal(again.dev.get(2000), 0);
    ok(await again.press(R.RESUME, 1));
    assert.equal(again.dev.get(2000), 16);
  } finally {
    again.stop();
  }
});

test('a scene setting five currents on a slow charger: in order, the last one wins, one connection', async () => {
  const { fire, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.delay = 150;
    const acks = ['8', '9', '10', '11', '12'].map((v) => fire(R.SET_CURRENT, v));
    await advance(20 * SECOND, 50);
    for (const ack of acks) {
      const a = await ack;
      assert.ok(a.success || /attente|sans confirmation/.test(String(a.error)), String(a.error));
    }
    assert.deepEqual(
      limitWrites(dev).map((w) => w.value),
      [8, 9, 10, 11, 12],
    );
    assert.equal(dev.get(2000), 12);
    assert.equal(dev.maxOpen, 1);
  } finally {
    stop();
  }
});

test('a device created: its recent values at once, never an old read', async () => {
  const { gladys, app, stop, advance } = await setup({ create: false });
  try {
    await advance(3 * MINUTE, 500);
    app.unit.readAt = app.mono() - 3 * MINUTE;
    const count = gladys.fake.states.length;
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await advance(2 * SECOND, 100);
    assert.equal(gladys.fake.states.length, count);
  } finally {
    stop();
  }
});

test('an optional block refused never blocks the values; a firmware without it skips it', async () => {
  const { gladys, app, stop, dev, advance, state } = await setup();
  try {
    dev.exceptions.set(716, 4);
    dev.set32(220, 7000);
    await advance(31 * SECOND, 100);
    assert.equal(state(R.POWER).state, 7000);
    assert.match(gladys.fake.connectionStatus.message.fr, /Non lu cette fois : session/);
    // Never served by this firmware (illegal data address before any answer): skipped.
    app.answered.delete('protocol');
    dev.exceptions.set(120, 2);
    await advance(31 * SECOND, 100);
    assert.ok(app.absent.has('protocol'));
    // A text value is never a measure: an unknown status is not published as 0.
    dev.set(104, 42);
    await advance(31 * SECOND, 100);
    assert.equal(state(R.STATUS).text, 'Charging');
  } finally {
    stop();
  }
});

test('paused with a Safe Current: read at least every half communication timeout, the status warns', async () => {
  const { gladys, press, stop, dev, advance } = await setup({
    config: { host: HOST, poll_interval: 120 },
  });
  try {
    dev.set(132, 20);
    ok(await press(R.PAUSE, 1));
    await advance(30 * SECOND, 100);
    const before = dev.reads().filter((r) => r.address === 141).length;
    await advance(MINUTE, 100);
    const reads = dev.reads().filter((r) => r.address === 141).length - before;
    assert.ok(reads >= 5, `${reads} reads in a minute with a 20 s timeout`);
    assert.match(gladys.fake.connectionStatus.message.fr, /Safe Current \(16 A/);
    // Safe Current at 0: the pause holds without Gladys, the interval of the configuration.
    dev.set(131, 0);
    await advance(30 * SECOND, 100);
    const after = dev.reads().filter((r) => r.address === 141).length;
    await advance(MINUTE, 100);
    assert.ok(dev.reads().filter((r) => r.address === 141).length - after <= 1);
  } finally {
    stop();
  }
});

test('read-only HEMS mode: the status says so, the pause is still sent and refused by the charger', async () => {
  const { gladys, press, stop, dev, advance } = await setup();
  try {
    dev.set(2010, 1);
    await advance(31 * SECOND, 100);
    assert.match(gladys.fake.connectionStatus.message.fr, /HEMS lecture et écriture/);
    refused(await press(R.PAUSE, 1), /refusé la pause/);
    assert.equal(pauses(dev).length, 1, 'sent');
  } finally {
    stop();
  }
});

test('PublicInfo failing never blocks the readings of a known charger; read again after an outage', async () => {
  const { app, gladys, stop, dev, advance, state } = await setup();
  try {
    dev.infoFails = true;
    dev.set32(220, 5000);
    await advance(61 * MINUTE, 1000);
    assert.equal(state(R.POWER).state, 5000, 'published all along');
    assert.equal(gladys.fake.connectionStatus.connected, true);
    dev.infoFails = false;
    await advance(2 * MINUTE, 500);
    const calls = dev.infoCalls;
    // An outage: the serial number is read again once the charger answers.
    dev.down = true;
    await advance(MINUTE, 500);
    assert.equal(app.unit.online, false);
    dev.down = false;
    await advance(3 * MINUTE, 500);
    assert.equal(app.unit.online, true);
    assert.ok(dev.infoCalls > calls, 'read again after the outage');
  } finally {
    stop();
  }
});

test('a single read of another limit never lets the pause go: written again over the limit of before', async () => {
  const { app, press, stop, dev, advance } = await setup();
  try {
    dev.ignoreWrites = true;
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    assert.equal(app.stopGuard.from, 16);
    // 10 A for one read only (a glitch), then the limit of before again.
    await advance(4 * SECOND, 100);
    dev.set(2000, 10);
    await advance(SECOND, 100);
    await until(() => app.stopGuard?.other !== undefined || !app.stopGuard, advance, 100, 300);
    dev.set(2000, 16);
    const before = pauses(dev).length;
    await advance(20 * SECOND, 100);
    assert.ok(app.stopGuard, 'still held');
    assert.ok(pauses(dev).length > before, 'written again');
  } finally {
    stop();
  }
});

test('resume: the current of before bounded by the ceiling of now', async () => {
  const { app, press, stop, dev } = await setup();
  try {
    ok(await press(R.PAUSE, 1));
    await app.configUpdated({ ...ALLOW, max_current: 10 });
    ok(await press(R.RESUME, 1));
    assert.equal(dev.get(2000), 10, '16 A read before, 10 A at most now');
  } finally {
    stop();
  }
});

test('the option turned off at the last instant: checked again right before the byte leaves', async () => {
  const { app, fire, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    // Turned off synchronously after the last checks of the session, before the write.
    const ceilingFor = app.ceilingFor.bind(app);
    app.ceilingFor = (model) => {
      app.config = { ...app.config, allowCommands: false };
      return ceilingFor(model);
    };
    const ack = fire(R.SET_CURRENT, '10');
    await advance(5 * SECOND, 50);
    refused(await ack, /désactivés/);
    assert.equal(dev.writes().length, 0);
  } finally {
    stop();
  }
});

test('a read that began before the last write left is never applied', async () => {
  const { app, stop, dev, advance, state } = await setup();
  try {
    dev.set32(220, 2222);
    app.lastSentAt = app.mono() + 10 * MINUTE;
    await advance(31 * SECOND, 100);
    assert.notEqual(state(R.POWER).state, 2222);
    app.lastSentAt = -Infinity;
    await advance(31 * SECOND, 100);
    assert.equal(state(R.POWER).state, 2222);
  } finally {
    stop();
  }
});

test('/data stuck: the next check of a pause is armed before any save (15 s, never 15 s + the save)', async () => {
  const gaps = async (prepare) => {
    const store = memoryStore();
    const t = await setup({ store });
    try {
      store.hang = new Promise(() => {});
      t.dev.ignoreWrites = true;
      await prepare(t);
      const times = [];
      let count = pauses(t.dev).length;
      if (count > 0) times.push(t.clock.monotonic());
      for (let i = 0; i < 400 && times.length < 3; i += 1) {
        await t.advance(100, 100);
        if (pauses(t.dev).length !== count) {
          count = pauses(t.dev).length;
          times.push(t.clock.monotonic());
        }
      }
      return times.slice(1).map((at, i) => at - times[i]);
    } finally {
      t.stop();
    }
  };
  // After a click whose write left (sendStop saves the new state).
  for (const gap of await gaps(async (t) => {
    t.fire(R.PAUSE, 1);
    await until(() => pauses(t.dev).length > 0, t.advance, 10, 1000);
  })) {
    assert.ok(gap <= 15_600, `${gap} ms after the click`);
  }
  // After a pause that could not leave, then written by a check (runCheck saves the new state).
  for (const gap of await gaps(async (t) => {
    t.dev.down = true;
    t.fire(R.PAUSE, 1);
    await t.advance(5 * SECOND, 50);
    t.dev.down = false;
    await until(() => pauses(t.dev).length > 0, t.advance, 100, 600);
  })) {
    assert.ok(gap <= 15_600, `${gap} ms between two checks`);
  }
});

test('PublicInfo that never answers: the command is refused within the ack budget, the reads go on', async () => {
  const { fire, stop, dev, advance, state } = await setup({ config: ALLOW });
  try {
    dev.infoDelay = 10 * 60 * 1000;
    const ack = fire(R.SET_CURRENT, '10');
    await advance(3500, 10);
    refused(await ack, /numéro de série de la borne n’a pas pu être lu/);
    assert.equal(dev.writes().length, 0);
    dev.set32(220, 3333);
    await advance(2 * MINUTE, 500);
    assert.equal(state(R.POWER).state, 3333);
  } finally {
    stop();
  }
});

test('the pause is in /data before its first byte leaves', async () => {
  const store = memoryStore();
  const { fire, stop, dev, advance } = await setup({ store });
  try {
    const save = store.save.bind(store);
    let writesAtSave;
    store.save = async (data) => {
      if (data.stops?.length > 0 && writesAtSave === undefined) writesAtSave = pauses(dev).length;
      return save(data);
    };
    dev.ignoreWrites = true;
    fire(R.PAUSE, 1);
    await advance(5 * SECOND, 50);
    assert.equal(writesAtSave, 0, 'saved before the write');
    assert.ok(pauses(dev).length >= 1);
  } finally {
    stop();
  }
});

test('a minimum current above the ceiling: every current refused, nothing sent', async () => {
  const { app, press, stop, dev } = await setup({ config: { ...ALLOW, max_current: 10 } });
  try {
    dev.set(712, 12);
    refused(await press(R.SET_CURRENT, '10'), /entre 12 A et 10 A/);
    ok(await press(R.PAUSE, 1));
    refused(await press(R.RESUME, 1), /entre 12 A et 10 A/);
    assert.deepEqual(
      dev.writes().map((w) => w.value),
      [0],
    );
    assert.equal(app.config.maxCurrent, 10);
  } finally {
    stop();
  }
});

test('r1 B1: a /data slow to read (3 s) still gives its pause, written as soon as it is read', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  const store = memoryStore({
    stops: [{ host: HOST, port: 502, unitId: 1, since: NOW - MINUTE, written: true, from: 16 }],
  });
  let release;
  store.hangLoad = new Promise((resolve) => {
    release = resolve;
  });
  clock.timers.setTimeout(() => release(), 3000);
  const { app, stop, advance } = await setup({ clock, dev, store, boot: true, getConfigFails: 3 });
  try {
    await advance(5 * SECOND, 50);
    assert.equal(app.memoryUnreadable, true, 'too slow: never overwritten');
    assert.equal(dev.get(2000), 0, 'the pause kept in /data left');
    assert.equal(dev.writes()[0].value, 0);
  } finally {
    stop();
  }
});

test('r1 I1: the keep-alive holds after a failed read, with 131/132 unread, and across a restart', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const reads141 = (dev) => dev.log.filter((r) => r.fc === 3 && r.address === 141).length;
  const first = await setup({ clock, store, config: { host: HOST, poll_interval: 300 } });
  try {
    first.dev.set(132, 20);
    ok(await first.press(R.PAUSE, 1));
    await first.advance(30 * SECOND, 100);
    assert.equal(first.app.keepAlive, 10_000);
    // (a) A failed read: the next try within the keep-alive, not after the 30 s backoff.
    first.dev.down = true;
    await first.advance(11 * SECOND, 100);
    assert.equal(first.app.unit.online, false);
    first.dev.down = false;
    const before = reads141(first.dev);
    await first.advance(6 * SECOND, 100);
    assert.ok(reads141(first.dev) > before, 'tried again within 5 s after a failure');
    // (b) 131/132 refused (and later skipped): the keep-alive stays.
    first.dev.exceptions.set(131, 4);
    await first.advance(2 * MINUTE, 500);
    assert.equal(first.app.keepAlive, 10_000);
    const mid = reads141(first.dev);
    await first.advance(MINUTE, 500);
    assert.ok(reads141(first.dev) - mid >= 5, 'still every 10 s');
    first.dev.exceptions.delete(131);
    assert.equal(store.data.keepAlive, 10_000);
  } finally {
    first.stop();
  }
  // (c) A restart: the first read comes within the keep-alive kept in /data.
  const second = await setup({
    clock,
    store,
    config: { host: HOST, poll_interval: 300 },
    create: false,
  });
  try {
    await second.advance(SECOND, 100);
    assert.ok(reads141(second.dev) > 0, 'read at once after the restart');
  } finally {
    second.stop();
  }
});

test('r1 I1: the keep-alive never goes under 5 s', async () => {
  const { app, press, stop, dev, advance } = await setup({
    config: { host: HOST, poll_interval: 300 },
  });
  try {
    dev.set(132, 4);
    ok(await press(R.PAUSE, 1));
    await advance(30 * SECOND, 100);
    assert.equal(app.keepAlive, 5000);
    const before = dev.reads().filter((r) => r.address === 141).length;
    await advance(MINUTE, 100);
    const reads = dev.reads().filter((r) => r.address === 141).length - before;
    assert.ok(reads >= 10 && reads <= 13, `${reads} reads in a minute`);
  } finally {
    stop();
  }
});

/** Two chargers, A at HOST and B at another address, behind one connector. */
function twoChargers(clock) {
  const a = fakeAmtron({ timers: clock.timers });
  const b = fakeAmtron({ timers: clock.timers });
  b.info.serialNumber = 'BBBB0002';
  b.set(2000, 10);
  return {
    a,
    b,
    connectFn: (host) => (host === HOST ? a : b).connect(),
    identityFn: ({ host }) => (host === HOST ? a : b).readIdentity(),
    log: [],
    writes: () => [...a.writes(), ...b.writes()],
  };
}

test('r1 I2: a pause held for the old address survives a click to the new one; its values never shown there', async () => {
  const clock = testClock({ start: NOW });
  const both = twoChargers(clock);
  const store = memoryStore();
  const { app, gladys, press, stop, advance } = await setup({
    clock,
    dev: both,
    store,
    config: ALLOW,
  });
  try {
    both.a.down = true;
    refused(await press(R.PAUSE, 1), /pas encore pu partir/);
    const saving = app.configUpdated({ ...ALLOW, host: '192.168.1.81' });
    await advance(5 * SECOND, 100);
    await saving;
    const bDevice = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(':BBBB0002'));
    assert.ok(bDevice);
    await gladys.fake.deviceCreated(bDevice);
    // A command and a pause to B: the pause of A is kept.
    const bFeature = (role) => ({ external_id: `${bDevice.external_id}:${role}` });
    let ack = gladys.fake.setValue(bDevice, bFeature(R.SET_CURRENT), '8');
    await advance(5 * SECOND, 50);
    ok(await ack);
    assert.equal(both.b.get(2000), 8);
    ack = gladys.fake.setValue(bDevice, bFeature(R.PAUSE), 1);
    await advance(5 * SECOND, 50);
    ok(await ack);
    assert.equal(app.stopGuards.size, 1, 'the pause of A is still held');
    assert.equal(store.data.stops[0].host, HOST);
    // A comes back: its pause is written; its limit (16 A) never shown on B.
    both.b.set(2000, 12);
    await advance(MINUTE, 100);
    const limitsOf = () =>
      gladys.fake.states
        .filter((x) => x.device_feature_external_id === `${bDevice.external_id}:${R.CURRENT_LIMIT}`)
        .map((x) => x.state);
    const seen = limitsOf().length;
    assert.equal(limitsOf().at(-1), 12);
    both.a.down = false;
    await advance(MINUTE, 100);
    assert.equal(both.a.get(2000), 0);
    const later = limitsOf().slice(seen);
    assert.ok(
      later.every((v) => v === 12),
      `B showed ${later} (the limits of A)`,
    );
  } finally {
    stop();
  }
});

test('r1 I3: with a pause held, "current" and "resume" write (never "already done"), and the pause lets go', async () => {
  for (const [role, value] of [
    [R.SET_CURRENT, '16'],
    [R.RESUME, 1],
  ]) {
    const { app, press, stop, dev, advance } = await setup({ config: ALLOW });
    try {
      dev.ignoreWrites = true;
      refused(await press(R.PAUSE, 1), /sans confirmation/);
      assert.ok(app.stopGuard);
      dev.ignoreWrites = false;
      const count = limitWrites(dev).length;
      ok(await press(role, value));
      assert.ok(limitWrites(dev).length > count, `${role}: written`);
      assert.equal(app.stopGuard, undefined);
      await advance(40 * SECOND, 100);
      assert.equal(dev.get(2000), 16, `${role}: never paused again after its success`);
    } finally {
      stop();
    }
  }
});

test('r1 I4: another charger of the same model at the address: its values never on the first device', async () => {
  const { gladys, stop, dev, advance, state } = await setup();
  try {
    dev.info.serialNumber = 'OTHER0001';
    dev.set32(220, 7000);
    await advance(31 * SECOND, 100);
    assert.notEqual(state(R.POWER).state, 7000, 'never on the first device');
    assert.ok(
      gladys.fake.discoveredDevices.some((d) =>
        d.external_id.endsWith(':mennekes-amtron:OTHER0001'),
      ),
    );
    // PublicInfo unreadable: not another charger, the Modbus identity decides.
    dev.info.serialNumber = SERIAL;
    await advance(31 * SECOND, 100);
    dev.infoFails = true;
    dev.set32(220, 6000);
    await advance(31 * SECOND, 100);
    assert.equal(state(R.POWER).state, 6000);
  } finally {
    stop();
  }
});

test('r1 I5: a pause never written is never let go by values read (M03)', async () => {
  const { app, stop } = await setup();
  try {
    const guard = app.newStopGuard({ host: HOST, port: 502, unitId: 1 }, undefined);
    const at = app.mono();
    const decisions = [16, 10, 10, 12, 12].map((limit) => app.decideStop(guard, limit, at));
    assert.ok(
      decisions.every((d) => d === 'resend'),
      decisions.join(','),
    );
  } finally {
    stop();
  }
});

test('r1 I5: a check during a read waits for the line, never a second connection (M14)', async () => {
  const { app, press, stop, dev, advance } = await setup();
  try {
    dev.ignoreWrites = true;
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    dev.singleClient = true;
    dev.delay = 100;
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    const reading = app.tick();
    await advance(150, 10);
    const checking = app.runCheck(app.stopGuard);
    await advance(10 * SECOND, 50);
    await reading;
    await checking;
    assert.equal(dev.maxOpen, 1);
    assert.equal(dev.refused, 0);
  } finally {
    stop();
  }
});

test('r1 I5: the pause is tried again after a closed connection (M23) and a refused one (M24)', async () => {
  const { fire, stop, dev, advance } = await setup();
  try {
    dev.closeOnRequest = 1;
    let ack = fire(R.PAUSE, 1);
    await advance(3500, 10);
    ok(await ack);
    assert.equal(dev.get(2000), 0);
    dev.set(2000, 16);
    dev.down = true;
    ack = fire(R.PAUSE, 1);
    await advance(1000, 10);
    dev.down = false;
    await advance(2500, 10);
    ok(await ack);
    assert.equal(dev.get(2000), 0);
  } finally {
    stop();
  }
});

test('r1 I5: a configuration read before a newer save never wins over it (M39)', async () => {
  const { app, stop, advance } = await setup();
  try {
    let answer;
    const slow = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const reading = app.onConnected(slow);
    const saving = app.configUpdated({ host: '192.168.1.90' });
    await advance(SECOND);
    answer({ host: HOST });
    await advance(5 * SECOND);
    await reading;
    await saving;
    assert.equal(app.config.address.host, '192.168.1.90');
  } finally {
    stop();
  }
});

test('r1 m4: a check that gave its turn to a command is tried again a second later', async () => {
  const { app, fire, press, stop, dev, advance } = await setup({ config: ALLOW });
  try {
    dev.ignoreWrites = true;
    refused(await press(R.PAUSE, 1), /sans confirmation/);
    const guard = app.stopGuard;
    dev.ignoreWrites = false;
    dev.delay = 100;
    // A read holds the line; the check waits for it; a command arrives (it fails).
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    app.tick();
    await advance(50, 10);
    app.runCheck(guard);
    const count = pauses(dev).length;
    dev.infoFails = true;
    const ack = fire(R.SET_CURRENT, '8');
    await advance(4 * SECOND, 50);
    refused(await ack, /numéro de série/);
    assert.ok(pauses(dev).length > count, 'checked again within 4 s, not 15 s');
  } finally {
    stop();
  }
});

test('r1 m3: a click ends the read under way at once (no request of it after the click)', async () => {
  const store = memoryStore();
  const { app, fire, stop, dev, advance } = await setup({ store });
  try {
    store.hang = new Promise(() => {});
    dev.delay = 40;
    app.clearTimer();
    app.lastAttemptAt = -Infinity;
    const reading = app.tick();
    await advance(60, 10);
    const before = dev.reads().length;
    fire(R.PAUSE, 1);
    await advance(150, 10);
    assert.equal(dev.reads().length, before, 'the read stopped at the click');
    await advance(5 * SECOND, 50);
    await reading;
    assert.equal(dev.get(2000), 0);
  } finally {
    stop();
  }
});

test('r1 m2: the serial number is read at the address the Modbus connection reached', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeAmtron({ timers: clock.timers });
  dev.address = '192.168.1.99';
  const { fire, stop, advance } = await setup({
    clock,
    dev,
    config: { ...ALLOW, host: 'wallbox.local' },
    create: false,
  });
  try {
    await advance(MINUTE, 500);
    assert.ok(dev.infoHosts.length > 0);
    assert.ok(
      dev.infoHosts.every((h) => h === '192.168.1.99'),
      dev.infoHosts.join(','),
    );
    const ack = fire(R.SET_CURRENT, '8');
    await advance(4 * SECOND, 50);
    await ack;
    assert.ok(
      dev.infoHosts.every((h) => h === '192.168.1.99'),
      'the command too',
    );
  } finally {
    stop();
  }
});

test('r1 I1: during a pause kept alive, a charger down is tried every 5 s, not at the interval', async () => {
  const { app, press, stop, dev, advance, clock } = await setup({
    config: { host: HOST, poll_interval: 300 },
  });
  try {
    dev.set(132, 20);
    ok(await press(R.PAUSE, 1));
    await advance(30 * SECOND, 100);
    assert.equal(app.keepAlive, 10_000);
    dev.down = true;
    const times = [];
    let count = dev.connections;
    for (let i = 0; i < 400; i += 1) {
      await advance(100, 100);
      if (dev.connections !== count) {
        count = dev.connections;
        times.push(clock.monotonic());
      }
    }
    const gaps = times.slice(2).map((t, i) => t - times[i + 1]);
    assert.ok(gaps.length >= 3, `${times.length} attempts`);
    assert.ok(Math.max(...gaps) <= 5_600, `gaps ${gaps.map(Math.round)}`);
  } finally {
    stop();
  }
});
