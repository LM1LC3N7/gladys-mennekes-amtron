# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).
The register map comes from the manufacturer's own document; some knowledge
comes from the project below, rewritten in JavaScript, not copied; the
changes are described below.

## MENNEKES Modbus TCP document

"AMTRON 4You 500 / 4Business 700 - Modbus TCP Server - Data Points",
protocol version 1.5 (firmware 1.5.21, release date 12.12.2025), published
by MENNEKES on mennekes.de
(`AMTRON-4You500-4Business700-Modbus-TCP-Register-v1.5.pdf`). The register
addresses, types, units and meanings of `src/constants.js` and
`src/model.js` are read there. No text of the document is reproduced.

## mennekes-amtron-ha

<https://github.com/nobelp/mennekes-amtron-ha> (Home Assistant custom
integration "Mennekes AMTRON", version 2.3.2, commit d7604aa of
2026-11-05), by nobelp. MIT License; full text below.

Ported in `src/constants.js`, `src/publicinfo.js` and `src/model.js`: the
read batches where they are the same registers (104/9, 131/2, 200/28, 706/1,
2000/1 of `coordinator.py`), the meter values as 32-bit values high word
first (`_to_int32`), the pause as the HEMS current limit at 0 A
(`switch.py`), the page `GET /api/v1/PublicInfo` of the web interface and its
fields `serialNumber`, `articleName` and `currentVersion` (`__init__.py`,
`entity.py`), the family 4You 400/500 and 4Business 600/700 sharing one
register set (`const.py`).

Changed: register 122 is read alone (the reference reads 122 to 124, and 123
is not in the document); the HEMS limit written is checked at the protocol
layer (0, or 6 A to 16 A as the document says, register 2000 only; the reference allows 32 A on 22 kW models) and capped by the
configuration and the minimum read; "resume" sets the current read before
the pause, never a fixed 16 A; every command is decided on a fresh read and
confirmed by a read back; the pause is never held back and is written again
until the charger shows it; Safe Current and communication timeout are only
read, never written; the serial number keys the Gladys device. Nothing of
Home Assistant itself is used.

```
MIT License

Copyright (c) 2026 nobelp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-p1-monitor and gladys-solakon

<https://github.com/LM1LC3N7/gladys-p1-monitor> (`src/guard.js`, commit
c0dd76c) and <https://github.com/LM1LC3N7/gladys-solakon> (`src/modbus/client.js`,
the structure of `src/app.js`, `src/publisher.js`, commit 718b315), and
`test/kit/` from gladys-testkit: Gladys integrations of the same author,
Apache License 2.0 (the `LICENSE` of this repository). The guard of the
energy index is taken as is (its tariff check left out, its constants
changed); the Modbus TCP session as is; the app adapted to the charger.
