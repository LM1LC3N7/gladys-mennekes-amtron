// -----------------------------------------------------------------------------
// The Gladys device (pure): ids, categories and units of the core, options
// the core accepts (its own rules applied, as the Discovery does: one error
// rejects the whole discovery), no switch, the states of the OCPP status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ROLE as R } from '../src/constants.js';
import {
  COMMAND_ROLES,
  CONNECTOR_STATUS,
  CHARGING_STATE,
  ROLES,
  buildDevice,
  chargingStateOf,
  connectorOf,
  currentOptions,
  deviceStates,
  parseFeatureId,
} from '../src/devices.js';

const CORE = '/home/claude/code/Gladys/server/utils';
const require = createRequire(import.meta.url);
const core = existsSync(`${CORE}/constants.js`) ? require(`${CORE}/constants.js`) : undefined;
const normalizeSupportedOptions = existsSync(`${CORE}/normalizeSupportedOptions.js`)
  ? require(`${CORE}/normalizeSupportedOptions.js`).normalizeSupportedOptions
  : undefined;

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};

const devices = [16, 32].flatMap((ceiling) =>
  ['en', 'fr'].map((language) =>
    buildDevice(gladys, { serial: '1234567890', model: 'AMTRON 4You 560 11', language, ceiling }),
  ),
);
const device = devices[0];

test('ids: the serial number, the role; parsed back strictly', () => {
  assert.equal(device.external_id, 'ext:test:mennekes-amtron:1234567890');
  assert.deepEqual(parseFeatureId('ext:test:mennekes-amtron:1234567890:pause'), {
    serial: '1234567890',
    role: R.PAUSE,
  });
  assert.equal(parseFeatureId('ext:test:mennekes-amtron:1234567890:nope'), undefined);
  assert.equal(parseFeatureId('ext:test:mennekes-amtron:abc1234:pause'), undefined);
  assert.equal(parseFeatureId(42), undefined);
  assert.equal(device.features.length, ROLES.length, 'every role always built');
});

test('no switch, no writable binary; the writable features are the commands', () => {
  for (const f of device.features) {
    assert.ok(f.type !== 'binary' || f.read_only, `${f.name}: a writable binary`);
    assert.notEqual(f.category, 'switch', f.name);
    const role = parseFeatureId(f.external_id).role;
    assert.equal(f.read_only, !COMMAND_ROLES.includes(role), role);
  }
});

test('units: only those the core lists for the category', { skip: !core }, () => {
  const byCategory = core.DEVICE_FEATURE_UNITS_BY_CATEGORY;
  for (const f of device.features) {
    if (f.unit === undefined) continue;
    assert.ok(byCategory[f.category]?.includes(f.unit), `${f.name}: ${f.category} ${f.unit}`);
  }
  const types = core.DEVICE_FEATURE_TYPES;
  for (const f of device.features) {
    const category = Object.keys(core.DEVICE_FEATURE_CATEGORIES).find(
      (k) => core.DEVICE_FEATURE_CATEGORIES[k] === f.category,
    );
    assert.ok(category, f.category);
  }
  assert.ok(types.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED);
});

test('supported options: the rules of the core on every option published', () => {
  for (const d of devices) {
    for (const f of d.features.filter((x) => x.supported_options)) {
      const values = new Set();
      for (const o of f.supported_options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'sort_order', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.length > 0 && o.label === o.label.trim(), `label "${o.label}"`);
        assert.ok(
          typeof o.value === 'string'
            ? o.value === o.value.trim() && o.value
            : Number.isInteger(o.value),
        );
        assert.ok(Number.isInteger(o.sort_order));
        assert.ok(!values.has(String(o.value)), 'unique values');
        values.add(String(o.value));
      }
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues: true }),
        );
      }
    }
  }
  assert.deepEqual(
    currentOptions(8).map((o) => o.value),
    ['6', '7', '8'],
  );
});

test('the OCPP status: connector and charging state as the core reads them', () => {
  assert.equal(connectorOf(1), CONNECTOR_STATUS.AVAILABLE);
  assert.equal(connectorOf(3), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(connectorOf(9), CONNECTOR_STATUS.FAULTED);
  assert.equal(connectorOf(0), undefined);
  assert.equal(chargingStateOf(3), CHARGING_STATE.CHARGING);
  assert.equal(chargingStateOf(4), CHARGING_STATE.PAUSED_BY_CHARGER);
  assert.equal(chargingStateOf(5), CHARGING_STATE.PAUSED_BY_VEHICLE);
  assert.equal(chargingStateOf(1), CHARGING_STATE.IDLE);
  assert.equal(chargingStateOf(undefined), undefined);
});

test('states: a text never as a number, out of range dropped, the select within the ceiling', () => {
  const ids = gladys.externalIds('mennekes-amtron', '1234567890');
  const states = deviceStates(
    ids,
    {
      [R.STATUS]: 'Charging',
      cpStatus: 3,
      [R.POWER]: 99_999,
      hemsLimit: 20,
      [R.CURRENT_LIMIT]: 20,
    },
    { ceiling: 16 },
  );
  const byRole = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s]),
  );
  assert.equal(byRole.status.text, 'Charging');
  assert.equal(byRole.power, undefined, 'beyond 50 kW: not a measure');
  assert.equal(byRole['set-current'], undefined, '20 A is not an option under a 16 A ceiling');
  assert.equal(byRole['current-limit'].state, 20);
});
