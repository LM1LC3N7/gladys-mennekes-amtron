// -----------------------------------------------------------------------------
// The Modbus PDUs (pure): the blocks are runs of documented registers, the
// answers are taken only at their exact size, the write request is register
// 2000 with 0 or 6 A to 32 A, nothing else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, MAX_READ, blockOf } from '../src/constants.js';
import {
  decodeBlock,
  isWriteEcho,
  parseRead,
  readRequest,
  sizeOf,
  stringOf,
  writableCurrent,
  writeRequest,
} from '../src/modbus/protocol.js';

/** The registers of the manufacturer's document (protocol 1.5): start, count. */
const DOCUMENTED = [
  [100, 2],
  [104, 1],
  [105, 8],
  [120, 2],
  [122, 1],
  [124, 1],
  [131, 1],
  [132, 1],
  [134, 1],
  [140, 1],
  [141, 1],
  [142, 10],
  [152, 1],
  [153, 5],
  [200, 6],
  [206, 6],
  [212, 6],
  [218, 2],
  [220, 2],
  [222, 6],
  [706, 1],
  [707, 2],
  [710, 2],
  [712, 1],
  [715, 1],
  [716, 2],
  [718, 2],
  [2000, 1],
  [2001, 1],
  [2002, 1],
  [2010, 1],
  [2011, 1],
  [2012, 1],
  [2013, 1],
];
const documented = new Set(
  DOCUMENTED.flatMap(([a, n]) => Array.from({ length: n }, (_, i) => a + i)),
);

test('every block is a run of documented registers, within one read', () => {
  for (const block of BLOCKS) {
    assert.ok(block.count >= 1 && block.count <= MAX_READ, block.key);
    for (let a = block.address; a < block.address + block.count; a += 1) {
      assert.ok(documented.has(a), `${block.key}: register ${a} is not in the document`);
    }
    for (const [address, type] of block.points) {
      assert.ok(address >= block.address);
      assert.ok(address + sizeOf(type) <= block.address + block.count, `${block.key} ${address}`);
    }
  }
  // The batches mennekes-amtron-ha reads, where they are the same registers.
  assert.deepEqual([blockOf('status').address, blockOf('status').count], [104, 9]);
  assert.deepEqual([blockOf('meter').address, blockOf('meter').count], [200, 28]);
  assert.deepEqual([blockOf('hems').address, blockOf('hems').count], [2000, 1]);
});

test('a read answer is taken at its exact size only', () => {
  const block = blockOf('safety');
  assert.deepEqual([...readRequest(block)], [3, 0, 131, 0, 2]);
  assert.deepEqual(parseRead(block, Buffer.from([3, 4, 0, 16, 0, 60])), [16, 60]);
  assert.equal(parseRead(block, Buffer.from([3, 2, 0, 16])), undefined);
  assert.equal(parseRead(block, Buffer.from([3, 4, 0, 16, 0, 60, 0])), undefined);
  assert.equal(parseRead(block, Buffer.from([4, 4, 0, 16, 0, 60])), undefined);
  assert.throws(() => readRequest({ key: 'x', address: 0, count: 126 }));
});

test('decoding: 32-bit high word first, signed, ASCII high byte first', () => {
  const meter = blockOf('meter');
  const words = new Array(28).fill(0);
  words[18] = 0x0012;
  words[19] = 0xd687; // 1234567 Wh
  words[20] = 0xffff;
  words[21] = 0xfff6; // -10 W
  const v = decodeBlock(meter, words);
  assert.equal(v.energyTotal, 1234567);
  assert.equal(v.powerTotal, -10);
  assert.equal(stringOf([0x414d]), 'AM');
  assert.equal(stringOf([0x414d, 0x0000, 0xffff]), 'AM');
  assert.equal(stringOf([0x4101]), undefined, 'a control byte is not a text');
  assert.deepEqual(decodeBlock(meter, [1, 2]), {}, 'a wrong size decodes nothing');
});

test('the write: register 2000 only, 0 or 6 A to 32 A, never anything else', () => {
  assert.deepEqual([...writeRequest(2000, 0)], [6, 0x07, 0xd0, 0, 0]);
  assert.deepEqual([...writeRequest(2000, 16)], [6, 0x07, 0xd0, 0, 16]);
  for (const [address, value] of [
    [2000, 5],
    [2000, 33],
    [2000, 6.5],
    [2000, -1],
    [2000, '10'],
    [1000, 0],
    [2001, 60],
    [131, 0],
  ]) {
    assert.throws(() => writeRequest(address, value), RangeError, `${address}=${value}`);
  }
  assert.equal(writableCurrent(32), true);
  assert.equal(writableCurrent(1), false);
  const request = writeRequest(2000, 10);
  assert.equal(isWriteEcho(request, Buffer.from(request)), true);
  assert.equal(isWriteEcho(request, writeRequest(2000, 11)), false);
  assert.equal(isWriteEcho(request, undefined), false);
});
