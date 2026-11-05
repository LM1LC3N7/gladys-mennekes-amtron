// -----------------------------------------------------------------------------
// The AMTRON -> one Gladys device, its features, its commands and its states
// (pure).
//
// `ext:<selector>:mennekes-amtron:<SERIAL>`: FROZEN RULE, the serial number
// the charger gives on its web interface (`serialNumber` of
// `GET /api/v1/PublicInfo`, letters, digits, - and _, 4 to 40, in upper case):
// the Modbus map has no serial number. Without a serial number read once at
// this address nothing is published (a fallback id would make a second device
// the day the serial reads again). Another serial at the same address is
// another device. The feature roles (src/constants.js ROLE) are published
// forever: never rename them. Every role is always built, so a republished
// device never loses a feature (a single-phase charger leaves L2 and L3
// empty).
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command. Pausing
// and resuming are two `button/push` features, the charging current a
// `text/select` of the whole amperes from 6 A to the ceiling.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor` (the
// meter) and the energy index (kWh, `energy-sensor/index`, the meter total of
// the charger, through the guard of src/guard.js); A and kWh on
// `electrical-vehicle-charge` (the limit set, the current signaled to the
// vehicle, the energy of the session); minutes on `duration`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, ROLE as R } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, word } from './i18n.js';

export const SERVICE = 'mennekes-amtron';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const current = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 80,
});
const voltage = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.VOLTAGE,
  unit: U.VOLT,
  min: 0,
  max: 500,
});
const evCurrent = (type) =>
  sensor({ category: C.ELECTRICAL_VEHICLE_CHARGE, type, unit: U.AMPERE, min: 0, max: 80 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [R.STATUS]: text,
  [R.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [R.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [R.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [R.ERROR]: binary,
  [R.PAUSED]: binary,
  [R.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 50_000,
  }),
  [R.CURRENT_L1]: current,
  [R.CURRENT_L2]: current,
  [R.CURRENT_L3]: current,
  [R.VOLTAGE_L1]: voltage,
  [R.VOLTAGE_L2]: voltage,
  [R.VOLTAGE_L3]: voltage,
  [R.ENERGY_INDEX]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 2_000_000,
  }),
  [R.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1_000_000,
  }),
  [R.SESSION_DURATION]: sensor({
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.MINUTES,
    min: 0,
    max: 43_200,
    keep_history: false,
  }),
  [R.SIGNALED_CURRENT]: evCurrent(T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT),
  [R.CURRENT_LIMIT]: evCurrent(T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT),
  [R.PAUSE]: button,
  [R.RESUME]: button,
  [R.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [R.PAUSE, R.RESUME, R.SET_CURRENT];

export const idsOf = (gladys, serial) => gladys.externalIds(SERVICE, serial);

/** The serial and role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  const match = new RegExp(`:${SERVICE}:([A-Z0-9_-]{4,40}):([a-z0-9-]{1,32})$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The options of the current select: 6 A up to the ceiling. */
export function currentOptions(ceiling) {
  const options = [];
  for (let amps = CURRENT.min; amps <= ceiling; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - CURRENT.min });
  }
  return options;
}

/**
 * The Gladys device of the charger. `ceiling`: the highest current the
 * commands accept now (the select is only an offer: the command checks it
 * again on a fresh read).
 */
export function buildDevice(gladys, { serial, model, firmware, language, ceiling }) {
  const i = idsOf(gladys, serial);
  const params = [
    { name: 'protocol', value: 'Modbus TCP' },
    { name: 'AMTRON_SERIAL', value: serial },
  ];
  if (firmware) params.push({ name: 'firmware', value: firmware });
  return {
    name: `${word(DEVICE_NAME, language)} ${serial.slice(-4)}`,
    external_id: i.device,
    model: model ? `MENNEKES ${model}`.slice(0, 64) : 'MENNEKES AMTRON',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: i.feature(role),
      ...DEFINITIONS[role],
      ...(role === R.SET_CURRENT ? { supported_options: currentOptions(ceiling) } : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(cpStatus) {
  switch (cpStatus) {
    case 1:
      return CONNECTOR_STATUS.AVAILABLE;
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      return CONNECTOR_STATUS.OCCUPIED;
    case 7:
      return CONNECTOR_STATUS.RESERVED;
    case 8:
      return CONNECTOR_STATUS.UNAVAILABLE;
    case 9:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState). No vehicle, unavailable or a
 * fault: IDLE, so a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(cpStatus) {
  switch (cpStatus) {
    case 3:
      return CHARGING_STATE.CHARGING;
    case 2:
    case 6:
      return CHARGING_STATE.EV_CONNECTED;
    case 5:
      return CHARGING_STATE.PAUSED_BY_VEHICLE;
    case 4:
      return CHARGING_STATE.PAUSED_BY_CHARGER;
    case 1:
    case 7:
    case 8:
    case 9:
      return CHARGING_STATE.IDLE;
    default:
      return undefined;
  }
}

/**
 * The states of the values given (a value not read this time is left out:
 * Gladys keeps its last one, never republished as new). Texts are stable
 * English keys, whatever the language (scenes keep working); a text is never
 * published as a number, a number never as a text. `ceiling`: the select shows
 * the limit set when it is one of its options.
 */
export function deviceStates(i, values, { ceiling } = {}) {
  const states = [];
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: i.feature(role), state: value });
    }
  };
  if (typeof values[R.STATUS] === 'string') {
    states.push({ device_feature_external_id: i.feature(R.STATUS), text: values[R.STATUS] });
  }
  if (values.cpStatus !== undefined) {
    add(R.CONNECTOR, connectorOf(values.cpStatus));
    add(R.CHARGING_STATE, chargingStateOf(values.cpStatus));
  }
  for (const role of [
    R.PLUGGED,
    R.ERROR,
    R.PAUSED,
    R.POWER,
    R.CURRENT_L1,
    R.CURRENT_L2,
    R.CURRENT_L3,
    R.VOLTAGE_L1,
    R.VOLTAGE_L2,
    R.VOLTAGE_L3,
    R.ENERGY_INDEX,
    R.SESSION_ENERGY,
    R.SESSION_DURATION,
    R.SIGNALED_CURRENT,
    R.CURRENT_LIMIT,
  ]) {
    add(role, values[role]);
  }
  const limit = values.hemsLimit;
  if (
    Number.isInteger(limit) &&
    limit >= CURRENT.min &&
    Number.isInteger(ceiling) &&
    limit <= ceiling
  ) {
    states.push({ device_feature_external_id: i.feature(R.SET_CURRENT), text: String(limit) });
  }
  return states;
}
