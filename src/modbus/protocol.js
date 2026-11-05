// -----------------------------------------------------------------------------
// The Modbus PDUs of the AMTRON (pure): the read requests of the blocks, what
// their answers hold, and the write request of the HEMS current limit. A
// decoder returns undefined when the answer has not the exact size asked: an
// unknown value is never a value. The write request is checked here once
// more, whatever the caller asked: only register 2000, only 0 (the pause) or a
// whole current from 6 A to 16 A (the manufacturer's range; the caller caps it
// further at the ceiling of the charger and of the configuration).
// -----------------------------------------------------------------------------

import { CURRENT, FC, MAX_READ, REG } from '../constants.js';

/** The read request of a block (function 3). */
export function readRequest(block) {
  const { address, count } = block;
  if (!Number.isInteger(count) || count < 1 || count > MAX_READ) {
    throw new RangeError(`block ${block.key}: ${count} registers`);
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.READ_HOLDING;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead(block, pdu) {
  const { count } = block;
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== FC.READ_HOLDING) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(pdu.readUInt16BE(2 + i * 2));
  return words;
}

/** Registers a point spans: `ascii<n>` n registers, 32-bit types 2, others 1. */
export function sizeOf(type) {
  const ascii = /^ascii(\d+)$/.exec(type);
  if (ascii) return Number(ascii[1]);
  return type.endsWith('32') ? 2 : 1;
}

/** Printable ASCII of registers (high byte first), padding at the end dropped. */
export function stringOf(words) {
  const bytes = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  let end = bytes.length;
  // Padding at the end: NUL, space or 0xFF (an erased register).
  while (end > 0 && [0, 0x20, 0xff].includes(bytes[end - 1])) end -= 1;
  const text = bytes.slice(0, end);
  // A byte that is not printable ASCII: not a text (never shown, never kept).
  if (text.some((b) => b < 0x20 || b > 0x7e)) return undefined;
  const value = String.fromCharCode(...text).trim();
  return value === '' ? undefined : value;
}

/** One point of a block from its words. */
function pointValue(type, words) {
  if (type.startsWith('ascii')) return stringOf(words);
  switch (type) {
    case 'u16':
      return words[0];
    case 'i16':
      return words[0] >= 0x8000 ? words[0] - 0x10000 : words[0];
    case 'u32':
      return words[0] * 0x10000 + words[1];
    case 'i32': {
      const raw = words[0] * 0x10000 + words[1];
      return raw >= 0x80000000 ? raw - 0x100000000 : raw;
    }
    default:
      return undefined;
  }
}

/** The raw values of a block, by key; only those decodable. */
export function decodeBlock(block, words) {
  const values = {};
  if (!Array.isArray(words) || words.length !== block.count) return values;
  for (const [address, type, key] of block.points) {
    const at = address - block.address;
    const n = sizeOf(type);
    if (at < 0 || at + n > words.length) continue;
    const slice = words.slice(at, at + n);
    if (!slice.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)) continue;
    const value = pointValue(type, slice);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** Whether `value` is a current Gladys may ever write: 0 (pause) or 6 A to 16 A, whole. */
export const writableCurrent = (value) =>
  value === 0 || (Number.isInteger(value) && value >= CURRENT.min && value <= CURRENT.max);

/**
 * The write request (function 6) of the HEMS current limit. Throws on any
 * other register or value.
 */
export function writeRequest(address, value) {
  if (address !== REG.HEMS_LIMIT || !writableCurrent(value)) {
    throw new RangeError(`Not a value Gladys writes: ${address}=${value}`);
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.WRITE_SINGLE;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(value, 3);
  return pdu;
}

/** Whether `answer` is the echo of `request`: a write single is answered by the very same PDU. */
export function isWriteEcho(request, answer) {
  return Buffer.isBuffer(answer) && answer.length === 5 && answer.equals(request);
}
