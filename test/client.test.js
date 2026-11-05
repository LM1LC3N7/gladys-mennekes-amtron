// -----------------------------------------------------------------------------
// The Modbus TCP session (src/modbus/client.js) on a fake socket: an answer is
// bounded before it is all received, and only the answer to its own request
// is taken.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModbusSession } from '../src/modbus/client.js';
import { testClock } from './kit/clock.mjs';

function session() {
  const clock = testClock();
  const socket = new EventEmitter();
  socket.sent = [];
  socket.destroyed = false;
  socket.write = (b) => socket.sent.push(Buffer.from(b));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.end = socket.destroy;
  const s = new ModbusSession(socket, { unitId: 1, timers: clock.timers, now: clock.monotonic });
  return { s, socket, clock };
}

const header = (tid, length, unit = 1) => {
  const b = Buffer.alloc(7);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(length, 4);
  b[6] = unit;
  return b;
};

test('a header announcing more than a frame fails at once, before the rest arrives', async () => {
  const { s, socket } = session();
  const p = s.request(Buffer.from([4, 0x03, 0xe8, 0, 6]));
  const tid = socket.sent[0].readUInt16BE(0);
  socket.emit('data', header(tid, 1000));
  await assert.rejects(p, /bad frame length/);
  assert.equal(socket.destroyed, true);
});

test('a chunk longer than a frame fails before it is copied', async () => {
  const { s, socket } = session();
  const p = s.request(Buffer.from([4, 0x03, 0xe8, 0, 6]));
  const tid = socket.sent[0].readUInt16BE(0);
  socket.emit('data', Buffer.concat([header(tid, 254), Buffer.alloc(300)]));
  await assert.rejects(p, /longer than a frame/);
});

test('an answer with another transaction or unit id is not taken', async () => {
  for (const [delta, unit] of [
    [1, 1],
    [0, 2],
  ]) {
    const { s, socket } = session();
    const p = s.request(Buffer.from([4, 0x03, 0xe8, 0, 1]));
    const tid = socket.sent[0].readUInt16BE(0);
    socket.emit(
      'data',
      Buffer.concat([header((tid + delta) & 0xffff, 5, unit), Buffer.from([4, 2, 0, 1])]),
    );
    await assert.rejects(p, /another request/);
  }
});
