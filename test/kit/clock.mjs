// Copied from ~/code/ref/gladys-testkit (src/clock.mjs, Apache-2.0, same author): reused as is.

// Clocks for an app that takes `now`, `monotonic` and `timers` by injection:
// a virtual one (testClock) and the real one sped up (realClock), plus a spy
// that dates the decisions of the app and measures their period.

import { AssertionError } from 'node:assert';

/** Lets pending promises and I/O callbacks run (a few turns of the event loop). */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const handle = (id) => ({
  id,
  ref() {
    return this;
  },
  unref() {
    return this;
  },
  hasRef: () => true,
});

/**
 * A virtual clock: nothing fires by itself. Every read of `now()` (wall,
 * epoch ms) or `monotonic()` moves the time on by `step` (1 µs): a decision
 * reading the clock twice sees it move, as on a real clock. `advance(ms)`
 * fires every timer due on the way, in order, WITHOUT awaiting the promise a
 * callback returns (as Node does), with a turn of the event loop between two.
 */
export function testClock({ start = Date.UTC(2026, 0, 1), step = 0.001 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args, every) => {
    const h = handle((seq += 1));
    const delay = Math.max(0, Number(ms) || 0);
    pending.set(h, { fn, args, at: t + delay, seq, every: every ? Math.max(1, delay) : 0 });
    return h;
  };
  const remove = (h) => pending.delete(h);
  const clock = {
    now: () => start + read(),
    monotonic: () => read(),
    /** Virtual ms since the start, without moving the clock. */
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
      clearTimeout: remove,
      clearInterval: remove,
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next;
        for (const [h, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [h, timer];
          }
        }
        if (!next) break;
        const [h, timer] = next;
        t = Math.max(t, timer.at);
        if (timer.every) timer.at += timer.every;
        else pending.delete(h);
        timer.fn(...timer.args);
        await settle(1);
      }
      t = Math.max(t, target);
      await settle(1);
    },
  };
  return clock;
}

/**
 * The real clock sped up `speed` times: `now()` and `monotonic()` in
 * simulated ms, timers shortened by `speed`. `close()` clears the timers
 * still pending; `timersSet` counts the timers the app asked for.
 */
export function realClock({ speed = 1 } = {}) {
  const p0 = performance.now();
  const w0 = Date.now();
  const live = new Set();
  const wrap =
    (set, clear, repeat) =>
    (fn, ms, ...args) => {
      clock.timersSet += 1;
      const h = set(
        () => {
          if (!repeat) live.delete(h);
          fn(...args);
        },
        Math.max(0, Number(ms) || 0) / speed,
      );
      live.add(h);
      return h;
    };
  const clear = (h) => {
    live.delete(h);
    clearTimeout(h);
  };
  const clock = {
    speed,
    timersSet: 0,
    now: () => w0 + (performance.now() - p0) * speed,
    monotonic: () => performance.now() * speed,
    timers: {
      setTimeout: wrap(setTimeout, clearTimeout, false),
      setInterval: wrap(setInterval, clearInterval, true),
      clearTimeout: clear,
      clearInterval: clear,
    },
    /** Waits `ms` simulated ms (real ms divided by speed). */
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / speed)),
    close() {
      for (const h of live) clearTimeout(h);
      live.clear();
    },
  };
  return clock;
}

/**
 * Wraps `object[method]`: every call is recorded with its date on `clock`
 * (monotonic) and its arguments, then goes on. `restore()` puts it back.
 */
export function spyOn(object, method, clock) {
  const original = object[method];
  const spy = {
    clock,
    calls: [],
    restore: () => {
      object[method] = original;
    },
  };
  object[method] = function spied(...args) {
    spy.calls.push({ at: clock.monotonic(), args });
    return original.apply(this, args);
  };
  return spy;
}

/**
 * Waits (real time) for `count` calls of the spy, then checks every gap
 * between two calls in simulated ms: never under `min`, never over `max`.
 * Defaults tolerate a loaded machine: a timer is late, never early, so
 * min = 0.9 x period and max = 1.5 x period. Returns the gaps.
 */
export async function measurePeriod(
  spy,
  { count = 3, period, min = period * 0.9, max = period * 1.5, timeoutMs } = {},
) {
  if (!(min >= 0) || !(max >= min))
    throw new TypeError('measurePeriod: give period, or min and max');
  const speed = spy.clock?.speed ?? 1;
  const deadline = performance.now() + (timeoutMs ?? ((count + 1) * max) / speed + 2000);
  while (spy.calls.length < count && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const at = spy.calls.slice(0, count).map((c) => c.at);
  const gaps = at.slice(1).map((v, i) => Math.round(v - at[i]));
  const bad = gaps.filter((g) => g < min || g > max);
  if (at.length < count || bad.length > 0) {
    throw new AssertionError({
      message: `period: ${at.length}/${count} calls, gaps ${gaps.join(', ')} ms, expected ${Math.round(min)}..${Math.round(max)}`,
      actual: gaps,
      expected: { min, max },
      operator: 'measurePeriod',
    });
  }
  return gaps;
}
