# gladys-gira

[Gladys Assistant](https://gladysassistant.com) external integration for the
**Gira X1, HomeServer and FacilityServer**, through the official **Gira IoT
REST API v2** of the server: switched lights, dimmers, roller shutters and
blinds, and the scenes of the server (scene action). Local only (HTTPS of the
server, certificate pinned on the user's confirmation).

Unofficial, not affiliated with Gira. **Never tested with a real device yet.**

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Access: a user of the Gira server (user name and password) registers the
  client and gets a token, kept in memory only.
- Safety: writes are off by default (switching on and dimming, opening covers,
  scenes: one option each); turning off a light and stopping or closing a
  cover are never held back by an option, a pause, a read or a command in
  flight (a switch-off is kept until read back applied).
- Store: Germany, Austria and Switzerland (`countries`), where Gira sells the
  X1, the One and the HomeServer (gira.de, gira.com/at, gira.ch).

## Development

```bash
npm install
gi test    # or: npm test (node --test --test-timeout=60000)
gi ci      # format, lint, tests on Node 24 and 22, Docker build, store validator
```

The tests run against the SDK's fake Gladys and a simulated Gira server on
127.0.0.1 (HTTPS with a self-signed certificate), never the network. See
`CLAUDE.md` for the architecture and the rules, `TODO.md` for the decisions
and what comes next.

## License

Apache-2.0 (`LICENSE`). Written from the official documentation "Gira IoT
REST API v2"; see `THIRD_PARTY_NOTICES.md`.
