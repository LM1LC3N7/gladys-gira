# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It bridges a Gira X1, HomeServer or
FacilityServer through the Gira IoT REST API v2 (official PDF "Gira IoT REST
API v2", 01.07.2020).

## Commands

```bash
npm install
gi test                                   # or npm test (node --test --test-timeout=60000)
node --test test/commands.test.js         # one file (through memcap on the dev VM)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # cover.png (800x534), plain Node
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutants of the guards, one at a time
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        GiraApp: lifecycle, token, reads, commands, stops, buttons
src/gira.js                       REST client on a pinned TLS socket, answers, registration
src/model.js                      UI configuration -> Gladys devices, readers, writers (pure)
src/store.js                      /data: pins, refused-credentials mark, pause, kept switch-offs
src/publisher.js                  states within 300/min
src/config.js                     DEFAULT_CONFIG (mirrors the manifest) + normalization
src/i18n.js                       texts in English and French
test/helpers/fakeGira.js          simulated Gira server (HTTPS) on 127.0.0.1, from the PDF
test/kit/                         parts of gladys-testkit (clocks, certificates)
scripts/mutants.mjs               mutants of the guards (list and runner)
```

## Safety rules of this integration

- **Writes off by default**: switching on and dimming (`allow_control`),
  opening covers and any position but closed (`allow_open`), scenes
  (`allow_scenes`). Never a `switch` feature.
- **Stops are never held back**: turn off (brightness 0 included), cover stop
  (Step-Up-Down 1, 0 on an awning; a gate without Movement only with
  `allow_open`, then on this same path) and close (Up-Down 1, position 0
  included; an awning closes up, a gate never closes without `allow_open`).
  Not by an option, a 429 pause, a project being read again, a read or a
  command in flight, full slots, nor a slow /data. One guard per target, the newest wins (a replaced
  guard never writes a byte); a protective request waits for the one of its
  target already written.
- **Bounded**: a stop (Step-Up-Down, not idempotent; 0 on an awning) is never
  repeated once something reached the server; never reached, it is tried
  again every ~1 s within 3 s; with Movement read before each new try, 0
  gives it up and only a read of 1 stretches the tries to 10 s (not read: the
  3 s window); a gate stop leaves only when Movement does not show it at rest
  (its first try leaves when the read fails; without Movement: `allow_open`,
  read again before each try and in `beforeSend`); a close is
  retried while nothing reached the server, at most 20 s; a switch-off never
  sent is kept (dated in /data) at most 10 min; once answered, it is confirmed
  in a 10 s window only (reads at 0, 2, 5 s, never in a 429 pause), then
  dropped. Nothing that reached the server is replayed after a restart.
- **Nothing sent before a stop leaves after it**: every command checks the
  stop count of its target right before its first byte (`beforeSend`).
- **A read started before a command never applies to its target after it**
  (marks given when a request leaves).
- Other commands leave within 3.5 s or not at all, every check (option,
  account, pause, project read) done again in `beforeSend`.
- The password goes only in the registration (`POST /clients`, Basic), the
  token only as the `token` query parameter (PDF 2.3), both only to the
  configured address, on a connection whose certificate is the pinned one,
  checked before the first byte; never logged, never in /data, a status nor an
  error (`cleanReason` strips them from the server's messages). The token
  lives in memory only. The first certificate is trusted on two clicks (or
  typed); a changed one is never learnt alone.
- Only a 401 of the registration refuses the account (6-bit salted mark in
  /data), never tried again until new credentials or the Test button. A
  401/403 elsewhere is not a refusal: on the main read (`uiconfig/uid`), one
  new registration then the read again, once; on the values of a function,
  "not read", spaced; on a command, "refused on this route".
- /data unreadable is never taken for empty (nothing learnt or written over
  it); read again every 10 s, one read at a time, then adopted.
- `excluded_functions` (never offered nor commanded), `awning_functions`
  (direction reversed), `gate_functions` (closing needs `allow_open`).
- Clocks: monotonic for every decision; wall time only for /data.

## Rules

- **External ids are forever**: `function:<function uid>`, built with
  `gladys.externalIds`. Changing one orphans the user's devices. The same goes
  for the manifest keys and the feature keys (`on`, `brightness`, `state`,
  `position`).
- **A device published again never loses a feature** (`app.publishDevices`).
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  that package.json, the lock and the manifest agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync with
  the code.
- **Tests never touch the network** beyond 127.0.0.1; every wait is bounded
  (a test fails, it never hangs).
