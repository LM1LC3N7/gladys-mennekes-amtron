# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`, PublicInfo through
`node:http`). It reads a MENNEKES AMTRON 4You/4Business EV charger over
Modbus TCP (port 502, no cloud, no authentication) and shows it as one Gladys
device per serial number; the pause never behind an option, resume and the
charging current behind an off-by-default option. Never tested with a real
device, not affiliated with MENNEKES.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap; app.boot() writes the pause kept in /data first
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                AmtronApp: the line (one session), polling, backoff, identity, device,
                          states, badge, status, buttons, command queue, the pause, the index
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    blocks, requests, types, the bounded write (pure)
src/publicinfo.js         the serial number over HTTP, bounded
src/model.js              raw values -> values: units, ranges, the maximum of the model (pure)
src/devices.js            the Gladys device, its commands and states (pure)
src/guard.js              the energy meter (from gladys-p1-monitor, pure)
src/publisher.js          states within 300/min
src/store.js              /data/mennekes-amtron-state.json
src/config.js             config_schema normalized
src/constants.js          register map, roles, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeAmtron.js  the fake charger behind the injected connector and PublicInfo
test/kit/                 virtual and real clocks, fake TCP server (from gladys-testkit)
```

## Rules

- **External ids are forever**: device `mennekes-amtron:<SERIAL>` (frozen
  rule), feature roles in `ROLE` of `src/constants.js`, manifest keys
  (`host`, `api_port`, `allow_commands`, `max_current`, `poll_interval`,
  `language`, the actions `test_connection` and `accept_held_index`).
- **Registers from the manufacturer's document only** (protocol 1.5); a block
  is a run of documented registers (`test/protocol.test.js`, the fake refuses
  the rest). The only write: 2000, function 6, 0 or 6 A to 32 A.
- **One Modbus connection at a time, one request at a time**: everything goes
  through `useLine`; commands take the line from a poll, the pause from
  anything.
- **The pause**: never behind the option, a read, a command, a backoff, the
  identity or a configuration not read; it drops the commands that arrived
  before it; never ended by time nor because it could not leave; no wait on
  /data longer than 200 ms on its path, the next check armed before any save.
- **Commands**: never a switch or a writable binary; refused unless
  `allow_commands` (checked on arrival and in `beforeSend`); serial number read
  over HTTP for each; bounded on arrival, on the fresh read and in
  `writeRequest`; confirmed only by the echo and a read back; never retried.
- **Energy meter**: never 0, never a drop nor a jump without the user.
- Never read sooner than the interval (button, scan, reconnection, restart);
  only the follow-up reads after a command (5 s, 20 s) and the keep-alive.
- **Answers are hostile**: MBAP frames and the PublicInfo body bounded and
  checked; implausible values unknown; never log the bytes received.
- Monotonic clock for every in-memory time; the session clock for the guard;
  the wall clock for /data only. Every wait on /data bounded (2 s).
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network beyond 127.0.0.1, and remove their temporary directories.
