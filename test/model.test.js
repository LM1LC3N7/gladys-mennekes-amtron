// -----------------------------------------------------------------------------
// What a read means (pure): units, plausibility, 0 never a measure where it
// means "not available".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE as R } from '../src/constants.js';
import { interpret, modelOf, protocolOf, serialOf } from '../src/model.js';

test('the meter: W, mA -> A, V; 0 V and a total at 0 are not measures', () => {
  const v = interpret({
    powerTotal: 7360,
    currentL1: 16020,
    currentL2: 0,
    voltageL1: 231,
    voltageL2: 0,
    energyTotal: 0,
  });
  assert.equal(v[R.POWER], 7360);
  assert.equal(v[R.CURRENT_L1], 16.02);
  assert.equal(v[R.CURRENT_L2], 0, '0 A is a real current');
  assert.equal(v[R.VOLTAGE_L1], 231);
  assert.equal(v[R.VOLTAGE_L2], undefined, '0 V: a phase not connected');
  assert.equal(v[R.ENERGY_INDEX], undefined, 'a total at 0 is not available');
  assert.equal(interpret({ energyTotal: 1234567 })[R.ENERGY_INDEX], 1234.567);
  assert.equal(interpret({ powerTotal: -20 })[R.POWER], 0, 'idle noise');
  assert.equal(interpret({ powerTotal: 90_000 })[R.POWER], undefined);
});

test('states: OCPP status, vehicle, errors, the limit and the pause', () => {
  assert.equal(interpret({ cpStatus: 3 })[R.STATUS], 'Charging');
  assert.equal(interpret({ cpStatus: 0 })[R.STATUS], undefined, 'undefined is not a state');
  assert.equal(interpret({ cpStatus: 12 })[R.STATUS], undefined);
  assert.equal(interpret({ vehicleState: 1 })[R.PLUGGED], 0);
  assert.equal(interpret({ vehicleState: 3 })[R.PLUGGED], 1);
  assert.equal(interpret({ vehicleState: 5 })[R.PLUGGED], undefined, 'E: unknown');
  const errors = interpret({ error1: 0, error2: 4, error3: 0, error4: 0 });
  assert.equal(errors[R.ERROR], 1);
  assert.equal(interpret({ error1: 0, error2: 0, error3: 0 })[R.ERROR], undefined);
  assert.equal(interpret({ hemsLimit: 0 })[R.PAUSED], 1);
  assert.equal(interpret({ hemsLimit: 5 })[R.PAUSED], 1, 'below 6 A the charger applies 0 A');
  assert.equal(interpret({ hemsLimit: 6 })[R.PAUSED], 0);
  assert.equal(interpret({ hemsLimit: 900 }).hemsLimit, undefined);
  assert.equal(interpret({ sessionEnergy: 5432, sessionDuration: 90 })[R.SESSION_DURATION], 1.5);
  assert.equal(interpret({ deviceId: 'AM' }).isAmtron, true);
  assert.equal(interpret({ deviceId: 'XX' }).isAmtron, false);
  assert.equal(interpret({}).isAmtron, undefined, 'unread is not "another device"');
});

test('identity texts: strict', () => {
  assert.equal(serialOf('1234567890'), '1234567890');
  assert.equal(serialOf('ab12'), 'AB12');
  assert.equal(serialOf('12 34'), undefined);
  assert.equal(serialOf('../x'), undefined);
  assert.equal(serialOf(1234), undefined);
  assert.equal(modelOf('AMTRON\n'), undefined);
  assert.equal(protocolOf('1.50'), 1.5);
  assert.equal(protocolOf('x'), undefined);
});
