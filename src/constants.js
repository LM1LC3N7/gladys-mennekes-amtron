// -----------------------------------------------------------------------------
// MENNEKES AMTRON constants: the Modbus TCP map, manifest keys, feature roles,
// limits and timings.
//
// The AMTRON 4You 500 / 4Business 700 (and the 4You 400 / 4Business 600 of
// the same family) answer Modbus TCP on port 502, unit id 1, once the Modbus
// TCP server is enabled in their installer menu, without authentication.
// Every register below is in the manufacturer's own document "AMTRON 4You 500
// / 4Business 700 - Modbus TCP Server - Data Points", protocol version 1.5
// (firmware 1.5.21, 12.12.2025, mennekes.de, AMTRON-4You500-4Business700-
// Modbus-TCP-Register-v1.5.pdf): all holding registers, read with function 3,
// the HEMS current limit written with function 6. Only these requests are ever
// sent:
//   - read holding registers (function 3) of the blocks below, each one a run
//     of documented registers only (never a gap of the map);
//   - write single register (function 6) at 2000 (HEMS current limit, in A:
//     0 pauses the charge, 6 up to the maximum of the charger allow it).
// The batches of mennekes-amtron-ha (MIT, nobelp, 2.3.2) are the same where it
// reads the same registers (104/9, 131/2, 200/28, 706/1, 2000/1); its 122/3
// spans register 123, not in the document: Gladys reads 122 alone.
//
// Data types: uint16/int16 one register; uint32/int32 two registers, high
// word first; ASCII two characters per register, high byte first.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const DEFAULT_PORT = 502;
/** The unit id of the charger (manufacturer's document: "Unit Id 1"). */
export const UNIT_ID = 1;
/** The HTTP port of the charger's web interface (its serial number, `/api/v1/PublicInfo`). */
export const DEFAULT_API_PORT = 80;
/** Seconds between two reads (mennekes-amtron-ha reads every 30 s). */
export const POLL_INTERVAL = { min: 10, max: 3600, default: 30 };

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  WRITE_SINGLE: 0x06,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** Modbus exception "illegal data address". */
export const ILLEGAL_DATA_ADDRESS = 2;
/** Exceptions after which the charger did not apply a write (illegal function, address, value). */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** The registers written: the HEMS current limit (protocol 1.5). */
export const REG = {
  HEMS_LIMIT: 2000,
};

/**
 * The blocks read, in this order: `[address, type, key]` points inside one
 * read of `count` registers from `address`. `core`: an exception on it fails
 * the read (the identity, the state and the meter). The others are optional:
 * one refused with "illegal data address" before it was ever answered is not
 * served by this firmware (not read again until a restart); one that fails
 * leaves its values unknown that time. The HEMS limit comes right after the
 * identity: the stop sees it even when a later block fails.
 */
export const BLOCKS = [
  {
    key: 'identity',
    core: true,
    address: 141,
    count: 11,
    points: [
      [141, 'ascii1', 'deviceId'],
      [142, 'ascii10', 'model'],
    ],
  },
  {
    key: 'hems',
    address: 2000,
    count: 1,
    points: [[2000, 'u16', 'hemsLimit']],
  },
  {
    key: 'status',
    core: true,
    address: 104,
    count: 9,
    points: [
      [104, 'u16', 'cpStatus'],
      [105, 'u32', 'error1'],
      [107, 'u32', 'error2'],
      [109, 'u32', 'error3'],
      [111, 'u32', 'error4'],
    ],
  },
  {
    key: 'vehicle',
    core: true,
    address: 122,
    count: 1,
    points: [[122, 'i16', 'vehicleState']],
  },
  {
    key: 'meter',
    core: true,
    address: 200,
    count: 28,
    points: [
      [206, 'i32', 'powerL1'],
      [208, 'i32', 'powerL2'],
      [210, 'i32', 'powerL3'],
      [212, 'i32', 'currentL1'],
      [214, 'i32', 'currentL2'],
      [216, 'i32', 'currentL3'],
      [218, 'i32', 'energyTotal'],
      [220, 'i32', 'powerTotal'],
      [222, 'i32', 'voltageL1'],
      [224, 'i32', 'voltageL2'],
      [226, 'i32', 'voltageL3'],
    ],
  },
  {
    key: 'hemsConfig',
    address: 2010,
    count: 2,
    points: [
      [2010, 'u16', 'hemsMode'],
      [2011, 'u16', 'commStatus'],
    ],
  },
  {
    key: 'safety',
    address: 131,
    count: 2,
    points: [
      [131, 'u16', 'safeCurrent'],
      [132, 'u16', 'commTimeout'],
    ],
  },
  {
    key: 'signaled',
    address: 706,
    count: 1,
    points: [[706, 'u16', 'signaledCurrent']],
  },
  {
    key: 'minimum',
    address: 712,
    count: 1,
    points: [[712, 'u16', 'minCurrent']],
  },
  {
    key: 'session',
    address: 716,
    count: 4,
    points: [
      [716, 'u32', 'sessionEnergy'],
      [718, 'u32', 'sessionDuration'],
    ],
  },
  {
    key: 'protocol',
    address: 120,
    count: 2,
    points: [[120, 'ascii2', 'protocol']],
  },
];

export const blockOf = (key) => BLOCKS.find((b) => b.key === key);

/** The largest read (Modbus allows 125 registers). */
export const MAX_READ = 125;

/** Register 2010: 0 server off, 1 read only, 2 read and write (HEMS possible). */
export const HEMS_MODES = { OFF: 0, READ_ONLY: 1, READ_WRITE: 2 };

/** The Device Id register (141) of an AMTRON always reads "AM". */
export const DEVICE_ID = 'AM';

/**
 * The charging current, in whole amperes. The manufacturer's document allows
 * 0 (pause) and 6 A up to the maximum of the charger: 16 A for an 11 kW model,
 * 32 A for a 22 kW one (the model name, register 142, says which: "... 22 C2").
 * The configured ceiling (16 A by default) caps it further; the minimum
 * current read on the charger (712) raises the floor.
 */
export const CURRENT = {
  min: 6,
  max: 32,
  /** The maximum when the model name does not say 22 kW (the document says 6 A to 16 A). */
  defaultModelMax: 16,
  defaultCeiling: 16,
};

/** OCPP 1.6 charge point status (register 104). */
export const CP_STATUS = {
  0: 'Undefined',
  1: 'Available',
  2: 'Preparing',
  3: 'Charging',
  4: 'SuspendedEVSE',
  5: 'SuspendedEV',
  6: 'Finishing',
  7: 'Reserved',
  8: 'Unavailable',
  9: 'Faulted',
};

/** Vehicle state (register 122, IEC 61851 control pilot): A=1 ... E=5. */
export const VEHICLE_STATES = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' };

/** Manifest actions. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_INDEX: 'accept_held_index',
};

/**
 * Feature roles: the last part of the feature external ids, published
 * forever: never rename one.
 */
export const ROLE = {
  STATUS: 'status',
  CONNECTOR: 'connector',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  ERROR: 'error',
  PAUSED: 'paused',
  POWER: 'power',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  ENERGY_INDEX: 'energy-index',
  SESSION_ENERGY: 'session-energy',
  SESSION_DURATION: 'session-duration',
  SIGNALED_CURRENT: 'signaled-current',
  CURRENT_LIMIT: 'current-limit',
  PAUSE: 'pause',
  RESUME: 'resume',
  SET_CURRENT: 'set-current',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The lifetime counter (kWh), guarded before it reaches Gladys (src/guard.js). */
export const COUNTERS = [ROLE.ENERGY_INDEX];
/** The meter never rises faster than this on average (22 kW at most, with a margin). */
export const INDEX_MAX_KW = 25;
/** kWh always accepted on top (a late read). */
export const INDEX_SLACK_KWH = 0.05;

export const LIMITS = {
  /** Gladys accepts 300 states a minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Commands waiting in the queue at most. */
  queue: 16,
  /** An optional block failing this many reads in a row is skipped for the next 10 reads. */
  optionalFailures: 3,
  optionalSkip: 10,
  /** The PublicInfo answer is read up to this size, then cut. */
  publicInfoBytes: 16 * 1024,
};

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** A session closed gracefully waits this long for the charger to close its side. */
  closeWait: 500,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** A read or a write of /data that takes longer is given up (a stuck disk never holds anything). */
  storeWait: 2 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Gladys waits 5 s for the ack: every click is answered by 3.5 s (a command
   * or a stop still running goes on, and the answer says what is known); a
   * stop is tried (connection refused, closed, timeout) until 3 s after its
   * click.
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_500,
  commandConnectMax: 2_000,
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** The serial number read again over HTTP before a command, at most this long. */
  commandIdentityMax: 1_200,
  /** A command waiting its turn (a scene setting several values) starts within 15 s, or never. */
  queueWindow: 15 * SECOND,
  /** The configuration could not be read from Gladys: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A stop is written again only once the charger had the time to apply it. */
  applyDelay: 5 * SECOND,
  /** The stop waits this long at most for /data before its first byte (a stuck disk never holds it). */
  stopSaveWait: 200,
  /** A stop not seen applied is checked this often (read, then written again), never ended by time. */
  stopRetry: 15 * SECOND,
  /** A value set elsewhere after a stop is read again this soon: two reads in a row let the stop go. */
  holdConfirm: 2 * SECOND,
  /** A check that gave its turn up to a click or a command is tried again this soon. */
  checkYield: SECOND,
  /** Last values older than this are never sent again to Gladys (connected, device created). */
  freshFor: 2 * MINUTE,
  /** "Accept the held index": the second click 3 s to 5 min after the first. */
  acceptAfter: 3 * SECOND,
  acceptWithin: 5 * MINUTE,
  /** The serial number (HTTP) is read again this often, and at most this often after a failure. */
  identityEvery: HOUR,
  identityRetry: MINUTE,
  /** One read of PublicInfo. */
  identityTimeout: 3 * SECOND,
  /** While a limit below the Safe Current is set, a read at least this often (half the timeout), never more often than every 5 s. */
  keepAliveMin: 5 * SECOND,
};
