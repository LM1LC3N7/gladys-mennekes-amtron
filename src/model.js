// -----------------------------------------------------------------------------
// What the raw values of a read mean (pure): plausibility ranges, units, the
// codes of the states. A value outside its plausible range is unknown, never
// published; the meter total at 0 is unknown ("not available", never a
// measure of 0); a voltage of 0 V is a phase not connected (L2 and L3 of a
// single-phase charger), not a measure.
//
// Units (manufacturer's document): energies in Wh, powers in W, currents of
// the meter in mA, voltages in V, the HEMS limit, the Safe Current, the
// signaled and minimum currents in A, the session duration in s.
// -----------------------------------------------------------------------------

import { CP_STATUS, CURRENT, DEVICE_ID, ROLE as R, VEHICLE_STATES } from './constants.js';

const within = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

const round = (value, digits = 0) => {
  if (value === undefined) return undefined;
  const f = 10 ** digits;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** A power that is >= 0 by nature: small negatives (idle noise) read as 0. */
const positive = (value, max) => {
  const v = within(value, -100, max);
  return v === undefined ? undefined : Math.max(0, round(v));
};

/** A serial number Gladys keys the device on: letters, digits, - and _, 4 to 40, in upper case. */
export function serialOf(text) {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(text)
    ? text.toUpperCase()
    : undefined;
}

/** The model name (register 142, 20 characters), printable and short, else undefined. */
export const modelOf = (text) =>
  typeof text === 'string' && /^[\x20-\x7e]{1,40}$/.test(text)
    ? text.trim() || undefined
    : undefined;

/**
 * The highest current of the model: 32 A when its name says 22 kW (the 4You
 * 560 22 C2), else 16 A, as the manufacturer's document says (6 A to 16 A).
 */
export function modelMax(model) {
  return typeof model === 'string' && /(?:^|\s)22(?:\s|$|kw)/i.test(model)
    ? CURRENT.max
    : CURRENT.defaultModelMax;
}

/** A protocol version "X.XX" (register 120) as a number, else undefined. */
export function protocolOf(text) {
  const match = typeof text === 'string' ? /^(\d{1,2})\.(\d{1,2})$/.exec(text.trim()) : null;
  return match ? Number(`${match[1]}.${match[2]}`) : undefined;
}

/** A current in whole amperes of a register (0 to 80), else undefined. */
const amps = (value) => within(value, 0, 80);

/**
 * The values of a read, by key (the feature roles, plus the identity and the
 * raw values the commands and the stop decide on): only those known this time.
 */
export function interpret(raw) {
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  put('deviceId', typeof raw.deviceId === 'string' ? raw.deviceId : undefined);
  put('isAmtron', raw.deviceId === undefined ? undefined : raw.deviceId === DEVICE_ID);
  put('model', modelOf(raw.model));
  put('protocol', protocolOf(raw.protocol));

  const status = Number.isInteger(raw.cpStatus) && raw.cpStatus >= 1 ? raw.cpStatus : undefined;
  if (status !== undefined && Object.hasOwn(CP_STATUS, status)) {
    put('cpStatus', status);
    put(R.STATUS, CP_STATUS[status]);
  }
  const errors = [raw.error1, raw.error2, raw.error3, raw.error4];
  if (errors.every((e) => Number.isInteger(e) && e >= 0)) {
    put(R.ERROR, errors.some((e) => e !== 0) ? 1 : 0);
    put('errorCodes', errors.map((e) => e.toString(16).toUpperCase().padStart(8, '0')).join(' '));
  }
  const vehicle = Object.hasOwn(VEHICLE_STATES, raw.vehicleState) ? raw.vehicleState : undefined;
  put('vehicleState', vehicle);
  // A = no vehicle; B, C, D = a vehicle plugged in; E (error): unknown.
  if (vehicle !== undefined && vehicle !== 5) put(R.PLUGGED, vehicle === 1 ? 0 : 1);

  put(R.POWER, positive(raw.powerTotal, 50_000));
  const phases = [
    [raw.currentL1, raw.voltageL1, R.CURRENT_L1, R.VOLTAGE_L1],
    [raw.currentL2, raw.voltageL2, R.CURRENT_L2, R.VOLTAGE_L2],
    [raw.currentL3, raw.voltageL3, R.CURRENT_L3, R.VOLTAGE_L3],
  ];
  for (const [current, voltage, currentRole, voltageRole] of phases) {
    const ma = within(current, -1000, 80_000);
    put(currentRole, ma === undefined ? undefined : Math.max(0, round(ma / 1000, 2)));
    // 0 V: the phase is not connected, not a measure.
    put(voltageRole, round(within(voltage, 50, 500), 1));
  }
  // The meter total (Wh): 0 is "not available", a counter never counts down to 0.
  const wh = within(raw.energyTotal, 1, 2_000_000_000);
  put(R.ENERGY_INDEX, wh === undefined ? undefined : round(wh / 1000, 3));

  const limit = amps(raw.hemsLimit);
  if (limit !== undefined) {
    put('hemsLimit', limit);
    put(R.CURRENT_LIMIT, limit);
    // Below 6 A the charger applies 0 A (the document): paused.
    put(R.PAUSED, limit < CURRENT.min ? 1 : 0);
  }
  put('hemsMode', within(raw.hemsMode, 0, 2));
  put('commStatus', within(raw.commStatus, 0, 1));
  put('safeCurrent', amps(raw.safeCurrent));
  put('commTimeout', within(raw.commTimeout, 0, 0xffff));
  put(R.SIGNALED_CURRENT, amps(raw.signaledCurrent));
  put('minCurrent', amps(raw.minCurrent));
  const session = within(raw.sessionEnergy, 0, 1_000_000_000);
  put(R.SESSION_ENERGY, session === undefined ? undefined : round(session / 1000, 3));
  const seconds = within(raw.sessionDuration, 0, 30 * 86_400);
  put(R.SESSION_DURATION, seconds === undefined ? undefined : round(seconds / 60, 1));
  return values;
}
