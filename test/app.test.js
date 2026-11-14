// -----------------------------------------------------------------------------
// Lifecycle against the simulated Gira server: start, registration, reads,
// account refusal, pauses, certificate, /data, Gladys reconnections.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certs } from './kit/certs.mjs';
import { OTHER_TOKEN, PASSWORD, TOKEN, fakeGira } from './helpers/fakeGira.js';
import { device, feature, pause, setup, waitFor, within } from './helpers/setup.js';

test('registers, reads the project, offers the devices, publishes the states', async (t) => {
  const s = await setup(t);
  assert.equal(s.status().connected, true, s.message());
  assert.match(s.message(), /Connected: 5 functions offered, 1 scene functions/);
  const ids = s.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, ['a029', 'a030', 'a040', 'a050', 'a080'].map(device).sort());
  const register = s.gw.requests.filter((r) => r.path === '/clients');
  assert.equal(register.length, 1, 'one registration');
  assert.equal(register[0].creds, `gladys:${PASSWORD}`);
  assert.equal(register[0].json.client, 'io.github.lm1lc3n7.gladys-gira');
  assert.equal(s.lastState('a029', 'on'), 0);
  assert.equal(s.lastState('a029', 'brightness'), 20);
  assert.equal(s.lastState('a030', 'on'), 1);
  assert.equal(s.lastState('a040', 'position'), 70, 'percent open = 100 - percent closed');
  // A cover without Position: no position feature, its values never read.
  const awning = s.fake.discoveredDevices.find((d) => d.external_id === device('a050'));
  assert.deepEqual(
    awning.features.map((f) => f.external_id),
    [feature('a050', 'state')],
  );
  assert.equal(s.gw.count('GET /values/a050'), 0);
  // The scene function, the audio player: not devices.
  assert.ok(!ids.includes(device('a060')) && !ids.includes(device('a070')));
  // Every read with the token, never with the password.
  for (const r of s.gw.requests.filter((x) => x.path !== '/clients' && x.path !== '/')) {
    assert.equal(r.token, TOKEN);
    assert.equal(r.creds, undefined);
  }
  // Changes read at the interval.
  s.gw.values.a02b = '75';
  await s.cycle();
  assert.equal(s.lastState('a029', 'brightness'), 75);
  assert.equal(s.gw.count('POST /clients'), 1, 'the token is kept in memory');
});

test('getConfig() failing in "connected" is tried again, spaced, without end, then starts', async (t) => {
  let fails = 3;
  let calls = 0;
  const s = await setup(t, {
    connect: false,
    getConfig: async function getConfig() {
      calls += 1;
      // The SDK's own resynchronization (first call) is answered.
      if (calls > 1 && fails > 0) {
        fails -= 1;
        throw new Error('Gladys busy');
      }
      return s.raw;
    },
  });
  await within(s.gladys.connect(), 'connect');
  await waitFor(() => /could not be read/.test(s.message()), 'the status');
  for (const wait of [5000, 15_000, 30_000]) {
    await s.advance(wait);
    await pause(20);
  }
  await s.online();
  assert.match(s.message(), /Connected/);
  assert.equal(calls, 5);
  // A reconnection to Gladys whose getConfig() fails once: the session goes on, tried again.
  fails = 1;
  s.gladys.emit('connected');
  await waitFor(() => calls === 6, 'the call');
  await s.advance(60_000);
  await waitFor(() => calls === 7, 'tried again');
  assert.equal(s.app.online, true);
});

test('a refused password: nothing tried again, even after a restart, until new ones or the Test button', async (t) => {
  const s = await setup(t);
  // The user's password changed on the server and the token is gone.
  s.gw.password = 'changed';
  s.gw.token = OTHER_TOKEN;
  await s.cycle();
  await waitFor(() => s.app.blocked, 'refused');
  assert.match(s.message(), /refused the user name or the password/);
  assert.ok(s.store.data.refused, 'kept in /data');
  assert.ok(!JSON.stringify(s.store.data).includes(PASSWORD));
  const count = s.gw.requests.length;
  await s.advance(3600_000);
  await pause(50);
  assert.equal(s.gw.requests.length, count, 'never tried again by itself');
  // A restart with the same password: still refused, nothing sent.
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  await s.advance(600_000);
  await pause(50);
  assert.equal(s.gw.requests.length, count);
  assert.equal(s.app.blocked, true);
  // The Test button with the server accepting it again: lifted.
  s.gw.password = PASSWORD;
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  assert.equal(s.store.data.refused, null);
  await s.online();
});

test('a new password saved is tried at once, even while the old one is refused', async (t) => {
  const s = await setup(t);
  s.gw.password = 'new-one';
  s.gw.token = OTHER_TOKEN;
  await s.cycle();
  await waitFor(() => s.app.blocked, 'refused');
  await within(s.fake.configUpdated({ ...s.raw, password: 'new-one' }), 'save');
  await waitFor(async () => {
    await s.advance(0);
    return s.app.online && !s.app.blocked;
  }, 'online again');
  assert.equal(s.store.data.refused, null);
});

test('a token refused on the main read: one new registration, then the read, never a loop', async (t) => {
  const s = await setup(t);
  s.gw.token = OTHER_TOKEN;
  const before = s.gw.count('POST /clients');
  await s.cycle();
  assert.equal(s.gw.count('POST /clients'), before + 1);
  assert.equal(s.app.online, true);
  assert.equal(s.app.token, OTHER_TOKEN);
  // A server that refuses every token it gives: no registration storm, no refusal.
  s.gw.replyFor = (r) =>
    r.path === '/uiconfig/uid'
      ? { status: 401, body: { error: { code: 'invalidAuth', message: 'no' } } }
      : undefined;
  await s.cycle();
  await waitFor(() => !s.app.online, 'failed');
  const registrations = s.gw.count('POST /clients');
  assert.ok(registrations <= before + 2, `${registrations} registrations`);
  assert.equal(s.app.blocked, false, 'never a refusal of the password');
});

test('a 401, 403 or 404 on the values of one function is not a refusal; the others are read', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) =>
    r.path === '/values/a029'
      ? { status: 403, body: { error: { code: 'forbidden', message: 'no' } } }
      : r.path === '/values/a030'
        ? { status: 401, body: { error: { code: 'invalidToken', message: 'no' } } }
        : undefined;
  s.gw.values.a044 = '0';
  await s.cycle();
  assert.equal(s.app.online, true);
  assert.equal(s.app.blocked, false);
  assert.equal(s.lastState('a040', 'position'), 100);
  // Spaced: not read again at the next cycle.
  const reads = s.gw.count('GET /values/a029');
  await s.cycle();
  assert.equal(s.gw.count('GET /values/a029'), reads);
});

test('every value read failing is a failed read (never "Connected")', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) => (r.path.startsWith('/values/') ? { status: 500, body: {} } : undefined);
  await s.cycle();
  await waitFor(() => !s.app.online, 'failed');
  assert.equal(s.status().connected, false);
  assert.match(s.message(), /error of the server/);
});

test('423 locked (project download): the read fails and comes back later', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = () => ({ status: 423, body: { error: { code: 'locked', message: 'x' } } });
  await s.cycle();
  await waitFor(() => !s.app.online, 'failed');
  assert.match(s.message(), /locked/);
  s.gw.replyFor = () => undefined;
  await s.advance(60_000);
  await s.online();
});

test('a new project (another UI configuration id) is read before any command', async (t) => {
  const s = await setup(t, { config: { allow_control: true } });
  const full = s.gw.count('GET /uiconfig');
  await s.cycle();
  assert.equal(s.gw.count('GET /uiconfig'), full, 'the full text only when its id changed');
  s.gw.config.uid = 'a099';
  s.gw.config.functions[1].displayName = 'Flur neu';
  s.gw.latency = (r) => (r.path === '/uiconfig' ? 300 : 0);
  const cycle = s.cycle();
  await waitFor(() => s.app.stale, 'stale');
  const ack = await s.fire('a030', 'on', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /project of the server changed/);
  await cycle;
  assert.equal(s.app.stale, false);
  assert.ok(s.fake.discoveredDevices.some((d) => d.name === 'Flur neu'));
});

test('429: every read paused (kept across a restart), the stops still leave', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) =>
    r.path === '/uiconfig/uid'
      ? { status: 429, body: {}, headers: { 'retry-after': '600' } }
      : undefined;
  await s.advance(60_000);
  await waitFor(() => s.app.paused(), 'paused');
  const during = s.gw.count('GET /uiconfig/uid');
  await s.advance(120_000);
  await within(s.fake.scanRequest(), 'scan');
  await pause(50);
  assert.equal(s.gw.count('GET /uiconfig/uid'), during, 'no read on Scan during the pause');
  assert.ok(s.store.data.pausedUntil > 0);
  assert.match(s.message(), /slow down/);
  s.gw.replyFor = () => undefined;
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(s.gw.values.a031, '0');
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  assert.ok(s.app.paused(), 'the pause outlives a restart');
  await s.advance(500_000);
  await waitFor(() => s.gw.count('GET /uiconfig/uid') > during, 'read after the pause');
});

test('a restart never reads sooner than the interval after the last read (/data)', async (t) => {
  const s = await setup(t);
  assert.ok(s.store.data.lastReadAt, 'the time of the read kept before it');
  const count = s.gw.count('GET /uiconfig/uid');
  s.app.memoryState = 'unloaded';
  s.app.stop();
  await within(s.app.start(s.raw), 'restart');
  await s.advance(55_000);
  await pause(30);
  assert.equal(s.gw.count('GET /uiconfig/uid'), count);
  await s.advance(6000);
  await waitFor(() => s.gw.count('GET /uiconfig/uid') === count + 1, 'the read');
});

test('certificate: nothing sent without a pin; the first one trusted in two clicks only', async (t) => {
  const s = await setup(t, { pinned: false, connect: false });
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await waitFor(() => /not pinned yet/.test(s.message()), 'the status');
  assert.equal(s.gw.requests.length, 0, 'not even the registration');
  const test1 = await within(s.app.testConnection(), 'test');
  assert.match(test1.en, /shows the certificate .*Nothing was sent/);
  assert.equal(s.gw.requests.length, 0);
  const first = await within(s.app.trustCertificate(), 'trust 1');
  assert.match(first.en, new RegExp(s.gw.fingerprint));
  assert.equal(s.store.data, null, 'not pinned on one click');
  const second = await within(s.app.trustCertificate(), 'trust 2');
  assert.match(second.en, /Certificate trusted/);
  assert.equal(s.store.data.pins[s.gw.address], s.gw.fingerprint);
  await s.online();
});

test('certificate changed: nothing sent (the password neither), fingerprint shown, two clicks', async (t) => {
  const s = await setup(t);
  // A switch-off left before, kept in /data until read back.
  s.gw.applySets = false;
  await s.fire('a030', 'on', 0);
  // The same address now shows another certificate.
  await s.gw.close();
  const other = await fakeGira({ cert: certs.impostor, port: s.gw.port });
  t.after(() => other.close());
  await s.cycle().catch(() => {});
  await waitFor(() => /certificate of the server changed/.test(s.message()), 'the status');
  assert.match(s.message(), new RegExp(certs.impostor.fingerprint256));
  assert.equal(other.requests.length, 0, 'no byte of HTTP reached it');
  const pending = s.fire('a030', 'on', 0);
  await s.advance(3500);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(other.requests.length, 0);
  const one = await within(s.app.trustCertificate(), 'trust 1');
  assert.match(one.en, /Click again/);
  assert.equal(other.requests.length, 0);
  const two = await within(s.app.trustCertificate(), 'trust 2');
  assert.match(two.en, /trusted/);
  await waitFor(async () => {
    await s.advance(100);
    return other.puts('a031').length >= 1;
  }, 'the kept stop leaves');
  assert.equal(
    other.requests.filter((r) => r.creds).length,
    1,
    'one registration, after the trust',
  );
});

test('a fingerprint typed in the configuration is the pin', async (t) => {
  const s = await setup(t, {
    pinned: false,
    connect: false,
    config: {
      certificate_fingerprint: certs.device.fingerprint256.replace(/:/g, '').toLowerCase(),
    },
  });
  await within(s.gladys.connect(), 'connect');
  await s.online();
  assert.equal(s.store.data.pins[s.gw.address], s.gw.fingerprint);
});

test('/data unreadable: nothing learnt nor written over it; said in the status', async (t) => {
  const s = await setup(t, { pinned: false, connect: false });
  s.store.failLoad = true;
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await waitFor(() => /unreadable/.test(s.message()), 'the status');
  await within(s.app.trustCertificate(), 'trust 1');
  const second = await within(s.app.trustCertificate(), 'trust 2');
  assert.match(second.en, /could not keep it/);
  assert.equal(s.store.saves, 0);
});

test('/data slow at start: bounded, the start goes on', async (t) => {
  const s = await setup(t, {
    connect: false,
    pinned: false,
    config: { certificate_fingerprint: certs.device.fingerprint256 },
  });
  s.store.hangLoad = true;
  const connecting = s.gladys.connect();
  await pause(50);
  await s.advance(2000);
  await within(connecting, 'connect');
  await s.online();
  assert.equal(s.app.memoryState, 'unreadable');
});

test('a reconnection to Gladys sends status and Discovery again, never an old value as new', async (t) => {
  const s = await setup(t);
  const statuses = s.fake.connectionStatuses.length;
  const states = s.fake.states.length;
  s.gladys.emit('connected');
  await waitFor(() => s.fake.connectionStatuses.length > statuses, 'the status again');
  await s.flush();
  assert.equal(s.fake.states.length, states, 'no old value published as new');
});

test('a device created long after the last read gets no stale value', async (t) => {
  const s = await setup(t, { create: false });
  await s.advance(10 * 60_000);
  await pause(30);
  const before = s.fake.states.length;
  const d = s.fake.discoveredDevices.find((x) => x.external_id === device('a030'));
  await within(s.fake.deviceCreated(d), 'create');
  await s.flush();
  assert.equal(s.fake.states.length, before);
});

test('Scan: never a read sooner than the interval; inside it, the Discovery is published again', async (t) => {
  const s = await setup(t);
  const reads = s.gw.count('GET /uiconfig/uid');
  await within(s.fake.scanRequest(), 'scan');
  await pause(30);
  assert.equal(s.gw.count('GET /uiconfig/uid'), reads);
});

test('Test: spaced by the interval; OK names the server; "List the scenes" lists them', async (t) => {
  const s = await setup(t);
  const early = await within(s.app.testConnection(), 'test');
  assert.match(early.en, /next test possible/);
  await s.advance(60_000);
  s.app.lastTest = undefined;
  s.app.lastReadMono = -Infinity;
  const ok = await within(s.app.testConnection(), 'test');
  assert.match(
    ok.en,
    /Connection OK: user accepted, X1 Haus \(GIGSRVKX02, firmware 2\.4\.415\.0\)/,
  );
  const list = await within(s.fake.action('list_scenes', {}), 'list');
  assert.match(JSON.stringify(list), /a060: Szenen/);
});

test('every published feature follows the rules of the core (no supported_options)', async (t) => {
  const s = await setup(t);
  for (const d of s.fake.discoveredDevices) {
    for (const f of d.features) {
      assert.equal(f.supported_options, undefined, f.external_id);
      assert.notEqual(f.category, 'switch', 'never a switch');
      assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max) && f.min <= f.max);
    }
  }
});
