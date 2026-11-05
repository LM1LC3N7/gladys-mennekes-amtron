# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- MENNEKES AMTRON 4You 400/500 and 4Business 600/700 chargers over local Modbus TCP (registers
  of the manufacturer's document, protocol 1.5): status, connector and charging state, vehicle
  plugged in, error, power, current and voltage per phase, energy meter (guarded: never 0, a drop
  or a jump held until "Accept the held index"), energy and duration of the session, current
  offered to the vehicle, current limit set.
- The device keyed on the serial number read on the web interface of the charger (PublicInfo).
- "Pause charging" (HEMS limit 0 A), never held back, kept and checked until the charger shows it.
- "Resume charging" and the charging current, off by default, 6 A to 16 A (the range of the
  manufacturer's document), bounded by the configuration and the
  model and the minimum current of the charger.
