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
  (Step-Up-Down 1) and close (Up-Down 1, position 0 included). Not by an
  option, a 429 pause, a project being read again, a read or a command in
  flight, full slots, nor a slow /data (never awaited on their path). They
  wait only for what the account needs (credentials, their acceptance, a
  trusted certificate) and are then kept and sent first. A switch-off stays
  kept (in /data) until a read started after the server's answer shows it
  applied; at most 4 answered sends; a newer command taken by the server
  lifts it. A cover move is done once taken, never replayed after a restart.
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
- /data unreadable is never taken for empty (nothing learnt or written over it).
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
