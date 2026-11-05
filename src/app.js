// -----------------------------------------------------------------------------
// The integration: the MENNEKES AMTRON typed in the configuration (its IP
// address), one read of its registers every poll interval over one Modbus TCP
// connection, its serial number from its web interface, the Gladys device and
// its states, the transport badge, the buttons, the commands and the pause.
// index.js only wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"; the charger serves a single
// Modbus client), one request at a time on it: a poll is one session of a
// few reads, closed after; the commands take the line from a poll (the poll
// is dropped, nothing of it published); the pause takes it from anything.
//
// Identity: the Modbus map has no serial number. The serial number comes from
// `GET /api/v1/PublicInfo` (src/publicinfo.js), read once at an address, then
// every hour and after every outage, kept in /data with the model name the
// charger gives over Modbus (register 142). Every Modbus session reads the
// Device Id ("AM") and the model first: the values go to the device of the
// serial kept for this address only when they match; a model that changed is
// an identity to read again (nothing published meanwhile); another serial
// read over HTTP is another device. A failed HTTP read is not another device.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s). While a limit below the Safe Current
//     is set and the charger watches the HEMS (read and write mode), the
//     interval is at most half its communication timeout (never under 5 s):
//     a charger left without a read for that long charges again at the Safe
//     Current (manufacturer's document, registers 131, 132);
//   - an answer for an old configuration (generation) publishes nothing; a
//     read begun before a command left is not applied; a value not read this
//     time is never republished as new, nor values older than 2 minutes;
//   - the energy index goes through src/guard.js: never 0, never a drop nor
//     a jump published without the user ("Accept the held index").
//
// Commands ("Resume charging", the charging current):
//   - refused unless "Allow resume and current" is on, checked on arrival and
//     again right before the write (nothing runs in between);
//   - only to the charger whose serial number is read over HTTP for this
//     command and whose Device Id and model are read in the same Modbus
//     session; refused when the HEMS mode (2010) is not "read and write";
//   - bounded on arrival (6 A to the configured ceiling) and on the fresh
//     read (the maximum of the model, the minimum current read, 712), and
//     once more in src/modbus/protocol.js (0, or 6 A to 32 A, register 2000
//     only); "Resume" sets the last current read before the pause, bounded
//     the same way, or is refused when none is known;
//   - decided on a fresh read in the same session, never on the state in
//     memory; refused while a pause runs; one at a time, in their order of
//     arrival; confirmed only by the echo and a read back equal to the value
//     asked; else "sent, without confirmation" and spaced reads; answered
//     by 3.5 s.
// The pause (register 2000 = 0) protects: never held back by the option, the
// bounds, a command or a read in progress, a failed read, a backoff, a
// charger never read, an unreadable identity, nor a configuration not read
// yet (after a restart, a pause kept in /data is written again before it);
// every command that arrived before it and has not left is dropped; a refused
// connection is tried again every 250 ms for 3 s. A pause not seen applied is
// kept in /data with the limit read right after it and checked every 15 s:
// written again while the charger shows that limit, an unknown one or
// nothing; let go only when the charger shows the pause (below 6 A), when
// another limit set elsewhere is read twice in a row, or when a newer
// current clicked in Gladys left. Never by time, never because a write never
// left (a refused connection, a stuck /data). One lock for the line: a
// session opens only once the previous one is closed.
//
// In-memory times (deadlines, the time of the last read) are on a monotonic
// clock (`clock`); the guard of the energy index on the session clock (the
// wall clock at the start plus the monotonic time since); the wall clock
// (`now`) only to date /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  BLOCKS,
  COUNTERS,
  CURRENT,
  HEMS_MODES,
  ILLEGAL_DATA_ADDRESS,
  LIMITS,
  NOT_APPLIED_EXCEPTIONS,
  PRESSED,
  REG,
  ROLE as R,
  SECOND,
  TIMINGS,
  UNIT_ID,
  blockOf,
} from './constants.js';
import { SERVICE, buildDevice, deviceStates, idsOf, parseFeatureId } from './devices.js';
import { IndexGuard, margin } from './guard.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { interpret, modelMax } from './model.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  decodeBlock,
  isWriteEcho,
  parseRead,
  readRequest,
  writeRequest,
} from './modbus/protocol.js';
import { readPublicInfo } from './publicinfo.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time), and when it started. */
  values: undefined,
  /** The values of the last read, whatever the identity (status, identity check). */
  raw: undefined,
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  /** The blocks that failed in the last read. */
  failed: [],
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

const sameTarget = (a, b) =>
  Boolean(a && b) && a.host === b.host && a.port === b.port && a.unitId === b.unitId;

/** A limit that pauses the charge (the charger applies 0 A below 6 A). */
const pausing = (limit) => Number.isInteger(limit) && limit < CURRENT.min;

/** The value Gladys holds for a feature (`{ value, at }`, wall time), when known. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f?.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/**
 * Waits for `promise` at most `ms`: its outcome, or `fallback` (a function:
 * called only then, its value or rejection taken). A stuck promise never
 * holds the caller.
 */
function bounded(promise, ms, timers, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = timers.setTimeout(
        () => resolve(typeof fallback === 'function' ? fallback() : fallback),
        ms,
      );
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

export class AmtronApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'mennekes-amtron' }),
    connect = tcpConnect,
    readIdentity = readPublicInfo,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.readIdentity = readIdentity;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    /** The session clock: the wall clock at the start + the monotonic time since. */
    this.wallStart = now();
    this.monoStart = clock();
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    /** Counts the configurations saved; the last one saved (src/handlers.js onConfigUpdated). */
    this.configSeq = 0;
    this.savedRaw = undefined;
    /** The time of the last read sent to the charger (monotonic). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Optional blocks the firmware does not serve (until a restart), and those answered once. */
    this.absent = new Set();
    this.answered = new Set();
    /** Optional blocks that failed: { failures in a row, skipped until read number }; reads done. */
    this.optional = new Map();
    this.polls = 0;
    /** The session on the line: { kind: 'read' | 'command' | 'protect' | 'check', abort(), done }. */
    this.active = undefined;
    /** Commands and stops waiting for the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The commands waiting, in order, and the worker running them. */
    this.queue = [];
    this.worker = undefined;
    /** The stops waiting, and their worker. */
    this.stops = [];
    this.stopWorker = undefined;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** The pause not seen applied (register 2000 = 0), or undefined. */
    this.stopGuard = undefined;
    this.checking = false;
    /** Counter guards: role -> IndexGuard, for `counterSerial` (session dates). */
    this.counterGuards = new Map();
    this.counterSerial = undefined;
    this.savedCounters = undefined;
    /** The reference read from /data, unchanged since: its wall date is kept there. */
    this.keptWall = undefined;
    /** The first press of "Accept the held index": { serial, list, at, listedAt }. */
    this.pendingAccept = undefined;
    /** The serial number over HTTP: { running, okAt, triedAt, error, firmware, other }. */
    this.identity = { running: undefined, okAt: -Infinity, triedAt: -Infinity };
    /** Set when the charger came back after an outage: its serial is read again. */
    this.recovered = false;
    /** While a limit below the Safe Current is set: the longest wait between two reads (ms). */
    this.keepAlive = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.mono() - this.monoStart);
  }

  /** The charger of the configuration: { host, port, unitId }, or undefined. */
  target() {
    const a = this.config.address;
    return a ? { host: a.host, port: a.port, unitId: UNIT_ID } : undefined;
  }

  /** The serial number of the last read, when its identity matched. */
  get serial() {
    return this.unit.values?.serial;
  }

  // --- /data ----------------------------------------------------------------

  /** Loads /data once (the stop kept there belongs to the whole run); never waits longer than 2 s. */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await bounded(
            Promise.resolve().then(() => this.store.load()),
            TIMINGS.storeWait,
            this.timers,
            () => ({ unreadable: true, slow: true }),
          );
        } catch {
          result = { unreadable: true };
        }
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn(
            `MENNEKES AMTRON: /data/mennekes-amtron-state.json ${result.slow ? 'too slow to read' : 'cannot be read'}: it is never overwritten`,
          );
          this.memory = normalizeMemory(null, this.now());
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, this.now());
      })();
    }
    return this.memoryLoaded;
  }

  /** Writes /data; false when it failed or took longer than 2 s (it may still land later). */
  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      const saved = await bounded(
        Promise.resolve()
          .then(() => this.store.save(this.memory))
          .then(() => true),
        TIMINGS.storeWait,
        this.timers,
        false,
      );
      if (!saved) this.logger.warn('MENNEKES AMTRON: saving the state to /data takes too long');
      return saved;
    } catch (err) {
      this.logger.warn(
        `MENNEKES AMTRON: saving the state to /data failed: ${err?.code ?? 'error'}`,
      );
      return false;
    }
  }

  /** A save nobody waits for (its outcome is logged by saveMemory). */
  saveLater() {
    this.saveMemory().catch(() => {});
  }

  /** The pause not seen applied, in /data (or none). */
  persistStop() {
    const g = this.stopGuard;
    const stop = g
      ? { ...g.target, since: g.since, written: g.written, from: g.from ?? null }
      : null;
    if (JSON.stringify(stop) === JSON.stringify(this.memory.stop ?? null)) {
      return Promise.resolve(true);
    }
    this.memory.stop = stop;
    return this.saveMemory();
  }

  /**
   * At the start of the container, before the configuration is read: a pause
   * kept in /data (not seen applied before the restart) is written again at
   * once to the charger it was sent to, without a read first, then checked
   * every 15 s like any pause.
   */
  async boot() {
    await this.loadMemory();
    const kept = this.memory.stop;
    if (!kept) {
      return;
    }
    const target = { host: kept.host, port: kept.port, unitId: kept.unitId };
    if (!this.stopGuard) {
      this.stopGuard = this.newStopGuard(target, undefined);
      this.stopGuard.since = kept.since;
    }
    this.logger.warn('MENNEKES AMTRON: a pause kept in /data is written again');
    this.queueStop({ target, received: this.mono(), fromBoot: true });
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.unit = freshUnit();
    this.absent.clear();
    this.answered.clear();
    this.optional.clear();
    this.keepAlive = undefined;
    this.identity = { running: undefined, okAt: -Infinity, triedAt: -Infinity };
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    // A read or a command of this configuration ends; a stop or a check has its own target.
    if (this.active && ['read', 'command'].includes(this.active.kind)) {
      this.active.abort('stopped');
    }
    this.publisher.stop();
  }

  /** The container stops: every timer, the check of the pause too (it is in /data). */
  shutdown() {
    this.stop();
    if (this.stopGuard?.timer) {
      this.timers.clearTimeout(this.stopGuard.timer);
      this.stopGuard.timer = undefined;
    }
    this.closed = true;
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * recent states, without reading the charger.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    // A configuration saved after this request was sent wins over its answer.
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`MENNEKES AMTRON: reading the configuration failed: ${err.message}`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      if (!this.closed) {
        this.configTimer = this.timers.setTimeout(() => {
          this.configTimer = undefined;
          this.onConnected(getConfig).catch(() => {});
        }, TIMINGS.configRetry);
      }
      return;
    }
    await this.inOrder(() => {
      if (seq !== this.configSeq) {
        this.logger.debug(
          'MENNEKES AMTRON: configuration read before a newer save: the newer one kept',
        );
        return this.connected(this.savedRaw);
      }
      return this.connected(raw);
    });
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = (this.configChain ?? Promise.resolve()).then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /** A new address restarts (an interval, the HTTP port, the ceiling only apply). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid
    );
  }

  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  /**
   * The configuration saved: applied in order of arrival, the last one wins
   * (each one waits for the one before it).
   */
  configUpdated(raw = {}) {
    // Counted on arrival: a `getConfig()` answer that left before it is stale.
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(
        `MENNEKES AMTRON resume and current ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
      );
    }
    if (this.config.apiPort !== previous.apiPort) {
      // Another HTTP port: the serial number may be read at once.
      this.identity.triedAt = -Infinity;
      this.maybeCheckIdentity();
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent
    ) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target`; the line is held
   * until it ends. The only lock of the line: a session opens only once no
   * other holds it (a stop ends any other session first and waits for its
   * end). `yieldTo()`: checked right before the line is taken, with no
   * `await` in between; true gives the turn up. `retryUntil`: a refused
   * connection is tried again every 250 ms until then (nothing is sent
   * before the connection, so this never repeats a write).
   */
  async useLine(kind, target, timeoutMs, fn, { retryUntil, yieldTo } = {}) {
    while (this.active) {
      if (kind === 'protect' && this.active.kind !== 'protect') {
        this.active.abort('line taken');
      }
      await this.active.done;
    }
    if (yieldTo?.()) {
      throw Object.assign(new ModbusError(ERROR_KINDS.ABORTED, 'turn given up'), {
        yielded: true,
      });
    }
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      // The line is free only once the connection is closed (never two at once).
      await record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One block read in `session`: its raw values decoded (src/modbus/protocol.js). */
  async readBlock(session, block, options) {
    const pdu = await session.request(readRequest(block), options);
    const words = parseRead(block, pdu);
    if (words === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, words);
  }

  /** Blocks read now and interpreted together (any failure throws). */
  async readValues(session, keys, options) {
    const raw = {};
    for (const key of keys) {
      Object.assign(raw, await this.readBlock(session, blockOf(key), options));
    }
    return interpret(raw);
  }

  // --- Polling ---------------------------------------------------------------

  /** The poll interval, shortened to keep a limit set while the charger watches the HEMS. */
  get interval() {
    const configured = this.config.pollInterval * SECOND;
    return this.keepAlive === undefined ? configured : Math.min(configured, this.keepAlive);
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    if (this.closed) return;
    let wait = delay ?? (u.online === false ? u.wait : this.interval);
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('MENNEKES AMTRON refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /** Keeps the time of this read; in /data BEFORE the read, at most once a minute (2 s at most). */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    const target = this.target();
    if (!target) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command or a stop holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    let result;
    let failure;
    try {
      result = await this.useLine(
        'read',
        target,
        TIMINGS.connectTimeout,
        (session) => this.readAll(session),
        { yieldTo: () => this.reserved > 0 || this.stops.length > 0 },
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      this.logger.debug('MENNEKES AMTRON: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('MENNEKES AMTRON: read begun before a command, not applied');
    } else {
      await this.applyRead(result, startedAt);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other, the identity first. A core block
   * refused fails the read; an optional block refused with "illegal data
   * address" before it was ever answered is not served by this firmware (not
   * read again until a restart); any other refusal leaves its values unknown
   * this time. A timeout, a closed connection or a wrong answer fails the
   * whole read when it hits a core block; on an optional one, the values
   * already read are kept and the rest waits for the next read.
   */
  async readAll(session) {
    const raw = {};
    const failed = [];
    this.polls += 1;
    let dead = false;
    for (const block of BLOCKS) {
      if (this.absent.has(block.key)) {
        continue;
      }
      if (dead || (!block.core && this.polls < (this.optional.get(block.key)?.skipUntil ?? 0))) {
        if (block.core) {
          throw new ModbusError(ERROR_KINDS.CLOSED, 'session lost on an optional block', {
            sent: true,
          });
        }
        failed.push(block.key);
        continue;
      }
      let values;
      try {
        values = await this.readBlock(session, block, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (block.core || err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        failed.push(block.key);
        if (err.kind === ERROR_KINDS.REFUSED) {
          if (err.code === ILLEGAL_DATA_ADDRESS && !this.answered.has(block.key)) {
            failed.pop();
            this.absent.add(block.key);
            this.logger.info(
              `MENNEKES AMTRON: the firmware does not serve the ${block.key} registers`,
            );
            continue;
          }
        } else {
          dead = true;
        }
        this.optionalFailed(block.key);
        this.logger.warn(
          `MENNEKES AMTRON: reading the ${block.key} registers failed (${errorReason(err)})`,
        );
        continue;
      }
      this.answered.add(block.key);
      this.optional.delete(block.key);
      Object.assign(raw, values);
    }
    return { values: interpret(raw), failed };
  }

  /**
   * An optional block failed: after LIMITS.optionalFailures failures in a row
   * it is skipped for LIMITS.optionalSkip reads (never blocking the others).
   */
  optionalFailed(key) {
    const entry = this.optional.get(key) ?? { failures: 0, skipUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= LIMITS.optionalFailures) {
      entry.failures = 0;
      entry.skipUntil = this.polls + LIMITS.optionalSkip;
    }
    this.optional.set(key, entry);
  }

  /** The identity kept for the charger of the configuration, else undefined. */
  knownIdentity() {
    const id = this.memory.identity;
    return id && sameTarget(id, this.target()) ? id : undefined;
  }

  /**
   * The serial number the values of a read belong to: the one kept for this
   * address, when the Device Id says AMTRON and the model is the one kept with
   * it; else undefined (nothing published: an identity to read again).
   */
  serialFor(values) {
    const id = this.knownIdentity();
    if (!id || values.isAmtron !== true || !values.model) return undefined;
    return values.model === id.model ? id.serial : undefined;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  async applyRead({ values, failed }, startedAt) {
    const u = this.unit;
    if (u.online === false) {
      // Back after an outage: the serial number is read again (another charger may answer).
      this.recovered = true;
    }
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.readAt = startedAt;
    u.failed = failed;
    u.raw = values;
    const target = this.target();
    if (!sameTarget(target, this.memory.target)) {
      this.memory.target = target;
      this.saveLater();
    }
    // The stop sees the raw limit, whatever the identity (it was sent to this address).
    this.observe(values, startedAt);
    this.updateKeepAlive(values);
    await this.adopt(values);
    this.maybeCheckIdentity();
  }

  /** The values of a read go to the device of their serial number, when it is known. */
  async adopt(values) {
    const u = this.unit;
    const serial = this.serialFor(values);
    if (!serial) {
      u.values = undefined;
      return;
    }
    const copy = { ...values, serial };
    await this.guardCounters(copy);
    if (u.raw !== values) {
      // A newer read arrived meanwhile.
      return;
    }
    u.values = copy;
    if (
      Number.isInteger(copy.hemsLimit) &&
      copy.hemsLimit >= CURRENT.min &&
      copy.hemsLimit <= CURRENT.max &&
      (this.memory.resume?.serial !== serial || this.memory.resume.current !== copy.hemsLimit)
    ) {
      // The current "Resume charging" sets again.
      this.memory.resume = { serial, current: copy.hemsLimit };
      this.saveLater();
    }
  }

  /**
   * The keep-alive: a charger in HEMS read and write mode that hears nothing
   * for its communication timeout applies its Safe Current. While the limit
   * read is below it (a pause included), the reads come at least every half
   * timeout (never more often than every 5 s).
   */
  updateKeepAlive(values) {
    const { hemsMode, commTimeout, safeCurrent, hemsLimit } = values;
    const before = this.keepAlive;
    if (
      hemsMode === HEMS_MODES.READ_WRITE &&
      Number.isInteger(commTimeout) &&
      commTimeout > 0 &&
      Number.isInteger(safeCurrent) &&
      Number.isInteger(hemsLimit) &&
      hemsLimit < safeCurrent
    ) {
      this.keepAlive = Math.max(TIMINGS.keepAliveMin, (commTimeout * SECOND) / 2);
    } else if (hemsMode !== undefined || hemsLimit !== undefined) {
      // Known not to be needed (unknown values keep what was decided before).
      this.keepAlive = undefined;
    }
    if (before !== this.keepAlive && this.keepAlive !== undefined) {
      this.logger.info(
        `MENNEKES AMTRON: reads every ${Math.round(this.interval / SECOND)} s to keep the limit set`,
      );
    }
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`MENNEKES AMTRON: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  // --- Identity (HTTP) ------------------------------------------------------------

  /** Whether the serial number must be read now (and may: spaced after a failure). */
  identityDue() {
    const raw = this.unit.raw;
    if (!this.config.apiPort || !this.target() || this.identity.running) return false;
    if (!raw || raw.isAmtron !== true || !raw.model) return false;
    const now = this.mono();
    const id = this.knownIdentity();
    const needed =
      !id ||
      id.model !== raw.model ||
      this.recovered ||
      now - this.identity.okAt >= TIMINGS.identityEvery;
    // Spaced only after a failure: a model that changed is checked at once.
    const spaced =
      this.identity.error === undefined || now - this.identity.triedAt >= TIMINGS.identityRetry;
    return needed && spaced;
  }

  /** Reads the serial number in the background when due (never holding a read nor a command). */
  maybeCheckIdentity() {
    if (!this.identityDue()) return;
    const generation = this.generation;
    const model = this.unit.raw.model;
    const target = this.target();
    this.identity.triedAt = this.mono();
    this.identity.running = this.fetchIdentity(target, TIMINGS.identityTimeout)
      .then(async (info) => {
        if (generation !== this.generation || !sameTarget(target, this.target())) return;
        this.identity.okAt = this.mono();
        this.identity.error = undefined;
        // Read again after the outage: done (until the next one).
        this.recovered = false;
        this.identity.firmware = info.firmware;
        await this.identified(target, info, model);
      })
      .catch((err) => {
        if (generation !== this.generation) return;
        this.identity.error = err?.kind ?? 'error';
        this.logger.warn(
          `MENNEKES AMTRON: the serial number could not be read over HTTP (${this.identity.error})`,
        );
        this.lastStatus = undefined;
        return this.updateStatus();
      })
      .finally(() => {
        this.identity.running = undefined;
      });
  }

  /** One read of PublicInfo at the address of `target`, bounded. */
  fetchIdentity(target, timeoutMs) {
    return Promise.resolve().then(() =>
      bounded(
        this.readIdentity({ host: target.host, port: this.config.apiPort, timeoutMs }),
        timeoutMs + 100,
        this.timers,
        () => Promise.reject(Object.assign(new Error('timeout'), { kind: 'timeout' })),
      ),
    );
  }

  /**
   * A serial number read: the identity of this address. The same serial
   * keeps its device (its model is the one read now); another one is another
   * charger (a new device, the old one shown unreachable).
   */
  async identified(target, info, model) {
    const kept = this.knownIdentity();
    if (kept && kept.serial === info.serial && kept.model === model) {
      return;
    }
    if (kept && kept.serial !== info.serial) {
      this.logger.warn('MENNEKES AMTRON: another charger answers at this address');
    }
    this.memory.identity = { ...target, serial: info.serial, model };
    this.saveLater();
    // The last read, when recent, goes to that device at once.
    const u = this.unit;
    if (u.raw && u.online === true && this.mono() - u.readAt <= TIMINGS.freshFor) {
      await this.adopt(u.raw);
    }
    this.published = undefined;
    await this.publishAll();
  }

  // --- Status ------------------------------------------------------------------------

  /** Notes added to every status: the pause held, the index held, the Safe Current. */
  notes(text) {
    let out = text;
    if (this.stopGuard) {
      out = join(out, T.stopHeld(age(Math.max(0, this.now() - this.stopGuard.since))));
    }
    for (const [, guard] of this.counterGuards) {
      if (guard.held) out = join(out, T.indexHeld(guard.held));
    }
    const raw = this.unit.raw;
    if (this.unit.online === true && raw) {
      if (raw.hemsMode !== undefined && raw.hemsMode !== HEMS_MODES.READ_WRITE) {
        out = join(out, T.hemsReadOnly);
      } else if (
        raw.hemsMode === HEMS_MODES.READ_WRITE &&
        pausing(raw.hemsLimit) &&
        Number.isInteger(raw.safeCurrent) &&
        raw.safeCurrent >= CURRENT.min &&
        Number.isInteger(raw.commTimeout)
      ) {
        out = join(out, T.safeCurrent(raw.commTimeout, raw.safeCurrent));
      }
    }
    return out;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    if (!c.address) {
      return this.notes(c.invalid ? T.invalid(c.invalid) : T.noHost);
    }
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      return this.notes(
        [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
          ? T.unreachable(addressKey(c.address), wait)
          : T.failing(u.error ?? 'error', wait),
      );
    }
    if (u.online === undefined) {
      return this.notes(
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting,
      );
    }
    if (u.raw?.isAmtron === false) {
      return this.notes(T.notAmtron);
    }
    if (!u.values) {
      if (!c.apiPort) return this.notes(T.badApiPort);
      return this.notes(
        this.identity.error
          ? T.noSerial(c.address.host, c.apiPort, this.identity.error)
          : T.identifying,
      );
    }
    let text = T.connected(u.values.serial, u.values);
    if (u.failed.length > 0) {
      text = join(text, T.missingBlocks(u.failed.join(', ')));
    }
    if (this.keepAlive !== undefined) {
      text = join(text, T.keepAlive(Math.round(this.interval / SECOND)));
    }
    return this.notes(text);
  }

  async updateStatus() {
    await this.setStatus(
      this.unit.online === true && Boolean(this.config.address) && Boolean(this.unit.values),
      this.status(),
    );
  }

  // --- Energy index ------------------------------------------------------------------

  /** Session dates of wall dates (Gladys, /data), never later than now. */
  toSession(ref) {
    if (!ref || !Number.isFinite(ref.at)) return ref;
    const sessionNow = this.sessionNow();
    return { ...ref, at: Math.min(ref.at - (this.now() - sessionNow), sessionNow) };
  }

  /** The guards of `serial` (from Gladys and /data the first time), on the session clock. */
  countersOf(serial) {
    if (this.counterSerial !== serial) {
      this.counterGuards = new Map();
      this.counterSerial = serial;
      this.pendingAccept = undefined;
      this.savedCounters = undefined;
      this.keptWall = undefined;
      const saved = this.memory.counters?.serial === serial ? this.memory.counters.guards : {};
      const device = this.createdDevice(serial);
      const ids = idsOf(this.gladys, serial);
      const sessionNow = this.sessionNow();
      for (const role of COUNTERS) {
        const kept = saved[role]
          ? {
              last: this.toSession(saved[role].last),
              held: this.toSession(saved[role].held),
            }
          : undefined;
        const guard = new IndexGuard(
          this.toSession(lastValueOf(device, ids.feature(role))),
          kept,
          sessionNow,
        );
        this.counterGuards.set(role, guard);
        const last = guard.last;
        if (last && kept?.last && last.value === kept.last.value && last.at === kept.last.at) {
          // Unchanged since /data: its wall date stays there (never the bounded one).
          this.keptWall = { role, value: last.value, at: last.at, wall: saved[role].last.at };
        }
      }
    }
    return this.counterGuards;
  }

  /** Drops from `values` every counter its guard holds back; keeps the guards in /data. */
  async guardCounters(values) {
    const guards = this.countersOf(values.serial);
    const at = this.sessionNow();
    for (const role of COUNTERS) {
      if (values[role] === undefined) continue;
      if (!guards.get(role).accept(values[role], at)) {
        delete values[role];
      }
    }
    this.persistCounters();
  }

  /** The guards in /data (wall dates), when something changed; never waited for. */
  persistCounters() {
    if (!this.counterSerial) return;
    const offset = this.now() - this.sessionNow();
    const kept = this.keptWall;
    const state = { serial: this.counterSerial, guards: {} };
    for (const [role, guard] of this.counterGuards) {
      const s = guard.state();
      if (!s.last) continue;
      const toWall = (ref) => {
        if (!ref || !Number.isFinite(ref.at)) return ref;
        if (
          ref === s.last &&
          kept?.role === role &&
          ref.value === kept.value &&
          ref.at === kept.at
        ) {
          return { ...ref, at: kept.wall };
        }
        return { ...ref, at: Math.round(ref.at + offset) };
      };
      state.guards[role] = { last: toWall(s.last), held: toWall(s.held) };
    }
    const key = JSON.stringify([
      [...this.counterGuards].map(([, g]) => [g.last, g.held]),
      Math.round(offset / 60_000),
      this.counterSerial,
    ]);
    if (key === this.savedCounters) return;
    this.memory.counters = state;
    this.saveMemory().then((ok) => {
      if (ok) this.savedCounters = key;
    });
  }

  /**
   * "Accept the held index", two presses: the first lists the value held;
   * the second, from 3 s to 5 minutes later, accepts exactly that one (a
   * value held since that moved beyond what the charger may have drawn since
   * the first press is not accepted).
   */
  async acceptIndex() {
    const serial = this.counterSerial;
    const held = [...this.counterGuards]
      .filter(([, g]) => g.held)
      .map(([role, g]) => ({
        role,
        direction: g.held.direction,
        from: g.held.from,
        to: g.held.to,
      }));
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const mono = this.mono();
    const elapsed = pending ? mono - pending.at : undefined;
    if (
      pending &&
      pending.serial === serial &&
      elapsed >= TIMINGS.acceptAfter &&
      elapsed <= TIMINGS.acceptWithin
    ) {
      const accepted = [];
      const skipped = [];
      const now = this.sessionNow();
      for (const item of pending.list) {
        const guard = this.counterGuards.get(item.role);
        const h = guard?.held;
        if (
          h &&
          h.from === item.from &&
          h.direction === item.direction &&
          h.to >= item.to &&
          h.to - item.to <= margin(pending.listedAt, now)
        ) {
          guard.acceptHeld();
          accepted.push(item);
        } else {
          skipped.push(item);
        }
      }
      this.logger.info(
        `MENNEKES AMTRON: index accepted by the user: ${accepted.length > 0 ? 'yes' : 'no'}`,
      );
      return T.accept.done(accepted, skipped);
    }
    if (!serial || held.length === 0) {
      return T.accept.nothing;
    }
    this.pendingAccept = { serial, list: held, at: mono, listedAt: this.sessionNow() };
    return T.accept.confirm(held);
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice(serial = this.serial) {
    if (!serial) return undefined;
    const id = idsOf(this.gladys, serial).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  /** Every created device of this integration (another serial included). */
  createdDevices() {
    return (this.gladys.devices ?? []).filter(
      (d) => typeof d?.external_id === 'string' && d.external_id.includes(`:${SERVICE}:`),
    );
  }

  /** The highest current Gladys may set on a charger of `model` now. */
  ceilingFor(model) {
    return Math.min(this.config.maxCurrent, modelMax(model));
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the charger answered with an identity that matches its serial number. */
  async publishDevices() {
    const values = this.unit.values;
    if (this.unit.online !== true || !values?.serial) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, {
        serial: values.serial,
        model: values.model,
        firmware: this.identity.firmware,
        language: this.config.language,
        ceiling: this.ceilingFor(values.model),
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures(serial = this.serial) {
    return new Set((this.createdDevice(serial)?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features of `serial`. */
  queueValues(values, serial, created = this.createdFeatures(serial), at = this.mono()) {
    if (!serial) return;
    const states = deviceStates(idsOf(this.gladys, serial), values, {
      ceiling: this.ceilingFor(this.unit.values?.model ?? values.model),
    });
    for (const { device_feature_external_id: id, ...value } of states) {
      if (created.has(id)) {
        this.publisher.push(id, value, at);
      }
    }
  }

  /** The last values, only when recent (never an old read republished as new). */
  queueStates(created) {
    const u = this.unit;
    if (u.online === true && u.values && this.mono() - u.readAt <= TIMINGS.freshFor) {
      this.queueValues(u.values, u.values.serial, created, u.readAt);
    }
  }

  async publishBadge() {
    const online = this.unit.online;
    if (online === undefined && this.config.address) {
      return;
    }
    const current = this.serial ? idsOf(this.gladys, this.serial).device : undefined;
    const entries = this.createdDevices().map((d) => ({
      external_id: d.external_id,
      transport:
        online === true && d.external_id === current
          ? DEVICE_TRANSPORTS.LOCAL
          : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    if (entries.length === 0) {
      return;
    }
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its recent values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    const u = this.unit;
    if (u.running) {
      await u.running;
      return this.status();
    }
    if (this.mono() < this.due) {
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(this.status(), T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return this.status();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /** The value of a command, checked strictly (bounds that need no read). */
  parseValue(role, value) {
    if (role === R.RESUME) {
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badValue);
      }
      return PRESSED;
    }
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{1,2}$/.test(value)
          ? Number(value)
          : undefined;
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (number < CURRENT.min || number > this.config.maxCurrent) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, this.config.maxCurrent));
    }
    return number;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseFeatureId(feature?.external_id);
    if (!parsed || ![R.PAUSE, R.RESUME, R.SET_CURRENT].includes(parsed.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (parsed.role === R.PAUSE) {
      // The pause: never held back by its value, the option, a read or the serial; before
      // the configuration is read (Gladys unreachable), to the charger of the last read.
      if (!this.configRead && !this.target()) {
        // /data holds the charger of the last read (loaded once, 2 s at most).
        await this.loadMemory();
      }
      const target =
        this.target() ?? (this.configRead ? undefined : (this.memory.target ?? undefined));
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(received, target);
    }
    const asked = this.parseValue(parsed.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (!this.target()) {
      throw this.refusal(ERRORS.noHost);
    }
    if (this.stops.length > 0 || this.stopWorker) {
      // A current restarts what a pause under way is stopping: refused meanwhile.
      throw this.refusal(ERRORS.stopRunning);
    }
    if (this.queue.length >= LIMITS.queue) {
      throw this.refusal(ERRORS.busy);
    }
    return this.enqueue({ role: parsed.role, serial: parsed.serial, asked }, received);
  }

  /**
   * Queues a command; answers by 3.5 s after its arrival: its outcome, or,
   * when it is still waiting its turn or its answer, what is known then (it
   * goes on in the background).
   */
  async enqueue(plan, received) {
    const job = {
      plan,
      received,
      seq: this.protectSeq,
      generation: this.generation,
      target: this.target(),
      state: { written: false, sent: [] },
    };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.queue.push(job);
    this.runQueue();
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      job.done.then((o) => {
        if (o.error) {
          this.logger.warn(`MENNEKES AMTRON: ${plan.role} after the ack: ${o.error.message}`);
        }
      });
      if (!job.state.written) {
        throw this.refusal(ERRORS.queued);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.noAnswerYet, this.config.language)));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** The worker of the commands: one session, the jobs one after the other. */
  runQueue() {
    if (this.worker) {
      return;
    }
    this.reserved += 1;
    this.worker = (async () => {
      try {
        while (this.queue.length > 0) {
          // The stops first, all of them.
          while (this.stopWorker) {
            await this.stopWorker;
          }
          await this.takeLine(['read', 'check']);
          if (this.queue.length === 0) break;
          const job = this.queue[0];
          if (!sameTarget(job.target, this.target()) || job.generation !== this.generation) {
            this.queue.shift();
            job.resolve({ error: this.refusal(ERRORS.configChanged) });
            continue;
          }
          try {
            await this.useLine(
              'command',
              job.target,
              TIMINGS.commandConnectMax,
              (session) => this.drain(session, job.target),
              // Checked right before the line is taken: a stop arrived meanwhile goes first.
              { yieldTo: () => this.stops.length > 0 || Boolean(this.stopWorker) },
            );
          } catch (err) {
            if (err.yielded) {
              continue;
            }
            // The connection failed or was taken: the job in front answers it.
            const front = this.queue[0];
            if (front && front === job && !job.started) {
              this.queue.shift();
              job.resolve({ error: this.commandError(err, job) });
            }
          }
        }
      } finally {
        this.reserved -= 1;
        this.worker = undefined;
      }
    })();
  }

  /** Runs the queued jobs for `target` on one session. */
  async drain(session, target) {
    while (this.queue.length > 0) {
      if (this.stops.length > 0) {
        // A stop waits: the session ends, the stop goes, the queue after it.
        return;
      }
      const job = this.queue[0];
      if (!sameTarget(job.target, target)) {
        return;
      }
      this.queue.shift();
      job.started = true;
      let outcome;
      try {
        await this.commandSession(session, job);
        outcome = {};
      } catch (err) {
        outcome = { error: this.commandError(err, job) };
        if ((!(err instanceof Refusal) || err.sessionDead) && !err?.beforeSend) {
          // The session failed: the next jobs open a new one.
          job.resolve(outcome);
          return;
        }
      }
      job.resolve(outcome);
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, job) {
    const { plan, state } = job;
    if (err?.beforeSend && state.written) {
      // An earlier write of the same command left: never "not sent".
      this.followUp();
      return this.refusal(ERRORS.sentUnconfirmed(err.message));
    }
    if (err instanceof Refusal || err?.beforeSend) {
      return err;
    }
    const reason = errorReason(err);
    if (!state.written) {
      this.logger.warn(`MENNEKES AMTRON: command NOT sent (${plan.role}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          job.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      this.logger.warn(`MENNEKES AMTRON: command refused by the charger (${plan.role}): ${reason}`);
      this.followUp();
      return this.refusal(ERRORS.refused(reason));
    }
    this.followUp();
    this.logger.warn(`MENNEKES AMTRON: command sent, NOT confirmed (${plan.role}): ${reason}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The checks before every write, on the latest configuration. */
  checkCommand(job) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (job.generation !== this.generation || !sameTarget(job.target, this.target())) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (job.seq !== this.protectSeq || this.stops.length > 0 || this.stopWorker) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
  }

  /** Reads now in the session; a failure is a refusal (nothing sent), the session dead unless refused. */
  async freshRead(session, keys, timeoutMs) {
    try {
      return await this.readValues(session, keys, { timeoutMs });
    } catch (err) {
      if (err.kind === ERROR_KINDS.ABORTED) {
        throw err;
      }
      const refusal = this.refusal(ERRORS.unknownState(errorReason(err)));
      if (err.kind !== ERROR_KINDS.REFUSED) {
        refusal.sessionDead = true;
      }
      throw refusal;
    }
  }

  /**
   * The serial number of the charger read over HTTP for this command: the one
   * of the device clicked, else refused (nothing sent).
   */
  async checkSerial(job, timeoutMs) {
    if (!this.config.apiPort) {
      throw this.refusal(ERRORS.unknownIdentity);
    }
    let info;
    try {
      info = await this.fetchIdentity(job.target, timeoutMs);
    } catch {
      throw this.refusal(ERRORS.unknownIdentity);
    }
    if (info.serial !== job.plan.serial) {
      throw this.refusal(ERRORS.otherDevice);
    }
  }

  async commandSession(session, job) {
    const { plan, state } = job;
    // A queued command starts within 15 s of its arrival, or never.
    const startBy = job.received + TIMINGS.queueWindow;
    const left = () => startBy - this.mono();
    if (left() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.checkCommand(job);
    // The serial number over HTTP, then the Device Id and the model over Modbus.
    await this.checkSerial(job, Math.min(TIMINGS.commandIdentityMax, left()));
    const readMs = Math.min(TIMINGS.commandReadMax, left());
    if (readMs < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const fresh = await this.freshRead(session, ['identity', 'hems', 'hemsConfig'], readMs);
    const id = this.knownIdentity();
    if (fresh.isAmtron !== true || !fresh.model) {
      throw this.refusal(ERRORS.unknownIdentity);
    }
    if (!id || id.serial !== plan.serial || id.model !== fresh.model) {
      throw this.refusal(ERRORS.otherDevice);
    }
    let minimum;
    try {
      minimum = (await this.readValues(session, ['minimum'], { timeoutMs: readMs })).minCurrent;
    } catch (err) {
      // Not served or refused: 6 A is the floor; a lost session refuses (nothing sent).
      if (err.kind === ERROR_KINDS.ABORTED) throw err;
      if (err.kind !== ERROR_KINDS.REFUSED) {
        const refusal = this.refusal(ERRORS.unknownState(errorReason(err)));
        refusal.sessionDead = true;
        throw refusal;
      }
    }
    this.checkCommand(job);
    if (fresh.hemsMode !== HEMS_MODES.READ_WRITE) {
      throw this.refusal(fresh.hemsMode === undefined ? ERRORS.unknownValue : ERRORS.readOnlyMode);
    }
    if (fresh.hemsLimit === undefined) {
      throw this.refusal(ERRORS.unknownValue);
    }
    this.noteValues(fresh);
    const ceiling = this.ceilingFor(fresh.model);
    // The minimum the charger gives raises the floor; above the ceiling, nothing fits.
    const floor =
      Number.isInteger(minimum) && minimum > CURRENT.min && minimum <= CURRENT.max
        ? minimum
        : CURRENT.min;
    if (floor > ceiling) {
      throw this.refusal(ERRORS.outOfBounds(floor, ceiling));
    }
    let value;
    if (plan.role === R.RESUME) {
      if (!pausing(fresh.hemsLimit)) {
        this.logger.info('MENNEKES AMTRON: resume: the charge is not paused, nothing sent');
        return;
      }
      const kept =
        this.memory.resume?.serial === plan.serial ? this.memory.resume.current : undefined;
      if (kept === undefined) {
        throw this.refusal(ERRORS.noResumeValue);
      }
      value = Math.min(Math.max(kept, floor), ceiling);
    } else {
      if (plan.asked < floor || plan.asked > ceiling) {
        throw this.refusal(ERRORS.outOfBounds(floor, ceiling));
      }
      value = plan.asked;
      if (fresh.hemsLimit === value) {
        this.logger.info(`MENNEKES AMTRON: current already ${value} A, nothing sent`);
        return;
      }
    }
    const request = writeRequest(REG.HEMS_LIMIT, value);
    const sendBy = this.mono() + TIMINGS.commandMinSend + TIMINGS.commandMinRead;
    this.logger.info(`MENNEKES AMTRON: ${plan.role} (${value} A)`);
    let echo;
    try {
      echo = await session.request(request, {
        timeoutMs: TIMINGS.requestTimeout,
        startBy: Math.min(sendBy, startBy + TIMINGS.commandMinSend),
        beforeSend: () => {
          // The option, the configuration and a stop, right before the write.
          this.checkCommand(job);
          // The write that leaves counts: never "not sent" after it.
          state.written = true;
          state.sent.push(REG.HEMS_LIMIT);
          this.lastSentAt = this.mono();
          // A newer current left: an older pause is never written again after it.
          this.dropStopGuard('a newer current was sent');
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
        state.refused = true;
      }
      throw err;
    }
    if (!isWriteEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
    // Confirmed only by the value read back equal to the value asked.
    const back = await this.readValues(session, ['hems'], { timeoutMs: TIMINGS.requestTimeout });
    this.noteValues(back);
    if (back.hemsLimit !== value) {
      throw new ModbusError(
        ERROR_KINDS.PROTOCOL,
        word(ERRORS.readBackDiffers, this.config.language),
        { sent: true },
      );
    }
    this.followUp();
    this.logger.info(`MENNEKES AMTRON: ${plan.role} confirmed by the charger`);
  }

  /** Values a command or a stop read: in memory and to Gladys in the background. */
  noteValues(values) {
    const u = this.unit;
    if (u.online !== true || !u.values) {
      return;
    }
    const copy = {};
    for (const key of ['hemsLimit', 'hemsMode', 'commStatus', R.CURRENT_LIMIT, R.PAUSED]) {
      if (values[key] !== undefined) copy[key] = values[key];
    }
    if (Object.keys(copy).length === 0) return;
    Object.assign(u.values, copy);
    if (u.raw) Object.assign(u.raw, copy);
    this.queueValues(copy, u.values.serial);
    this.flush().catch(() => {});
  }

  // --- The pause (protective) ---------------------------------------------------

  /**
   * The pause clicked: queued before anything (it ends a read, a command or a
   * check on the line), answered by 3.5 s after the click.
   */
  async protect(received, target) {
    // Every command that arrived before this pause and has not left gives way.
    this.protectSeq += 1;
    const job = this.queueStop({ target, received });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      if (!job.state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.noAnswerYet, this.config.language)));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /**
   * Queues a pause: in the order of the clicks. A click for the same target
   * still waiting is joined. The poll, a command or a check on the line is
   * ended at once (synchronously).
   */
  queueStop({ target, received, fromBoot = false }) {
    let job = this.stops.find((j) => !j.running && sameTarget(j.target, target));
    if (job) {
      return job;
    }
    job = { target, received, fromBoot, state: { written: false } };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    if (this.active && this.active.kind !== 'protect') {
      this.active.abort('line taken');
    }
    this.runStops();
    return job;
  }

  /** The worker of the pauses: before anything else on the line. */
  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.reserved += 1;
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`MENNEKES AMTRON: pause failed: ${err.message}`);
            job.resolve({ error: this.refusal(ERRORS.notSent(errorReason(err))) });
          }
          this.stops.shift();
        }
      } finally {
        this.reserved -= 1;
        this.stopWorker = undefined;
        if (this.queue.length > 0) this.runQueue();
      }
    })();
  }

  newStopGuard(target, from) {
    return {
      target,
      from,
      since: this.now(),
      written: false,
      sentAt: undefined,
      other: undefined,
      timer: undefined,
    };
  }

  /**
   * What a limit read says of the pause: 'done' (the pause shows), 'wait'
   * (the charger had no time yet), 'confirm' (another limit set elsewhere,
   * read once: read again before letting go, nothing written), 'drop' (that
   * other limit read twice in a row) or 'resend' (the limit of before, an
   * unknown limit, or nothing read: written over, in doubt). When the limit
   * of before is unknown, the first limit read after the pause was written is
   * taken as that limit. Until the pause was written in this run (after
   * `from` was read in the same session), never 'confirm' nor 'drop': a limit
   * of before unknown or stale is never "changed elsewhere".
   */
  decideStop(stop, limit, readStartedAt) {
    if (pausing(limit)) {
      return 'done';
    }
    if (!stop.written) {
      stop.other = undefined;
      return 'resend';
    }
    if (stop.sentAt !== undefined && readStartedAt < stop.sentAt + TIMINGS.applyDelay) {
      return 'wait';
    }
    if (!Number.isInteger(limit)) {
      stop.other = undefined;
      return 'resend';
    }
    if (stop.from === undefined) {
      stop.from = limit;
    }
    if (limit === stop.from) {
      stop.other = undefined;
      return 'resend';
    }
    if (stop.other === limit) {
      return 'drop';
    }
    stop.other = limit;
    return 'confirm';
  }

  /**
   * One pause: one write of 2000 = 0 without a read first, then the read back
   * that alone confirms it. A refused connection, a closed connection, a
   * timeout or a wrong answer is tried again every 250 ms until 3 s after
   * the click (the write is idempotent). Not confirmed: kept (in /data) and
   * checked every 15 s. Nothing waits on /data longer than 200 ms here: the
   * next check is armed before any save.
   */
  async sendStop(job) {
    const { target, state } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.commandSendBy;
    if (!this.stopGuard || !sameTarget(this.stopGuard.target, target)) {
      if (this.stopGuard) this.dropStopGuard('a pause to another address');
      this.stopGuard = this.newStopGuard(target, undefined);
    }
    const guard = this.stopGuard;
    if (!job.fromBoot) {
      guard.since = this.now();
    }
    guard.other = undefined;
    // In /data before the first byte, so a restart writes it again; a save that fails or
    // hangs never holds the pause back (200 ms at most).
    await bounded(
      this.persistStop().catch(() => false),
      TIMINGS.stopSaveWait,
      this.timers,
      false,
    );
    let back;
    const attempt = async (session) => {
      const request = writeRequest(REG.HEMS_LIMIT, 0);
      const echo = await session.request(request, {
        timeoutMs: Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono())),
        beforeSend: () => {
          state.written = true;
          const at = this.mono();
          this.lastSentAt = at;
          if (this.stopGuard === guard) {
            guard.written = true;
            guard.sentAt = at;
            // The limit it replaces is read after the write, in this session (never a poll's).
            guard.from = undefined;
            guard.other = undefined;
          }
        },
      });
      if (!isWriteEcho(request, echo)) {
        session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
        throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
      }
      back = await this.readValues(session, ['hems']);
      const limit = back.hemsLimit;
      if (this.stopGuard === guard && Number.isInteger(limit) && !pausing(limit)) {
        // Still running right after the write: the limit it replaces (never "changed elsewhere").
        guard.from = limit;
      }
    };
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    let failure;
    this.logger.info('MENNEKES AMTRON: pause (HEMS current limit 0 A)');
    for (;;) {
      try {
        await this.useLine('protect', target, TIMINGS.connectTimeout, attempt, { retryUntil });
        failure = undefined;
        break;
      } catch (err) {
        failure = err;
        if (!AGAIN.includes(err?.kind) || this.mono() + TIMINGS.connectRetry >= retryUntil) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
      }
    }
    const confirmed = back !== undefined && pausing(back.hemsLimit);
    if (this.stopGuard === guard) {
      if (confirmed) {
        this.dropStopGuard('applied');
      } else {
        // Armed first: a stuck /data never holds the next check.
        this.armStopCheck();
        this.persistStop().catch(() => {});
      }
    }
    if (state.written) {
      // The reads that follow publish the limit (with the identity read again).
      this.followUp();
    }
    if (back) this.noteValues(back);
    let result;
    if (confirmed) {
      this.logger.info('MENNEKES AMTRON: pause confirmed by the charger');
      result = {};
    } else if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`MENNEKES AMTRON: pause failed (${reason})`);
      if (!state.written) {
        result = { error: this.refusal(ERRORS.stopPending) };
      } else if (failure.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(failure.code)) {
        result = { error: this.refusal(ERRORS.stopRefused(reason)) };
      } else {
        result = { error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
      }
    } else {
      result = {
        error: this.refusal(
          ERRORS.sentUnconfirmed(word(ERRORS.readBackDiffers, this.config.language)),
        ),
      };
    }
    job.resolve(result);
  }

  /** Whether a click or a command waits or runs: a check gives way to them (they are newer). */
  checkMustYield() {
    return (
      this.stops.length > 0 ||
      Boolean(this.stopWorker) ||
      this.queue.length > 0 ||
      Boolean(this.worker)
    );
  }

  /**
   * The periodic check of the pause: reads the limit, then writes the pause
   * again only when `decideStop` says so. Never ends another session: it
   * waits for the line, and gives its turn up (tried again a second later)
   * to a click or a command waiting or running; a click ends it. Right
   * before its write, it gives way again if a click or a command arrived.
   */
  async runCheck() {
    const guard = this.stopGuard;
    if (!guard) return;
    if (this.checkMustYield() || this.checking) {
      this.armStopCheck(TIMINGS.checkYield);
      return;
    }
    const outcome = { decision: undefined, back: undefined, written: false };
    this.checking = true;
    try {
      await this.useLine(
        'check',
        guard.target,
        TIMINGS.connectTimeout,
        async (session) => {
          const startedAt = this.mono();
          let value;
          try {
            value = await this.readValues(session, ['hems']);
          } catch (err) {
            if (err.kind === ERROR_KINDS.ABORTED) throw err;
            // A limit that cannot be read: written over, in doubt (the write is the pause).
            value = undefined;
            if (err.kind !== ERROR_KINDS.REFUSED) throw err;
          }
          if (this.stopGuard !== guard) return;
          outcome.back = value;
          outcome.decision = this.decideStop(guard, value?.hemsLimit, startedAt);
          if (outcome.decision !== 'resend') return;
          const request = writeRequest(REG.HEMS_LIMIT, 0);
          const echo = await session.request(request, {
            timeoutMs: TIMINGS.requestTimeout,
            beforeSend: () => {
              if (this.checkMustYield() || this.stopGuard !== guard) {
                throw Object.assign(new Error('a newer click or command'), { yielded: true });
              }
              this.logger.warn('MENNEKES AMTRON: still not paused after a pause: written again');
              outcome.written = true;
              if (!guard.written) {
                // First write of this pause: the limit it replaces is the one read just now.
                const read = value?.hemsLimit;
                guard.from = Number.isInteger(read) && !pausing(read) ? read : undefined;
              }
              guard.other = undefined;
              guard.written = true;
              guard.sentAt = this.mono();
              this.lastSentAt = guard.sentAt;
            },
          });
          if (!isWriteEcho(request, echo)) {
            session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
            throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
              sent: true,
            });
          }
          outcome.back = await this.readValues(session, ['hems']);
        },
        { yieldTo: () => this.checkMustYield() },
      );
    } catch (err) {
      if (!err?.yielded && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`MENNEKES AMTRON: check of the pause failed (${errorReason(err)})`);
      }
    } finally {
      this.checking = false;
    }
    if (this.stopGuard !== guard) return;
    if (outcome.written || outcome.decision === 'done') {
      // The limit shown changed (or will): read again soon, with the identity.
      this.followUp();
    }
    if (outcome.back) this.noteValues(outcome.back);
    const limit = outcome.back?.hemsLimit;
    if (outcome.decision === 'done' || pausing(limit)) {
      this.dropStopGuard('applied');
    } else if (outcome.decision === 'drop') {
      this.logger.info(
        'MENNEKES AMTRON: another limit set after the pause (not by Gladys): let go',
      );
      this.dropStopGuard('changed elsewhere');
    } else {
      // Armed first: a stuck /data never holds the next check.
      this.armStopCheck(outcome.decision === 'confirm' ? TIMINGS.holdConfirm : undefined);
      this.persistStop().catch(() => {});
    }
  }

  dropStopGuard(reason) {
    const guard = this.stopGuard;
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    this.stopGuard = undefined;
    this.logger.debug(`MENNEKES AMTRON: pause let go (${reason})`);
    this.persistStop().catch(() => {});
    this.lastStatus = undefined;
    this.updateStatus().catch(() => {});
  }

  /** The next check of the pause: every 15 s, whatever the refresh interval and the failures. */
  armStopCheck(delay = TIMINGS.stopRetry) {
    const guard = this.stopGuard;
    if (!guard || this.closed) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (this.stopGuard !== guard) return;
      this.runCheck().catch((err) => this.logger.warn(`MENNEKES AMTRON: check: ${err.message}`));
    }, delay);
  }

  /**
   * A poll read through the pause: it ends it ('done', 'drop') or brings its
   * next check closer ('confirm'); the writing is the job of the checks.
   */
  observe(values, readStartedAt) {
    const stop = this.stopGuard;
    if (!stop || !sameTarget(stop.target, this.target())) {
      return;
    }
    const decision = this.decideStop(stop, values.hemsLimit, readStartedAt);
    if (decision === 'done') {
      this.dropStopGuard('applied');
    } else if (decision === 'drop') {
      this.logger.info(
        'MENNEKES AMTRON: another limit set after the pause (not by Gladys): let go',
      );
      this.dropStopGuard('changed elsewhere');
    } else if (decision === 'confirm') {
      this.armStopCheck(TIMINGS.holdConfirm);
    } else if (!stop.written) {
      // The charger answers again and the pause never left: written now, by a check.
      this.armStopCheck(0);
    } else {
      this.persistStop().catch(() => {});
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    if (this.closed) return;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation && u === this.unit) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('MENNEKES AMTRON refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
