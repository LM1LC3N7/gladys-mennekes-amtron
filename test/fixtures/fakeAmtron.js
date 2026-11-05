// -----------------------------------------------------------------------------
// A fake MENNEKES AMTRON behind the injected `connect` (no network), on the
// timers of the test clock: Modbus TCP framing (MBAP), function 3 reads and
// function 6 writes, answers after a delay. Built from the manufacturer's
// document (protocol 1.5): a read must be one of the BLOCKS (same start, same
// count) else exception 2; a write must target 2000 (HEMS current limit),
// below 6 A it is stored as 0 (the document: "values below 6A are also set to
// 0A"), above the maximum of the model it is refused (exception 3), and the
// whole write is refused (exception 1) unless the HEMS mode (2010) is "read
// and write". It counts the connections open at once (the integration must
// never open a second one). Its PublicInfo (HTTP) is a function the app takes
// by injection. Values made up, never from a real charger.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { BLOCKS } from '../../src/constants.js';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);
export const SERIAL = '1234567890';
export const MODEL = 'AMTRON 4You 560 11';

const words32 = (value) => {
  const raw = value < 0 ? value + 0x100000000 : value;
  return [Math.floor(raw / 0x10000) & 0xffff, raw & 0xffff];
};

export const stringWords = (text, count) => {
  const bytes = Buffer.alloc(count * 2);
  bytes.write(text, 'latin1');
  return Array.from({ length: count }, (_, i) => bytes.readUInt16BE(i * 2));
};

/** A charger charging a car at 16 A on three phases, HEMS read and write, limit 16 A. */
export function defaultRegisters() {
  const r = new Map();
  const put = (address, words) => words.forEach((w, i) => r.set(address + i, w));
  put(100, stringWords('1.5', 2));
  put(104, [3]); // Charging
  put(105, [0, 0, 0, 0, 0, 0, 0, 0]);
  put(120, stringWords('1.50', 2));
  put(122, [3, 0, 1]); // vehicle C, (123), available
  put(131, [16, 60]); // Safe Current 16 A, timeout 60 s
  put(141, stringWords('AM', 1));
  put(142, stringWords(MODEL, 10));
  put(200, [...words32(1234567), ...words32(0), ...words32(0)]); // 1234.567 kWh
  put(206, [...words32(3680), ...words32(3680), ...words32(3680)]);
  put(212, [...words32(16000), ...words32(16000), ...words32(16000)]);
  put(218, words32(1234567));
  put(220, words32(11040));
  put(222, [...words32(230), ...words32(231), ...words32(229)]);
  put(706, [16]);
  put(712, [6]);
  put(716, [...words32(5432), ...words32(3600)]);
  put(2000, [16]);
  put(2010, [2, 0]);
  return r;
}

class FakeSocket extends EventEmitter {
  constructor(dev) {
    super();
    this.dev = dev;
    this.destroyed = false;
    /** The address the connection reached (a host name resolved by the system). */
    this.remoteAddress = dev.address;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.dev.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.closeTimer) this.dev.timers.clearTimeout(this.closeTimer);
    setImmediate(() => {
      this.dev.open.delete(this);
      this.emit('close');
    });
  }

  end() {
    if (this.destroyed || this.ended) return;
    this.ended = true;
    this.closeTimer = this.dev.timers.setTimeout(() => this.destroy(), this.dev.closeDelay);
  }

  setNoDelay() {}
}

export function fakeAmtron({ timers, unitId = 1 } = {}) {
  const map = defaultRegisters();
  const dev = {
    map,
    unitId,
    open: new Set(),
    maxOpen: 0,
    /** Every request: { fc, address, count?, value? }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    closeDelay: 0,
    /** The highest current the model accepts. */
    maxCurrent: 16,
    /** Addresses (start of a request) that never answer, or answer an exception. */
    silent: new Set(),
    exceptions: new Map(),
    writeExceptions: new Map(),
    silentReads: new Set(),
    readExceptions: new Map(),
    /** Writes acknowledged but not applied, or applied after `applyDelay` ms. */
    ignoreWrites: false,
    applyDelay: 0,
    badEcho: false,
    /** The next requests that close the connection instead of being answered (another client, a reset). */
    closeOnRequest: 0,
    timers,
    singleClient: false,
    /** The address a connection reaches (undefined: none given, as before resolution). */
    address: undefined,
    /** PublicInfo (HTTP): the hosts asked, the answer, a failure, its calls. */
    infoHosts: [],
    info: { serialNumber: SERIAL, articleName: 'AMTRON 4You 560', currentVersion: '1.5.21' },
    infoFails: false,
    infoDelay: 5,
    infoCalls: 0,
    get(address) {
      return map.get(address);
    },
    set(address, value) {
      map.set(address, value < 0 ? value + 0x10000 : value);
    },
    set32(address, value) {
      const [hi, lo] = words32(value);
      map.set(address, hi);
      map.set(address + 1, lo);
    },
    setModel(text) {
      stringWords(text, 10).forEach((w, i) => map.set(142 + i, w));
    },
    apply(address, value) {
      if (dev.ignoreWrites) return;
      const run = () => map.set(address, value);
      if (dev.applyDelay > 0) timers.setTimeout(run, dev.applyDelay);
      else run();
    },
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const address = pdu.readUInt16BE(1);
      let entry;
      if (fc === 3) entry = { fc, address, count: pdu.readUInt16BE(3) };
      else if (fc === 6) entry = { fc, address, value: pdu.readUInt16BE(3) };
      else entry = { fc, address };
      dev.log.push(entry);
      if (dev.closeOnRequest > 0) {
        dev.closeOnRequest -= 1;
        socket.destroy();
        return;
      }
      if (dev.silent.has(address) || (fc === 3 && dev.silentReads.has(address))) return;
      timers.setTimeout(() => {
        if (socket.destroyed) return;
        let answer;
        const exception =
          dev.exceptions.get(address) ??
          (fc === 3 ? dev.readExceptions.get(address) : dev.writeExceptions.get(address));
        if (exception) {
          answer = Buffer.from([fc | 0x80, exception]);
        } else if (fc === 3) {
          const ok = BLOCKS.some((b) => b.address === address && b.count === entry.count);
          if (!ok) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else {
            answer = Buffer.alloc(2 + entry.count * 2);
            answer[0] = fc;
            answer[1] = entry.count * 2;
            for (let i = 0; i < entry.count; i += 1) {
              answer.writeUInt16BE(map.get(address + i) ?? 0, 2 + i * 2);
            }
          }
        } else if (fc === 6) {
          if (address !== 2000) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else if (map.get(2010) !== 2) {
            answer = Buffer.from([fc | 0x80, 1]);
          } else if (entry.value > dev.maxCurrent) {
            answer = Buffer.from([fc | 0x80, 3]);
          } else {
            dev.apply(address, entry.value < 6 ? 0 : entry.value);
            answer = Buffer.from(pdu.subarray(0, 5));
            if (dev.badEcho) answer[4] ^= 1;
          }
        } else {
          answer = Buffer.from([fc | 0x80, 1]);
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = uid;
        answer.copy(out, 7);
        socket.emit('data', out);
      }, dev.delay);
    },
    connect() {
      const socket = new FakeSocket(dev);
      dev.connections += 1;
      timers.setTimeout(() => {
        if (socket.destroyed) return;
        if (dev.down || (dev.singleClient && dev.open.size > 0)) {
          dev.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        dev.open.add(socket);
        dev.maxOpen = Math.max(dev.maxOpen, dev.open.size);
        socket.emit('connect');
      }, dev.connectDelay);
      return socket;
    },
    /** The PublicInfo read the app takes by injection (src/publicinfo.js shape). */
    readIdentity(options) {
      dev.infoCalls += 1;
      dev.infoHosts.push(options?.host);
      return new Promise((resolve, reject) => {
        timers.setTimeout(() => {
          if (dev.infoFails || dev.down) {
            reject(Object.assign(new Error('unreachable'), { kind: 'unreachable' }));
            return;
          }
          resolve({
            serial: String(dev.info.serialNumber).toUpperCase(),
            article: dev.info.articleName,
            firmware: dev.info.currentVersion,
          });
        }, dev.infoDelay);
      });
    },
    writes: () => dev.log.filter((r) => r.fc === 6),
    reads: () => dev.log.filter((r) => r.fc === 3),
  };
  dev.connectFn = () => dev.connect();
  dev.identityFn = (options) => dev.readIdentity(options);
  return dev;
}
