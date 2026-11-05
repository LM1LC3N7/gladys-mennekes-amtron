// -----------------------------------------------------------------------------
// Plausibility of the energy index of the charger (its meter total), the
// value Gladys counts as consumption. Pure. Taken as is from gladys-p1-monitor
// (src/guard.js, approved for the billed index; its `indexOfTariffs` left out:
// the charger has one meter total), only its constants changed (25 kW).
//
// The core turns the deltas of an `energy-sensor` / `index` feature into
// consumption and cost: it skips a delta below zero (a counter reset) but
// counts every rise IN FULL. So 9,194 → 0 → 9,194 kWh is billed as 9,194 kWh
// in one half hour, and so is 9,194 → 10 (a drop taken) → 9,194. The rules:
// - a value of 0 (or below) is never published;
// - a value plausible after the last one published (not lower, not more than
//   INDEX_MAX_KW on average since then) goes through; a value EQUAL to it
//   goes through without moving its date, so that a frozen reading never
//   shrinks the margin of the next real rise;
// - a drop and a jump up are NEVER confirmed by repetition nor by time: they
//   are held (the last accepted value is sent again), shown in the status,
//   kept in /data across restarts, and taken only on an explicit gesture of
//   the user (`acceptHeld`, the "Accept the held index" action);
// - the acceptance is BOUNDED: it covers the value shown (`held.to`, read at
//   `held.at`) and what the charger may have drawn since (INDEX_MAX_KW ×
//   hours + INDEX_SLACK_KWH), nothing else: a jump taken is counted once as
//   consumption, a drop taken gives the core a negative delta (nothing
//   billed) and the values rise from there. A value outside the bounds is
//   held again and the acceptance dropped;
// - an accepted value is a floor both ways: a value under it is held (never
//   counted), the acceptance kept and its margin counted from then;
// - while a jump is held, every value at or above it stays held: the margin
//   growing while nothing is published must never cover it;
// - a value back to the usual rule (the drop or the jump was a glitch) ends
//   the hold, but only within the margin counted from the hold itself: with
//   an old reference, a value under a held jump that does not fit that short
//   margin is held in its turn (its kWh shown), never taken.
//
// Its dates are those of the session clock of src/app.js (the wall clock at
// the start of the process plus the monotonic time since), never the wall
// clock alone.
// -----------------------------------------------------------------------------

import { INDEX_MAX_KW, INDEX_SLACK_KWH } from './constants.js';

const HOUR = 3_600_000;

/** kWh the charger may draw between `from` and `to` (ms): the margin of the guard. */
export const margin = (from, to) =>
  (INDEX_MAX_KW * Math.max(0, to - from)) / HOUR + INDEX_SLACK_KWH;

/** Whether `value` may follow `previous` (both `{ value, at }`). */
function follows(previous, value, at) {
  return value >= previous.value && value - previous.value <= margin(previous.at, at);
}

const validLast = (last) =>
  last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

const validHeld = (held) =>
  held &&
  (held.direction === 'up' || held.direction === 'down') &&
  [held.from, held.to, held.threshold, held.at].every(Number.isFinite)
    ? {
        direction: held.direction,
        from: held.from,
        to: held.to,
        threshold: held.threshold,
        at: held.at,
      }
    : undefined;

export class IndexGuard {
  /**
   * `last`: the value Gladys already holds (`{ value, at }`), when known.
   * `saved`: the state kept in /data (`state()`), so that a value held back
   * stays held across a restart. `loadedAt`: when it is loaded; a value held
   * read back from /data is dated then (its old date would widen the range
   * an acceptance takes).
   */
  constructor(last, saved, loadedAt) {
    const kept = validLast(saved?.last);
    const known = validLast(last);
    if (kept && known && kept.value === known.value) {
      // The same value: its OLDEST date, the margin of the next rise counts from it.
      this.last = { value: kept.value, at: Math.min(kept.at, known.at) };
    } else {
      // Otherwise the most recent reference wins.
      this.last = kept && (!known || kept.at >= known.at) ? kept : known;
    }
    /**
     * A value held back until the user accepts it:
     * `{ direction: 'up' | 'down', from, to, threshold, at }`, `to` the last
     * value held, read at `at`. For a jump up, every value at or above
     * `threshold` stays held whatever the time.
     */
    const keptHeld = this.last ? validHeld(saved?.held) : undefined;
    this.held = keptHeld && Number.isFinite(loadedAt) ? { ...keptHeld, at: loadedAt } : keptHeld;
    /** The acceptance of the user: `{ direction, to, at }`, the value shown then. */
    this.accepted = undefined;
  }

  /** What /data keeps: the reference and the value held (never an acceptance). */
  state() {
    return { last: this.last ?? null, held: this.held ?? null };
  }

  /**
   * The user accepts the value held, as shown now. Returns what will be
   * counted (`{ direction, from, to }`), or undefined when nothing is held.
   */
  acceptHeld() {
    if (!this.held) {
      return undefined;
    }
    const { direction, from, to, at } = this.held;
    this.accepted = { direction, to, at };
    return { direction, from, to };
  }

  /** Whether `value` is within the acceptance: the value shown, plus the margin since. */
  withinAccepted(value, at) {
    const { to, at: since } = this.accepted;
    const top = to + margin(since, at);
    // Both ways a floor: an accepted drop is no licence for a lower value later.
    return value >= to && value <= top;
  }

  /** Whether `value`, read at `at`, may be published. A published value becomes the reference. */
  accept(value, at) {
    if (!Number.isFinite(value) || value <= 0) {
      return false;
    }
    if (!this.last) {
      return this.take(value, at);
    }
    if (value === this.last.value) {
      // Unchanged (a frozen reading): published, its date NOT moved.
      this.release();
      return true;
    }
    if (this.accepted) {
      if (this.withinAccepted(value, at)) {
        return this.take(value, at);
      }
      if (value < this.accepted.to) {
        // Under the floor accepted (a glitch): held, shown, never counted; the
        // acceptance stays for the value listed, which may come back.
        this.held = { direction: 'down', from: this.last.value, to: value, threshold: value, at };
        // Its margin counts from now: a long glitch never widens it.
        this.accepted = { ...this.accepted, at };
        return false;
      }
      // Above what the user accepted: held again, the acceptance dropped.
      this.accepted = undefined;
    }
    const up = this.held?.direction === 'up';
    if (up && value >= this.held.threshold) {
      // Held, however long ago the last value was published.
      this.held = { ...this.held, to: value, at };
      return false;
    }
    // While a value is held, the margin since the reference (maybe days old)
    // is not enough: the value must also fit the short margin counted from
    // the hold. Otherwise it becomes the value held itself, its kWh shown,
    // nothing billed without the user.
    const sinceHold = !this.held || value - this.last.value <= margin(this.held.at, at);
    if (sinceHold && follows(this.last, value, at)) {
      return this.take(value, at);
    }
    const direction = value > this.last.value ? 'up' : 'down';
    this.held = {
      direction,
      from: this.last.value,
      to: value,
      threshold: direction === 'up' && up ? Math.min(value, this.held.threshold) : value,
      at,
    };
    return false;
  }

  release() {
    this.held = undefined;
    this.accepted = undefined;
  }

  take(value, at) {
    this.last = { value, at };
    this.release();
    return true;
  }
}
