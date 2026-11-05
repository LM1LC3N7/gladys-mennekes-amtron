# gladys-mennekes-amtron

[Gladys Assistant](https://gladysassistant.com) external integration for **MENNEKES AMTRON 4You
400/500 and 4Business 600/700** EV chargers, through their **Modbus TCP** server on the local
network (port 502, no cloud, no password): status, vehicle plugged in, power, current and voltage
per phase, energy meter (guarded), energy and duration of the session, current offered and limit
set; **pause** never held back, **resume** and the **charging current** behind an off-by-default
option, bounded by the model and the configuration. **Never tested with a real device. Not
affiliated with MENNEKES.** Modbus TCP has no authentication: keep the charger on a trusted
network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (AmtronApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  blocks, requests, types, bounded write (pure)
                                  ├─ src/publicinfo.js       the serial number: GET /api/v1/PublicInfo, bounded
                                  ├─ src/model.js            units, plausible ranges, the maximum of the model (pure)
                                  ├─ src/devices.js          the device, its commands and states (pure)
                                  ├─ src/guard.js            energy meter: no 0, no drop, no jump (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/mennekes-amtron-state.json
```

- **Reads**: one connection per poll (every 30 s, 10 s – 1 h), function 3 on runs of registers of
  the manufacturer's document (protocol 1.5), the Device Id and model first, then closed. The
  test button, Discovery, a reconnection and a restart never read sooner than the interval (time
  kept in `/data` before the read). While a limit below the Safe Current is set, at least every
  half communication timeout of the charger (never under 5 s).
- **Device**: `ext:<selector>:mennekes-amtron:<SERIAL>` (frozen rule), the serial number read on
  the web interface (`/api/v1/PublicInfo`, no login) once per address, every hour and after every
  outage, kept in `/data` with the Modbus model; a read whose Device Id or model does not match
  publishes nothing.
- **Pause** (protective): 2000 = 0 A, never behind the option, a read, a command, a backoff or the
  identity; drops every command that arrived before; retried for 3 s; kept in `/data` and checked
  every 15 s, never ended by time: let go on the pause read, on another limit read twice in a row
  once it was written, or on a newer current sent; written again at a restart before the
  configuration is read.
- **Commands** (`allow_commands`, off by default): resume (the current read before the pause) and
  the charging current (6 A to min(ceiling, 16 A or 32 A for a 22 kW model), never below register
  712). Serial number read over HTTP for each command, fresh Modbus read (Device Id, model, HEMS
  mode, limit), write checked again at the protocol layer, echo and read back.

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
gi ci          # the whole CI locally (VM tooling)
```

Registers: the MENNEKES document "AMTRON 4You 500 / 4Business 700 - Modbus TCP Server - Data
Points", protocol 1.5; the PublicInfo page and the read batches from
[mennekes-amtron-ha](https://github.com/nobelp/mennekes-amtron-ha) 2.3.2 (MIT, see
`THIRD_PARTY_NOTICES.md`).

## License

Apache-2.0, see [LICENSE](LICENSE).
