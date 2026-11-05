# TODO — MENNEKES AMTRON v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-05): one AMTRON by address over Modbus
      TCP (registers of the manufacturer's document, protocol 1.5), one short
      connection per read, the serial number from PublicInfo (HTTP), one device
      per serial, states, energy meter through the guard of gladys-p1-monitor
      with the two-click acceptance, "Pause charging" never held back (kept in
      /data, checked every 15 s, written again at a restart), "Resume charging"
      and the charging current behind `allow_commands` (off), the keep-alive
      below the Safe Current, test button, docs en/fr, cover. Tested against a
      simulated charger only (virtual clock, and a real local TCP server on the
      real clock x20).
- [ ] **Milestone 2 — real charger**: run against a real AMTRON (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: phase switch mode (2020-2023), the charging point
      network (600-633, master only), the power limit (2002, 2012-2013), the
      charging history of the REST API (installer password: a secret, its own
      review).

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest, `docker_image`);
  the Release workflow bumps it afterwards.
- **Registers**: only those of the MENNEKES document "AMTRON 4You 500 /
  4Business 700 - Modbus TCP Server - Data Points", protocol 1.5 (firmware
  1.5.21, 12.12.2025). Every block is a run of documented registers
  (`test/protocol.test.js`): the reference's 122/3 spans 123, not documented,
  so 122 is read alone. The only write is 2000 (HEMS current limit) with
  function 6: 0 or 6 A to 16 A, checked at the protocol layer.
- **Pause = 2000 = 0 A** (the document: "To pause the charging session, set
  the register to 0 Ampere"); confirmed when the read back is below 6 A
  (the charger applies 0 A below 6 A). The deprecated copy 1000 is never
  written: a firmware without 2000 refuses the pause (exception), the status
  and the docs say so, and the pause stays kept and written again.
- **Identity**: the Modbus map has no serial number. It is read on
  `GET /api/v1/PublicInfo` (no login, as mennekes-amtron-ha does) with every
  read (in parallel, bounded, the line never held) and before every command,
  at the address the Modbus socket reached (a host name resolved once, r1
  m2); kept in /data with the model of register 142. Another serial is
  another device. When the page cannot be read (unreadable is not another
  charger), a read is published to the serial kept only if register 141 =
  "AM" and the model matches; a command is refused. Without a serial read
  once, nothing is published (no fallback id).
- **16 A at most** (review r1, m1): the document says for 2000 "Allowed
  values are therefore 0A and 6A to 16A", for the whole family.
  mennekes-amtron-ha 2.3.2 allows 32 A on 22 kW models, untested above 16 A
  by its author: not followed. To check on a real 22 kW charger before ever
  allowing more. The configured ceiling (16 A by default) caps it further,
  the minimum current read (712) raises the floor (above the ceiling: every
  current refused). Register 134 (operator current
  limit) is not used as a bound: it includes the HEMS limit itself.
- **Resume** writes the last current >= 6 A read for the serial (kept in
  /data), bounded again; refused when none is known (never a fixed value).
  No state is saved before a resume or a current (no guard to set), so a
  failed /data save never blocks them, nor the pause.
- **Keep-alive**: in HEMS read and write mode, while the limit read is below
  the Safe Current, the interval is at most half the timeout (5 s at least,
  so a timeout under 10 s cannot be kept): otherwise the charger would apply
  the Safe Current and charge again. Since r1: a failed read is tried again
  within it, unread 131/132/2010 keep the last values (a pause with 131 never
  read: 5 s), and it is kept in /data so the first read after a restart comes
  within it. Safe Current and timeout are never written;
  the status and the docs say how to keep a pause without Gladys (Safe Current
  0 A).
- **Commands** refused unless the HEMS mode (2010) reads 2.
- **No `keywords` nor `countries`** in the manifest (DE, AT, EU noted here);
  categories `vehicles` and `energy`.
- **Energy meter** = register 218 (meter total, Wh), `energy-sensor/index`,
  guard of gladys-p1-monitor (25 kW of margin), session clock (wall at the
  start + monotonic time since).

- **Review r1** (2026-11-05): one pause held per charger (a pause or a
  command to another address never lets it go, its reads never shown on the
  device of the configuration); with a pause held, the current and resume
  always write; a /data slow to read still gives its pauses; /data saves
  coalesced (one running, one waiting).

## To check on a real charger

- That 141 reads "AM" and 142 the model name (its exact text, 20 characters
  at most, "22" in the name of a 22 kW model).
- That PublicInfo answers without a login on port 80, and the shape of
  `serialNumber` (letters and digits?).
- What the charger answers to a write in read-only mode (exception code) and
  above the maximum of the model (refused or capped?).
- Whether 2000 keeps its value across a reboot of the charger, and what it
  reads after a Safe Current fallback.
- Whether the charger accepts a new Modbus connection right after Gladys
  closed one (single client).
