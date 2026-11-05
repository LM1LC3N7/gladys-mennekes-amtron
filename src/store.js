// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `lastAttemptAt`: the time of the last read (written at most once a
//     minute, BEFORE the read), so a restart never reads sooner than the
//     interval;
//   - `target`: the charger of the last read (address, Modbus port, unit id):
//     where a pause goes while the configuration is not read yet;
//   - `identity`: the serial number read at that address (HTTP PublicInfo)
//     and the model name the charger gives over Modbus with it;
//   - `stops`: the pauses not seen applied yet, one per charger (at most 8):
//     its target, the limit read right after it was written (`from`),
//     whether it was written, since when. A restart writes them again at
//     once, before the configuration is even read. They never end by time;
//   - `keepAlive`: the longest wait between two reads while a limit below
//     the Safe Current is set (the first read after a restart comes within
//     it);
//   - `counters`: the guard of the energy index (src/guard.js);
//   - `resume`: the last charging current (>= 6 A) read for the serial, the
//     one "Resume charging" sets again.
// No secret (the charger has none here), no personal data. The file is
// readable by the container user only (0600), bounded and repaired when read.
// A file that cannot be read is not an empty one: `load()` says so, and the
// app then never overwrites it with a guess. A special file (a FIFO, a device)
// is never read nor written: opened without blocking, refused when it is not a
// plain file; the temporary file of a save is created anew (never an existing
// one). The app bounds every wait on it (src/app.js, TIMINGS.storeWait).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { COUNTERS, CURRENT, UNIT_ID } from './constants.js';
import { modelOf, serialOf } from './model.js';

export const STATE_FILE = '/data/mennekes-amtron-state.json';
const MAX_BYTES = 16 * 1024;

/** Reads a plain file of at most MAX_BYTES; `undefined` when it is not one. */
async function readPlain(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  let waiting;
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readPlain(path);
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text === undefined) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    /**
     * At most one write running and one waiting: a save made while another
     * waits replaces its content (a stuck disk never piles writes up).
     */
    save(data) {
      const text = JSON.stringify(data);
      if (waiting) {
        waiting.text = text;
        return waiting.promise;
      }
      const entry = { text };
      entry.promise = chain.then(async () => {
        if (waiting === entry) waiting = undefined;
        const temporary = `${path}.tmp`;
        // Never an existing file (it could be a FIFO): removed, then created exclusively.
        await rm(temporary, { force: true });
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(entry.text);
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      });
      waiting = entry;
      chain = entry.promise.catch(() => {});
      return entry.promise;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    /** A promise that holds every save until resolved (a hung disk), or undefined. */
    hang: undefined,
    /** A promise that holds the load until resolved (a slow disk), or undefined. */
    hangLoad: undefined,
    async load() {
      if (this.hangLoad) await this.hangLoad;
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.hang) await this.hang;
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]*$/.test(value)
    ? value
    : undefined;

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** The charger of a stop or of the last read: address, port, unit id; else undefined. */
export function targetOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host = shortText(raw.host, 253);
  const port = intIn(raw.port, 1, 65535);
  const unitId = intIn(raw.unitId, UNIT_ID, UNIT_ID);
  return host && /^[a-z0-9.-]+$/.test(host) && port && unitId ? { host, port, unitId } : undefined;
}

/** A limit read after a stop (another value than a pause), else undefined. */
const runningLimit = (value) => intIn(value, CURRENT.min, 80);

function normalizeStop(raw, now) {
  const target = targetOf(raw);
  if (!target) return undefined;
  // `since` only dates the status: a date in the future (the clock was set back, a
  // board without a clock before NTP) or none keeps the stop, dated now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  return {
    ...target,
    since,
    written: raw.written === true,
    from: runningLimit(raw.from) ?? null,
  };
}

function normalizeIdentity(raw) {
  const target = targetOf(raw);
  const serial = serialOf(raw?.serial);
  const model = modelOf(raw?.model);
  return target && serial && model ? { ...target, serial, model } : null;
}

const validPoint = (p) =>
  p && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

function normalizeCounters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const serial = serialOf(raw.serial);
  if (!serial || !raw.guards || typeof raw.guards !== 'object') return null;
  const guards = {};
  for (const role of COUNTERS) {
    const g = raw.guards[role];
    if (!g || typeof g !== 'object') continue;
    const last = validPoint(g.last);
    if (!last) continue;
    const h = g.held;
    const held =
      h &&
      (h.direction === 'up' || h.direction === 'down') &&
      [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
        ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
        : null;
    guards[role] = { last, held };
  }
  return { serial, guards };
}

function normalizeResume(raw) {
  const serial = serialOf(raw?.serial);
  const current = intIn(raw?.current, CURRENT.min, CURRENT.max);
  return serial && current ? { serial, current } : null;
}

const MAX_STOPS = 8;

/** The pauses kept: valid ones only, one per charger (an older file's single `stop` too). */
function normalizeStops(data, now) {
  const list = Array.isArray(data.stops) ? data.stops.slice(0, MAX_STOPS) : [data.stop];
  const stops = [];
  for (const entry of list) {
    const stop = normalizeStop(entry, now);
    if (
      stop &&
      !stops.some((s) => s.host === stop.host && s.port === stop.port && s.unitId === stop.unitId)
    ) {
      stops.push(stop);
    }
  }
  return stops;
}

/** The persisted state, repaired and bounded (see the header). */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    target: targetOf(data.target) ?? null,
    // A time in the future counts as now: never a longer wait than the interval.
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: normalizeIdentity(data.identity),
    stops: normalizeStops(data, now),
    stop: normalizeStops(data, now)[0] ?? null,
    keepAlive: intIn(data.keepAlive, 5_000, 3_600_000) ?? null,
    counters: normalizeCounters(data.counters),
    resume: normalizeResume(data.resume),
  };
}
