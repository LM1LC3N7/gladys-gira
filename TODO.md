# TODO — Gira v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-14): REST client on a pinned TLS
      connection, registration with a user of the server, UI configuration,
      switched lights, dimmers (and coloured / tunable white lights as
      dimmers), shutters and blinds, scene action, kept stops, en/fr, docs,
      cover. Tested against a simulated server built from the official PDF
      only.
- [ ] **Milestone 2 — real server**: run against a real Gira X1 (firmware
      2.4 or later) and a HomeServer; check the scene numbers (0-63 or 1-64),
      the values of Binary data points ("0"/"1" or "true"/"false"), the size
      of a large UI configuration, the Gira One.
- [ ] **Milestone 3 — more**: colour (Red/Green/Blue/White, written together
      through `PUT /values`), colour temperature, slats, heating and cooling
      (setpoints bounded, frost floor never held back), status values as
      sensors, value callbacks (needs a port of the container reachable from
      the server: not possible today).

## Decisions

- Version 0.1.0 set by hand in package.json, the lock, the manifest and
  `docker_image`. SDK `^0.16.0` (latest published, 2026-11-14). Not in the
  manifest: `keywords`.
- `countries`: DE, AT, CH (Louis's decision of 2026-11-12, mono- or
  few-country modules): Gira's country sites for Austria (gira.com/at/de) and
  Switzerland (gira.ch) list the Gira X1, the Gira One and the HomeServer
  (checked 2026-11-14). `gladys_version` >= 5.3.0.
- Reference: the official PDF "Gira IoT REST API v2" (01.07.2020, DE and EN).
  EricHier/gira-iot-rest-api (MIT) read as an example only: it sets
  `rejectUnauthorized: false` without a pin, not reproduced.
- TLS: the PDF says the server cannot show a trusted certificate. The CA check
  is replaced by an explicit pin: confirmed by two clicks of "Trust the
  certificate" (the first shows the fingerprint, nothing else is sent), or
  typed. No pin: nothing is sent at all (the Test button only shows the
  fingerprint). Every connection is checked before its first byte. One HTTPS
  connection per request, `Connection: close`.
- Access: `POST /api/v2/clients` with Basic (user name, password) and the
  client id `io.github.lm1lc3n7.gladys-gira`; the server gives the same token
  again to the same user (PDF 4.2), so the token stays in memory only and a
  start registers again (the first read, or the first stop). Nothing in /data
  but a 6-bit mark of refused credentials. A 403 at the registration (user
  without the right) is a failure with backoff, not a refusal.
- Identity: the pinned certificate is the server; UIDs are persistent and not
  given again soon (PDF 2.1), so the external ids are `function:<uid>`. A
  command checks the channel type of the device param against the current
  project: another kind refuses all but the stops.
- Reads: `GET /uiconfig/uid` each time (the main read, the one that tells a
  lost token), the whole `GET /uiconfig?expand=dataPointFlags` when the id
  changed (no command but the stops until then), then `GET /values/<function>`
  of each created function with a readable data point, one at a time (150 per
  read, in turn beyond). All value reads failing = a failed read. Interval 30
  to 3600 s (60). Callbacks not used (the server cannot reach the container).
- Writes: one data point per `PUT /values/<uid>` (`{ "value": n }`). Off by
  default: on and brightness (`allow_control`), open and any position but
  closed (`allow_open`), scenes (`allow_scenes`). Brightness 0 = OnOff 0;
  position 0 = Up-Down 1. Stop = Step-Up-Down 1 (KNX: stops a moving cover; on
  one at rest, a step down). Confirmed by a read for OnOff, Brightness (within
  1. and Position (within 2); Up-Down is write only: done once taken, read
     again after 5 and 20 s.
- Covers (review r1): no way in the API to tell an awning or a gate from a
  shutter; three configuration lists by function id: not offered (nothing,
  not even a stop), awnings (close = up, protective; open = extend, option),
  gates (close needs `allow_open`, stop protective).
- Guards (review r1, B1/B2/I1/I2): one per target, the newest wins, one
  protective request in flight per target; a stop sent once (retried only
  when nothing reached the server, within ~250 ms); a close retried while not
  reached, 20 s at most; a switch-off kept while not reached (dated in /data,
  10 min at most), confirmed in a 10 s window after its answer (reads 0, 2,
  5 s, none in a 429 pause), then dropped. A 401/invalidToken on a stop:
  one registration at once (the stop's own, never waiting for the reads').
  At most 8 protective connections at once.
- /data slow or unreadable at start: read again every 10 s (one read at a
  time), adopted with the session started again.
- Not offered: Trigger and Press and hold (may drive a door opener), heating,
  sauna, audio, cameras, links, status values, value transmitters.
- Scenes: scene action with the function id (given by "List the scenes", no
  request) and the number, sent as is (0 to 64), to `Execute` (scene set) or
  `Scene` (scene extension).
- 423 Locked: a read fails and comes back with the backoff; a command is
  refused ("locked"); a stop is not counted and sent again every 5 s.
- Mutants: `scripts/mutants.mjs` (list and runner, one at a time, own temp
  directory, process group killed at the deadline).
