// -----------------------------------------------------------------------------
// The only network access: one Modbus TCP connection to the charger at a time
// (the integration never opens a second one), one request and one answer at a
// time on it.
//
// - An answer is one MBAP frame (7-byte header + PDU), its length read from
//   the header and bounded (at most 260 bytes, as Modbus TCP allows), kept in
//   a fixed buffer, in as many TCP segments as it comes. It must carry the
//   transaction id of the request, protocol 0, the unit id asked and the
//   function code sent (or its exception): anything else, bytes beyond the
//   frame, or bytes with no request waiting, break the session. A request
//   whose answer is late ends the session too: a late answer is never taken
//   for the next request.
// - Every wait is bounded: the connection and each answer.
// - Errors say whether the request may have left: `sent` is set as soon as
//   the bytes are handed to the socket, so a command that may have reached
//   the charger is never reported "not sent". An exception answer (the charger
//   refused the request) is `refused`: the charger did not apply it.
// - `beforeSend` and `startBy` are checked right before the bytes go.
// - Nothing received is ever logged. Taken from gladys-solakon (src/modbus/client.js).
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { MAX_FRAME, MBAP_SIZE, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** The connection was not opened: nothing sent. */
  UNREACHABLE: 'unreachable',
  /** No (complete) answer in time. */
  TIMEOUT: 'timeout',
  /** The charger closed the connection, or a socket error. */
  CLOSED: 'closed',
  /** An answer that is not the one expected (another transaction, unit id, function, size). */
  PROTOCOL: 'protocol',
  /** A Modbus exception: the charger refused the request (not applied). */
  REFUSED: 'refused',
  /** Ended by the integration (a command took the line, a new configuration). */
  ABORTED: 'aborted',
  /** The deadline of a command passed before its bytes left: nothing sent. */
  LATE: 'late',
};

export class ModbusError extends Error {
  constructor(kind, message, { sent = false, code } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

/** A short reason for the logs and the status (never the bytes received). */
export function errorReason(err) {
  if (err instanceof ModbusError) {
    return err.kind === ERROR_KINDS.REFUSED && Number.isInteger(err.code)
      ? `refused (exception ${err.code})`
      : err.kind;
  }
  return 'error';
}

/** The default connector: a plain TCP socket, no delay. */
export function tcpConnect(host, port) {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
}

export class ModbusSession {
  constructor(socket, { unitId = 1, timers = globalThis, now = Date.now } = {}) {
    this.socket = socket;
    this.unitId = unitId;
    this.timers = timers;
    this.now = now;
    this.frame = Buffer.alloc(MAX_FRAME);
    this.length = 0;
    this.pending = undefined;
    this.dead = undefined;
    // Starts anywhere: a late answer of an older session never matches by chance.
    this.transaction = Math.floor(Math.random() * 0x10000);
    /** Resolves once the socket is closed (the next connection opens only after it). */
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.fail(new ModbusError(ERROR_KINDS.CLOSED, 'socket error')));
    socket.on('close', () => {
      this.markClosed();
      this.fail(new ModbusError(ERROR_KINDS.CLOSED, 'connection closed'));
    });
  }

  /** The size of the frame being received, once its header is in (else undefined). */
  expectedSize() {
    if (this.length < MBAP_SIZE) return undefined;
    return 6 + this.frame.readUInt16BE(4);
  }

  onData(chunk) {
    if (this.dead) return;
    if (!this.pending) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'bytes without a request'));
      return;
    }
    if (this.length + chunk.length > MAX_FRAME) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer longer than a frame'));
      return;
    }
    chunk.copy(this.frame, this.length);
    this.length += chunk.length;
    const size = this.expectedSize();
    if (size === undefined) return;
    // Length counts the unit id and the PDU: at least a function code and one byte.
    if (size < MBAP_SIZE + 2 || size > MAX_FRAME) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'bad frame length'));
      return;
    }
    if (this.length > size) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'bytes beyond the frame'));
      return;
    }
    if (this.length === size) {
      this.settle(size);
    }
  }

  /** A complete frame: checked against the request waiting, then handed to it. */
  settle(size) {
    const pending = this.pending;
    const header = this.frame;
    const pdu = Buffer.from(this.frame.subarray(MBAP_SIZE, size));
    if (
      header.readUInt16BE(0) !== pending.transaction ||
      header.readUInt16BE(2) !== 0 ||
      header[6] !== this.unitId
    ) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer to another request'));
      return;
    }
    if (pdu[0] === (pending.fc | 0x80)) {
      if (pdu.length !== 2) {
        this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'bad exception answer'));
        return;
      }
      this.finish(pending);
      pending.reject(
        new ModbusError(ERROR_KINDS.REFUSED, 'exception', { sent: true, code: pdu[1] }),
      );
      return;
    }
    if (pdu[0] !== pending.fc) {
      this.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer to another function'));
      return;
    }
    this.finish(pending);
    pending.resolve(pdu);
  }

  finish(pending) {
    this.pending = undefined;
    this.timers.clearTimeout(pending.timer);
    this.length = 0;
  }

  /** Ends the session: the request waiting fails with `err` (sent if its bytes left). */
  fail(err) {
    if (this.dead) return;
    this.dead = err;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(new ModbusError(err.kind, err.message, { sent: true }));
    }
    try {
      this.socket.destroy();
    } catch {
      // Already closed.
    }
  }

  /** Ended by the integration. */
  abort(message = 'aborted') {
    if (this.dead) {
      // Already ending (a graceful close waiting for the charger): at once now.
      try {
        this.socket.destroy();
      } catch {
        // Already closed.
      }
      return;
    }
    this.fail(new ModbusError(ERROR_KINDS.ABORTED, message));
  }

  /**
   * Ends the session gracefully: a FIN, then the charger closes its side
   * (a controller that accepts one client at a time has then let it go
   * before the next connection); 500 ms at most, then the socket is
   * destroyed. Resolves once closed.
   */
  close() {
    if (!this.dead && !this.pending) {
      this.dead = new ModbusError(ERROR_KINDS.ABORTED, 'session closed');
      const timer = this.timers.setTimeout(() => this.socket.destroy(), TIMINGS.closeWait);
      this.closed.then(() => this.timers.clearTimeout(timer));
      try {
        this.socket.end();
      } catch {
        this.socket.destroy();
      }
    } else {
      this.fail(new ModbusError(ERROR_KINDS.ABORTED, 'session closed'));
    }
    // Bounded: a socket that never says 'close' does not hold the line.
    let guard;
    return Promise.race([
      this.closed,
      new Promise((resolve) => {
        guard = this.timers.setTimeout(resolve, TIMINGS.closeWait * 2);
      }),
    ]).finally(() => this.timers.clearTimeout(guard));
  }

  /**
   * Sends one PDU and resolves with the PDU of its answer (function code
   * first); an exception answer rejects REFUSED (sent); no complete answer at
   * `timeoutMs` ends the session (TIMEOUT, sent).
   * `beforeSend()` may throw to stop the request before any byte leaves;
   * `startBy`: the bytes leave by then or not at all.
   */
  request(pdu, { timeoutMs = TIMINGS.requestTimeout, beforeSend, startBy = Infinity } = {}) {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(new ModbusError(this.dead.kind, this.dead.message));
        return;
      }
      if (this.pending) {
        reject(new ModbusError(ERROR_KINDS.PROTOCOL, 'a request is already waiting'));
        return;
      }
      if (!Buffer.isBuffer(pdu) || pdu.length < 1 || pdu.length > MAX_FRAME - MBAP_SIZE) {
        reject(new ModbusError(ERROR_KINDS.PROTOCOL, 'bad request'));
        return;
      }
      if (this.now() > startBy) {
        reject(new ModbusError(ERROR_KINDS.LATE, 'deadline passed before sending'));
        return;
      }
      // The last check: nothing else runs between it and the write.
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          reject(err);
          return;
        }
      }
      this.transaction = (this.transaction + 1) & 0xffff;
      const frame = Buffer.alloc(MBAP_SIZE + pdu.length);
      frame.writeUInt16BE(this.transaction, 0);
      frame.writeUInt16BE(0, 2);
      frame.writeUInt16BE(pdu.length + 1, 4);
      frame[6] = this.unitId;
      pdu.copy(frame, MBAP_SIZE);
      this.length = 0;
      this.pending = {
        resolve,
        reject,
        fc: pdu[0],
        transaction: this.transaction,
        timer: undefined,
      };
      this.pending.timer = this.timers.setTimeout(() => {
        this.fail(new ModbusError(ERROR_KINDS.TIMEOUT, 'no answer'));
      }, timeoutMs);
      try {
        this.socket.write(frame);
      } catch {
        this.fail(new ModbusError(ERROR_KINDS.CLOSED, 'write failed'));
      }
    });
  }
}

/**
 * Opens a connection: `promise` resolves with a session once connected;
 * `abort()` cancels it (nothing was sent).
 */
export function openSession({
  host,
  port,
  unitId,
  connect = tcpConnect,
  timeoutMs = TIMINGS.connectTimeout,
  timers = globalThis,
  now = Date.now,
}) {
  let socket;
  let settled = false;
  let reject;
  let timer;
  const promise = new Promise((resolve, rejectPromise) => {
    reject = rejectPromise;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      fn(value);
    };
    try {
      socket = connect(host, port);
    } catch {
      done(rejectPromise, new ModbusError(ERROR_KINDS.UNREACHABLE, 'connection failed'));
      return;
    }
    timer = timers.setTimeout(() => {
      socket.destroy();
      done(rejectPromise, new ModbusError(ERROR_KINDS.UNREACHABLE, 'connection timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      done(resolve, new ModbusSession(socket, { unitId, timers, now }));
    });
    socket.once('error', (err) => {
      socket.destroy();
      done(
        rejectPromise,
        new ModbusError(ERROR_KINDS.UNREACHABLE, err?.code ?? 'connection failed'),
      );
    });
    socket.once('close', () => {
      done(rejectPromise, new ModbusError(ERROR_KINDS.UNREACHABLE, 'connection closed'));
    });
  });
  // A failed connection has no listener yet when it fails: never unhandled.
  promise.catch(() => {});
  return {
    promise,
    abort() {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      socket?.destroy();
      reject(new ModbusError(ERROR_KINDS.ABORTED, 'connection aborted'));
    },
  };
}
