# Gira X1 / HomeServer

This integration connects your Gira X1, HomeServer or FacilityServer to Gladys
through the **Gira IoT REST API v2** of the server, on your local network.
Unofficial, not affiliated with Gira (Gira Giersiepen GmbH & Co. KG).

**Never tested with a real device yet**: the integration was written from the
official documentation "Gira IoT REST API v2" (Gira, July 2020) and tested
against a simulated server. Your feedback is welcome.

## Servers

The documentation of Gira lists the **Gira X1** (firmware 2.4 or later) and the
**Gira HomeServer / FacilityServer** (firmware 4.10 or later). The **Gira One**
server is not in that documentation: it works if it answers the same API
(`GDS-REST-API`, version 2), which "Test the connection" checks.

## What you get

The functions of your project (as set up in the Gira Project Assistant, GPA)
are offered in the **Discovery** tab:

- **Switched lights**: on/off;
- **Dimmers**, **coloured lights** and **tunable white lights**: on/off and
  brightness (the colour and the colour temperature are not driven yet);
- **Shutters and blinds**: open, close, stop, and the position when the
  function has one (the slats are not driven yet).

The **scenes** of the server run from the scenes of Gladys, with the scene
action **Run a Gira scene** (see below).

Not offered: heating and cooling, sauna, audio, cameras, links, status values,
value transmitters, and the "Trigger" and "Press and hold" functions (they may
drive a door opener).

The device ids are the ids (UID) the server gives each function
(`function:<uid>`): they do not change with a firmware update, and the
documentation of Gira says a UID is never given again soon to something else.
A function deleted and created again in the GPA is a new device.

## Configuration

1. In the GPA, create a **user** for Gladys on the server (a dedicated one is
   best).
2. In Gladys, type the **IP address** of the server, the **user name** and the
   **password**, and **save**. Names in `.local` do not resolve in the
   container.
3. Click **Trust the certificate**: the fingerprint of the certificate of the
   server is shown, nothing else is sent. To check it, open
   `https://<address of the server>/` in a browser of your network and compare
   the SHA-256 fingerprint in the details of the certificate. Click again
   within 2 minutes to trust it: it is trusted from then on (trust on first
   use), and a different one later stops everything.
4. Click **Test the connection**: it checks the API, the user and reads the
   project.
5. Add the devices you want from the **Discovery** tab.

The password is kept by Gladys in its database, never shown again, sent only
to the server at the address typed, and only on a connection whose
certificate is the trusted one. It registers the client
`io.github.lm1lc3n7.gladys-gira` with the server (`POST /clients`), which
gives a token; the token stays in memory only (the server gives the same one
again at the next start of the container). A user name or password refused
by the server is never tried again by itself: the integration waits for new
ones or for a successful "Test the connection" (only a 6-bit mark of the
refused ones is kept in `/data`, never enough to tell them).

### Certificate of the server

The server has a certificate no browser trusts (Gira says so in its
documentation). Instead, the integration trusts one certificate: confirmed by
your two clicks on **Trust the certificate**, or typed in the **Certificate
fingerprint** field. Without it, nothing is sent at all. If another
certificate shows up (server replaced, certificate renewed, or another device
at this address), nothing is sent, not even a stop nor the password, and the
status shows the fingerprint seen. To trust it: click **Trust the
certificate** twice, or type this fingerprint in the configuration.

## What always leaves, what is off by default

**Off by default**: Gladys only reads. Three options open the rest:

- **Allow switching on and dimming**: switch a light on, set a brightness;
- **Allow opening covers**: open a cover, or move it to a position (any
  position but fully closed may open it); extend an awning; close a garage
  door or a gate (see below);
- **Allow Gira scenes**: a scene of the server may switch on anything and
  open covers or doors.

The option is read again right before sending: turned off while a command
waits, the command is refused.

**Always leave**, whatever the options: turning off a light (a brightness of
0 is a turning off), stopping a cover, closing a shutter (a position of 0 is
a close). No option, no 429 pause, no project being read again, no read or
command in flight holds them back. They cancel the commands of the same
target still waiting, and the older protective command of the same target:
a newer one always wins, and when the older one is already written, the
newer one leaves once the server answered it.

Beware: the "Switch" functions (switched lights) may also feed a socket or a
pump: a "turn everything off" of Gladys or of a voice assistant turns them
off too. List them in **Functions not offered** if they must never be
touched.

### Awnings, garage doors and gates

The API of Gira has one kind of function for every cover: it cannot tell a
shutter from an awning or a gate. Tell it in the configuration, with the ids
of the functions (`GIRA_FUNCTION` in the Discovery):

- **Awnings (reversed direction)**: "close" retracts the awning (up, never
  held back: what you want before a storm), "open" extends it (needs the
  opening option); the position is the extension; a stop is a step up (in). Without this, "close"
  (down, in KNX) **extends** an awning, for instance in a "strong wind, close
  every cover" scene.
- **Garage doors and gates**: closing needs the opening option too (someone
  may stand under them). A stop is a step, which moves a gate at rest: when
  the function has a "Movement" data point, it is read first and the stop
  leaves only if the gate is not shown at rest (not read: in doubt, the stop
  leaves); without "Movement", stopping a gate needs the opening option too.
- **Functions not offered**: never offered nor commanded, not even a stop
  (a door opener, a pump...); a stop kept before the function was listed is
  dropped.

### When a stop does not leave

A stop does not leave only in these cases:

- user name or password missing or invalid, or refused by the server;
- no trusted certificate, or certificate changed;
- server unreachable, locked (423, while a project is loaded), asking to
  slow down (429), or the route refused (403; or 401 again after the one new
  registration that a refused token triggers at once);
- before the configuration is first read from Gladys (container start): it
  is refused, nothing sent (the address is not known yet);
- the function is in **Functions not offered**.

What happens then depends on the stop:

- **Stopping a cover** ("Step-Up-Down") is never sent again once something
  reached the server: on a cover at rest, each one is a short step (down,
  up for an awning). When nothing reached the server (refused, too slow,
  locked), it is tried again about every second: for up to 10 seconds when
  the function has "Movement", read before each new try (0: already stopped,
  given up; 1: sent), otherwise for up to about 3 seconds. Then it is given
  up. The answer says what happened: done, "Stop not sent yet... tried again
  for up to N s, then given up", or "Stop not sent... click again". Sent
  without an answer of the server, it is never sent again ("Sent, without
  answer"). A stop waiting for a free connection waits 3 seconds at most.
- **Closing a cover** ("Up-Down") is tried again while nothing reached the
  server (or the server refused it unexecuted: 423, 429, 401/403), at most
  **20 seconds** after your click, every 5 seconds; on a cover with a
  position, only after a read of it, once per read: closed or closing, it is
  done; read more open than when you clicked twice in a row, it was opened by
  hand meanwhile and the close is dropped. Taken by the server, or sent
  without an answer, it is done and never sent again (nor after a restart).
- **Turning off a light** ("OnOff" 0) is kept while nothing reached the
  server, also in `/data` with the date of your click, and sent again every
  5 seconds, at most **10 minutes** after your click (a restart of the
  container sends it first; older, it is dropped). Taken by the server, it is
  read back at once, after 2 and 5 seconds (never during a 429 pause); a read
  started in the **10 seconds** after the answer that shows it not applied
  sends it again (4 sends at most). After these 10 seconds, it is dropped
  ("taken, not confirmed"): a light switched on by hand afterwards is never
  switched off again. A switch-off that reached the server is never replayed
  after a restart. When OnOff cannot be read on the function, it is done once
  the server took it.

A newer command of the same target, taken by the server, replaces a kept
stop. After a restart of the container, the first stop registers the client
again before it leaves (its own registration, never waiting for one of the
reads). A stop on a data point the server no longer knows (404) is dropped.
At most 8 protective requests are open at once (the others wait their turn).

KNX conventions used: "Up-Down" 0 is up and 1 is down; a stop is
"Step-Up-Down" 1, which stops a moving cover; the position of the server is
in percent closed (an awning: percent extended), shown in Gladys in percent
open (an awning: extended).

## Scenes

1. Allow the scenes (option **Allow Gira scenes**).
2. Click **List the scenes**: it shows the scene functions of the project
   with their id, like `a0f1: Evening`.
3. In a scene of Gladys, add the action **Run a Gira scene** with this id and
   the **scene number** (0 to 64), sent as is to the "Execute" data point of a
   scene set (or "Scene" of a scene extension), as set in the GPA.

A scene is refused when the option is off, when the id is not a scene
function of the project, when the project is being read again, and for the
same reasons as any other command (server not connected, 429 pause...). Any stop
that arrives while a scene waits cancels it.

## What a refused command says

A command (other than a stop) leaves within 3.5 seconds or not at all:
"nothing sent" says it never left. "Refused by the server" gives its reason;
"locked" says a project is being loaded; "Not allowed for this user (403)"
that the user lacks this right in the GPA. "Sent, without confirmation" says it
left with no answer; "not applied yet" that a read back does not show it yet.
In these last two cases, the device is read again after 5 and 20 seconds and
its badge says so meanwhile. Opening a cover ("Up-Down") cannot be read back
(write only): it is done once the server took it, and the position is read
again after 5 and 20 seconds.

## Reads

The server cannot reach the container of the integration, so its callbacks
are not used: the integration reads at the chosen **interval** (60 s by
default, 30 s at least). Each read asks the id of the project (`uiconfig/uid`)
and, when it changed (GPA download, change in the Gira app), the whole
project again; no command but the stops leaves until it is read. Then the
values of each device created in Gladys, one request at a time (150 per read
at most, in turn beyond). A function whose values are refused (401, 403) is
read again later (twice the interval, doubling up to 1 hour), without
stopping the others.

Never faster: neither the Scan button (which publishes the Discovery again
without reading), nor "Test the connection" (which then says when it can test
again), nor a restart of the container reads before the interval after the
last read; another address, user or password saved reads at once. While the user is
refused, "Test the connection" tries at once, once per 10 seconds. During a
pause asked by the server (429), neither the Test button nor the reads send a
request, the confirmation reads of the stops neither; only the stops leave.

A project of more than 500 functions: only the first 500 are offered, and
the status says so.

## Known limits

- Colour, colour temperature and slats are not driven yet.
- No live updates: the changes made elsewhere are seen at the next read.
- The scene numbers are sent as typed: check them against your GPA.

## Troubleshooting

- **"The certificate of the server changed"**: see above.
- **"The Gira server refused the user name or the password"**: check the user
  in the GPA, save the right password or click "Test the connection".
- **"The server is locked"**: a project is being loaded from the GPA; it comes
  back by itself.
- **"/data is unreadable"**: it is read again every 10 seconds (one read at a
  time); meanwhile the integration learns and keeps nothing (certificate,
  stops), and starts again with what `/data` holds once it is read. Typing the
  fingerprint of the certificate in the configuration lets it work meanwhile.
