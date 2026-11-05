// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute for the
// whole integration: push() keeps the current value of a feature (the last
// one wins); unchanged values are skipped by publishChangedStates and sent
// again every 30 min. One send at a time (concurrent flushes join it), and the
// room of a batch is taken from the budget BEFORE it is sent, so two
// publications at once never exceed it. Whatever is left over (budget spent,
// Gladys unreachable) waits for the next flush, every second, but never
// longer than TIMINGS.freshFor after the value was read: an older value is
// dropped, never published as new (Gladys back after an outage). Never energy.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    /** featureId -> { value: { state } | { text }, at: when it was read (monotonic) } */
    this.pending = new Map();
    /** The times of the states counted in the last minute. */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value, at = this.now()) {
    this.pending.set(featureId, { value, at });
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.send().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async send() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < MINUTE);
    const room = Math.min(LIMITS.statesPerMinute - this.window.length, LIMITS.statesPerRequest);
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    for (const [featureId, entry] of [...this.pending]) {
      if (now - entry.at > TIMINGS.freshFor) {
        this.pending.delete(featureId);
      }
    }
    const batch = [];
    const kept = new Map();
    for (const [featureId, entry] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      kept.set(featureId, entry);
      batch.push({ device_feature_external_id: featureId, ...entry.value });
    }
    // Reserved now: the whole batch counts, whatever Gladys answers.
    for (let i = 0; i < batch.length; i += 1) {
      this.window.push(now);
    }
    try {
      await this.gladys.publishChangedStates(batch, { heartbeat: TIMINGS.stateHeartbeat });
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const [id, entry] of kept) {
        if (!this.pending.has(id)) {
          this.pending.set(id, entry);
        }
      }
      throw err;
    }
  }
}
