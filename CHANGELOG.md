# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Gira X1, HomeServer and FacilityServer over the Gira IoT REST API v2:
  switched lights, dimmers, coloured and tunable white lights (on/off and
  brightness), roller shutters and blinds (open, close, stop, position).
- Scene action "Run a Gira scene" (scene function id and number), and the
  "List the scenes" button.
- Registration with a user of the server; the token kept in memory only; a
  refused user name or password never tried again by itself.
- Certificate of the server trusted in two clicks (or typed); a changed one
  stops everything until trusted again.
- Writes off by default (one option for switching on and dimming, one for
  opening covers, one for scenes); turning off, stopping and closing never
  held back; a switch-off kept in /data until read back applied.
- Lists of functions: not offered, awnings (reversed direction), garage doors
  and gates (closing needs the opening option).
- Stops bounded in time: a cover stop never repeated, a close tried 20 s at
  most, a switch-off kept 10 min at most and confirmed in 10 s; the newest
  protective command of a device always wins.
- `countries`: DE, AT, CH (Gladys 5.3.0 or later).
