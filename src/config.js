// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. No secret: the
// Modbus TCP server of the AMTRON has no password, and its PublicInfo page
// (the serial number) needs none.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CURRENT, DEFAULT_API_PORT, DEFAULT_PORT, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  api_port: DEFAULT_API_PORT,
  allow_commands: false,
  max_current: CURRENT.defaultCeiling,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address a device can have: never 0.x, multicast (224-239) nor reserved/broadcast. */
function unicastIPv4(host) {
  const parts = host.split('.').map(Number);
  return parts[0] !== 0 && parts[0] < 224 && parts[3] !== 255;
}

/**
 * The address of the charger typed by the user: an IPv4 address or a host
 * name, with an optional Modbus port (502 otherwise).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  // A control character anywhere (CR, LF pasted along) is refused, never trimmed away.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(String(raw ?? ''))) {
    return undefined;
  }
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unicastIPv4(host) ? { host, port } : undefined;
  }
  if (/^[\d.]+$/.test(host) || host.includes('..')) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A whole number typed or sent: a number, or digits only ('' and ' ' are not 0). */
function strictInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

const bounded = (value, { min, max }, fallback) => {
  const number = strictInteger(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, number));
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = typeof c.host === 'string' ? c.host.trim() : '';
  const address = typeof c.host === 'string' ? parseAddress(c.host) : undefined;
  const apiPort = strictInteger(c.api_port);
  const apiPortValid = apiPort !== undefined && apiPort >= 1 && apiPort <= 65535;
  return {
    /** Undefined when the address is invalid: nothing is read nor sent. */
    address,
    /**
     * The length of what was typed, when it is not a valid address: the text
     * itself is never shown again (something else may have been pasted there).
     */
    invalid: typed !== '' && !address ? typed.length : undefined,
    /** The HTTP port of the web interface (the serial number); undefined when invalid. */
    apiPort: apiPortValid ? apiPort : undefined,
    allowCommands: strictTrue(c.allow_commands),
    /** The highest charging current Gladys may set (A), on top of the maximum of the model. */
    maxCurrent: bounded(
      c.max_current,
      { min: CURRENT.min, max: CURRENT.max },
      CURRENT.defaultCeiling,
    ),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL, POLL_INTERVAL.default),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
