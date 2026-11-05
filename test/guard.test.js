import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexGuard } from '../src/guard.js';

const H = 3_600_000;
const MINUTE = 60_000;

test('the counter guard: never 0, a drop and a jump held, the margin per hour', () => {
  const g = new IndexGuard({ value: 100, at: 0 }, null, 0);
  assert.equal(g.accept(0, H), false);
  assert.equal(g.accept(-1, H), false);
  assert.equal(g.accept(99, H), false);
  assert.equal(g.held.direction, 'down');
  assert.equal(new IndexGuard(undefined, null, 0).accept(0, H), false, 'never 0, even first');
  const rise = new IndexGuard({ value: 100, at: 0 }, null, 0);
  assert.equal(rise.accept(124, H), true, 'within 25 kWh per hour');
  assert.equal(rise.accept(200, 2 * H), false);
  assert.equal(rise.held.direction, 'up');
});

test('index guard: an accepted drop is the floor, a lower value later is held', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  assert.equal(guard.accept(5, 2 * MINUTE), false, 'never 5 kWh without a click');
  assert.equal(guard.held.to, 5);
  assert.equal(guard.last.value, 1000);
  // The value accepted comes back: it follows, from the floor accepted.
  assert.equal(guard.accept(12.01, 3 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: readings under an accepted floor for hours never widen the acceptance', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  let t = 2 * MINUTE;
  for (; t < 15 * 60 * MINUTE; t += MINUTE) assert.equal(guard.accept(5, t), false);
  assert.equal(guard.accept(22, t), false, '22 kWh after 15 h under the floor: held');
  assert.equal(guard.held.to, 22);
  // A value above the acceptance dropped it: 12.01 needs a new acceptance.
  assert.equal(guard.accept(12.01, t + MINUTE), false);
  assert.equal(guard.held.direction, 'down');
});
