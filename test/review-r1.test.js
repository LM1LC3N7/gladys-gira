// -----------------------------------------------------------------------------
// The points of review r1: order of the protective commands of one target,
// a stop never repeated, kept guards bounded in time, the token gone on a
// stop, /data slow at start, awnings, gates and excluded functions, the lot
// of protective connections, and one test per guard the mutants found bare.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedRequest } from '../src/gira.js';
import { certs } from './kit/certs.mjs';
import { fakeGira } from './helpers/fakeGira.js';
import { feature, pause, setup, waitFor, within } from './helpers/setup.js';

const ackError = (ack) => ack.error ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A request whose connection is slow (before the TLS check) when `slow(options)` says so. */
const slowRequest = (slow) => async (options) => {
  const ms = slow(options);
  if (ms) await sleep(ms);
  return pinnedRequest(options);
};

/** Fires and moves the virtual clock until the ack. */
async function fireUntil(s, fid, key, value) {
  const ack = s.fire(fid, key, value);
  let done = false;
  ack.finally(() => (done = true)).catch(() => {});
  for (let i = 0; i < 60 && !done; i += 1) {
    await s.advance(100);
    await pause(5);
  }
  return ack;
}

const puts = (s) =>
  s.gw.requests.filter((r) => r.method === 'PUT').map((r) => `${r.path.slice(8)}=${r.json?.value}`);

// --- B1 -------------------------------------------------------------------------

test('B1: close then stop on a slow connection: the stop is the last thing the cover gets', async (t) => {
  let first = true;
  const request = slowRequest((o) => {
    if (o.method === 'PUT' && first) {
      first = false;
      return 400;
    }
    return 0;
  });
  const s = await setup(t, { request });
  const close = s.fire('a040', 'state', -1);
  await pause(30);
  const stop = await s.fire('a040', 'state', 0);
  assert.equal(stop.success, true, ackError(stop));
  const c = await close;
  assert.match(ackError(c), /Replaced by a newer stop/);
  await pause(500);
  assert.deepEqual(puts(s), ['a041=1'], 'the close never left after the stop');
});

test('B1: stop then close on a slow connection: the close is the last thing the cover gets', async (t) => {
  let first = true;
  const request = slowRequest((o) => {
    if (o.method === 'PUT' && first) {
      first = false;
      return 400;
    }
    return 0;
  });
  const s = await setup(t, { request });
  const stop = s.fire('a040', 'state', 0);
  await pause(30);
  const close = await s.fire('a040', 'state', -1);
  assert.equal(close.success, true, ackError(close));
  await stop;
  await pause(500);
  assert.deepEqual(puts(s), ['a042=1']);
});

test('B1: a protective request waits for the one of the same target already written', async (t) => {
  const s = await setup(t);
  s.gw.latency = (r) => (r.method === 'PUT' && r.path === '/values/a042' ? 400 : 0);
  const close = s.fire('a040', 'state', -1);
  await waitFor(() => s.gw.puts('a042').length === 1, 'the close written');
  const stop = await s.fire('a040', 'state', 0);
  assert.equal(stop.success, true, ackError(stop));
  await close;
  const [c] = s.gw.puts('a042');
  const [st] = s.gw.puts('a041');
  assert.ok(st.at - c.at >= 350, `the stop left ${Math.round(st.at - c.at)} ms after the close`);
});

// --- B2, I1 ----------------------------------------------------------------------

test('B2: a stop answered too late is sent once, never again', async (t) => {
  const s = await setup(t);
  s.gw.latency = (r) => (r.method === 'PUT' && r.path === '/values/a041' ? 3300 : 0);
  const ack = s.fire('a040', 'state', 0);
  await waitFor(() => s.gw.puts('a041').length === 1, 'written', 6000);
  await sleep(3300);
  for (let i = 0; i < 10; i += 1) {
    await s.advance(2000);
    await pause(5);
  }
  assert.match(ackError(await ack), /without answer/);
  assert.equal(s.gw.puts('a041').length, 1);
});

test('B2: a stop dropped after the request, or refused locked, never sent after its budget', async (t) => {
  const s = await setup(t);
  s.gw.drop = (r) => r.method === 'PUT' && r.path === '/values/a041';
  let ack = await fireUntil(s, 'a040', 'state', 0);
  assert.match(ackError(ack), /without answer/);
  assert.equal(s.gw.puts('a041').length, 1, 'reached the server: never again');
  s.gw.drop = () => false;
  s.gw.replyFor = (r) =>
    r.method === 'PUT' ? { status: 423, body: { error: { code: 'locked' } } } : undefined;
  ack = await fireUntil(s, 'a040', 'state', 0);
  assert.match(ackError(ack), /Stop not sent/);
  const n = s.gw.puts('a041').length;
  assert.ok(n <= 4, `${n}: the first and two quick retries`);
  s.gw.replyFor = () => undefined;
  for (let i = 0; i < 10; i += 1) {
    await s.advance(5000);
    await pause(5);
  }
  assert.equal(s.gw.puts('a041').length, n, 'never sent later');
  assert.equal(s.app.guards.size, 0);
});

test('I1: a close never sent is given up 20 s after the click; one taken without answer is never repeated', async (t) => {
  const s = await setup(t);
  const port = s.gw.port;
  await s.gw.close();
  await fireUntil(s, 'a050', 'state', -1);
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(5);
  }
  assert.equal(s.app.guards.size, 0, 'given up');
  const back = await fakeGira({ port });
  t.after(() => back.close());
  for (let i = 0; i < 4; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  assert.equal(back.puts('a052').length, 0, 'not replayed without a click');
  back.drop = (r) => r.method === 'PUT';
  const ack = await fireUntil(s, 'a050', 'state', -1);
  assert.match(ackError(ack), /without answer/);
  for (let i = 0; i < 4; i += 1) {
    await s.advance(5000);
    await pause(5);
  }
  assert.equal(back.puts('a052').length, 1);
});

test('I1: checkClose: closed ends it; closer is taken; more open twice in a row drops it', async (t) => {
  for (const [label, readings, expectState] of [
    ['closed', ['100'], 'applied'],
    ['closer', ['50'], 'done'],
    ['opened once', ['10', '30'], 'sent'],
    ['opened twice', ['10', '10'], 'changedElsewhere'],
  ]) {
    const s = await setup(t);
    s.gw.values.a044 = '30';
    await s.cycle();
    let locked = true;
    s.gw.replyFor = (r) =>
      locked && r.method === 'PUT'
        ? { status: 423, body: { error: { code: 'locked' } } }
        : undefined;
    await fireUntil(s, 'a040', 'state', -1);
    const guard = s.app.guardOf('a040');
    assert.equal(guard?.needRead, true, label);
    const states = [];
    const drop = s.app.dropGuard.bind(s.app);
    s.app.dropGuard = (g) => {
      states.push(g.state);
      drop(g);
    };
    if (expectState === 'sent') locked = false;
    for (const value of readings) {
      s.gw.values.a044 = value;
      if (expectState === 'sent' && value === '30') locked = false;
      await s.advance(5000);
      await waitFor(() => !guard.reading && !guard.inFlight, 'the read');
      await pause(20);
    }
    if (expectState === 'sent') {
      assert.ok(s.gw.puts('a042').length >= 4, `${label}: sent again after the read`);
    } else {
      assert.equal(states.at(-1), expectState, label);
    }
  }
});

// --- I2 (switch-offs: the other tests are in commands.test.js) ------------------

test('I2: an answered switch-off of a light whose OnOff cannot be read: done, never read nor kept', async (t) => {
  const s = await setup(t);
  s.gw.config.functions.find((f) => f.uid === 'a030').dataPoints[0].canRead = false;
  s.gw.config.uid = 'a037';
  await s.cycle();
  const reads = s.gw.count('GET /values/a030');
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.app.guards.size, 0);
  for (let i = 0; i < 4; i += 1) {
    await s.advance(5000);
    await pause(5);
  }
  assert.equal(s.gw.count('GET /values/a030'), reads);
});

// --- I3, I5 ------------------------------------------------------------------------

test('I3: a token gone on a stop: one registration right away, then the stop; never a loop', async (t) => {
  const s = await setup(t, { config: { poll_interval: 3600 } });
  s.gw.token = 'Cc9TNYIsYLJLsrw68Z3goYdQf6uiO4jH';
  s.gw.values.a031 = '1';
  const before = s.gw.count('POST /clients');
  const ack = await fireUntil(s, 'a030', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.values.a031, '0');
  assert.equal(s.gw.count('POST /clients'), before + 1);
  // A server refusing every token on the writes: one registration per send, no storm.
  s.gw.replyFor = (r) =>
    r.method === 'PUT'
      ? { status: 422, body: { error: { code: 'invalidToken', message: 'x' } } }
      : undefined;
  const regs = s.gw.count('POST /clients');
  await fireUntil(s, 'a040', 'state', 0);
  assert.ok(s.gw.count('POST /clients') - regs <= 3, 'bounded by the sends of the budget');
  assert.equal(s.app.blocked, false);
});

test('I5: a stop never waits for a registration of the reads that hangs', async (t) => {
  const s = await setup(t);
  s.app.token = '';
  s.app.tokenFor = '';
  let silent = true;
  s.gw.silent = (r) => {
    if (r.path === '/clients' && silent) {
      silent = false;
      return true;
    }
    return false;
  };
  s.app.ensureToken().catch(() => {});
  await waitFor(() => s.gw.count('POST /clients') >= 1, 'the hung registration');
  s.gw.values.a031 = '1';
  const t0 = performance.now();
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.ok(performance.now() - t0 < 1500, 'did not wait for it');
  assert.equal(s.gw.values.a031, '0');
});

// --- I4 ------------------------------------------------------------------------------

test('I4: /data slow at start: read again every 10 s; its pin and switch-off taken then', async (t) => {
  let release;
  let calls = 0;
  const kept = {};
  const store = {
    data: null,
    saves: 0,
    load() {
      calls += 1;
      if (calls === 1) return new Promise((r) => (release = () => r(null)));
      return Promise.resolve(JSON.parse(JSON.stringify(kept.data)));
    },
    async save(d) {
      this.data = JSON.parse(JSON.stringify(d));
      this.saves += 1;
    },
  };
  const s = await setup(t, { connect: false, store });
  kept.data = {
    pins: { [s.gw.address]: s.gw.fingerprint },
    guards: [
      {
        address: s.gw.address,
        fid: 'a030',
        dpid: 'a031',
        key: 'OnOff',
        value: 0,
        at: Date.UTC(2026, 0, 1),
      },
    ],
  };
  s.gw.values.a031 = '1';
  const connecting = s.gladys.connect();
  await pause(30);
  await s.advance(2000);
  await within(connecting, 'connect');
  await waitFor(() => /unreadable/.test(s.message()), 'said');
  assert.equal(s.gw.requests.length, 0, 'no pin known yet: nothing sent');
  release();
  await pause(20);
  await s.advance(10_000);
  await waitFor(async () => {
    await s.advance(100);
    return s.gw.values.a031 === '0';
  }, 'the kept switch-off sent');
  assert.equal(s.app.memoryState, 'loaded');
  await waitFor(async () => {
    await s.advance(1000);
    return s.app.online;
  }, 'online');
});

// --- I6 ------------------------------------------------------------------------------

test('I6: awnings reversed, gates closing only with the option, excluded functions untouched', async (t) => {
  const s = await setup(t, {
    config: { awning_functions: 'a040', gate_functions: 'a050', excluded_functions: 'a030, Bad!' },
  });
  const ids = s.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(!ids.some((id) => id.endsWith(':a030')), 'excluded: not offered');
  assert.match(s.message(), /1 entry\(ies\) of the function lists/);
  assert.equal(s.lastState('a040', 'position'), 30, 'an awning: the position is the extension');
  let ack = await s.fire('a040', 'state', -1);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(
    s.gw.puts('a042').at(-1).json,
    { value: 0 },
    'closing an awning retracts it (up)',
  );
  ack = await s.fire('a040', 'state', 1);
  assert.match(ackError(ack), /Opening covers is not allowed/);
  ack = await s.fire('a050', 'state', -1);
  assert.match(
    ackError(ack),
    /Opening covers is not allowed/,
    'a gate closes only with the option',
  );
  ack = await s.fire('a050', 'state', 0);
  assert.equal(ack.success, true, 'a gate stops always');
  const off = await within(
    s.fake.setValue(
      {
        external_id: 'ext:test-integration:function:a030',
        params: [
          { name: 'GIRA_FUNCTION', value: 'a030' },
          { name: 'GIRA_ONOFF', value: 'a031' },
        ],
      },
      { external_id: feature('a030', 'on') },
      0,
    ),
    'ack',
  );
  assert.match(ackError(off), /Functions not offered/);
  assert.equal(s.gw.puts('a031').length, 0);
  s.app.config = { ...s.app.config, allowOpen: true };
  ack = await s.fire('a040', 'state', 1);
  assert.equal(ack.success, true);
  assert.deepEqual(s.gw.puts('a042').at(-1).json, { value: 1 }, 'opening an awning extends it');
  ack = await s.fire('a040', 'position', 70);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.puts('a044').at(-1).json, { value: 70 });
});

// --- m1 ------------------------------------------------------------------------------

test('m1: many stops at once use a bounded lot of connections; all land', async (t) => {
  let open = 0;
  let peak = 0;
  const request = async (o) => {
    const counted = o.method === 'PUT';
    if (counted) peak = Math.max(peak, (open += 1));
    try {
      return await pinnedRequest(o);
    } finally {
      if (counted) open -= 1;
    }
  };
  const s = await setup(t, { request });
  for (let n = 10; n < 30; n += 1) {
    s.gw.config.functions.push({
      uid: `c${n}0`,
      channelType: 'de.gira.schema.channels.Switch',
      displayName: `L${n}`,
      dataPoints: [{ uid: `c${n}1`, name: 'OnOff', canRead: true, canWrite: true }],
    });
    s.gw.values[`c${n}1`] = '1';
  }
  s.gw.config.uid = 'a038';
  await s.cycle();
  await s.createAll();
  s.gw.latency = (r) => (r.method === 'PUT' ? 150 : 0);
  const acks = await Promise.all(
    Array.from({ length: 20 }, (_, i) => s.fire(`c${i + 10}0`, 'on', 0)),
  );
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  assert.ok(peak <= 8, `peak ${peak}`);
});

// --- I8: guards the mutants found bare ---------------------------------------------

test('I8: a command is refused during a 429 pause alone', async (t) => {
  const s = await setup(t, { config: { allow_control: true } });
  s.app.pauseEnd = s.clock.monotonic() + 600_000;
  const ack = await s.fire('a030', 'on', 1);
  assert.match(ackError(ack), /Paused after a 429/);
});

test('I8: the option is checked again right before the first byte (slow connection)', async (t) => {
  let s;
  const request = slowRequest((o) => {
    if (o.method === 'PUT') {
      s.app.config = { ...s.app.config, allowControl: false };
      return 300;
    }
    return 0;
  });
  s = await setup(t, { config: { allow_control: true }, request });
  const ack = await s.fire('a030', 'on', 1);
  assert.match(ackError(ack), /not allowed/);
  assert.equal(s.gw.puts('a031').length, 0);
});

test('I8: a command is refused while a stop of the device is being sent', async (t) => {
  const request = slowRequest((o) => (o.method === 'PUT' && o.json?.value === 0 ? 400 : 0));
  const s = await setup(t, { config: { allow_control: true }, request });
  const off = s.fire('a030', 'on', 0);
  await waitFor(() => Boolean(s.app.guardOf('a030')?.inFlight), 'in flight');
  const on = await s.fire('a030', 'on', 1);
  assert.match(ackError(on), /stop of this device is being sent/);
  await off;
});

test('I8: a command answered while a stop is connecting never lifts it', async (t) => {
  const request = slowRequest((o) => (o.method === 'PUT' && o.json?.value === 0 ? 500 : 0));
  const s = await setup(t, { config: { allow_control: true }, request });
  s.gw.latency = (r) => (r.method === 'PUT' && r.json?.value === 1 ? 250 : 0);
  const on = s.fire('a030', 'on', 1);
  await waitFor(() => s.gw.puts('a031').length === 1, 'the on written');
  const off = await s.fire('a030', 'on', 0);
  await on;
  assert.equal(off.success, true, ackError(off));
  assert.equal(s.gw.values.a031, '0', 'the stop left');
});

test('I8: trust: the same fingerprint at both clicks, within 2 minutes', async (t) => {
  const s = await setup(t, { pinned: false, connect: false });
  await within(s.gladys.connect(), 'connect');
  await within(s.app.trustCertificate(), 'click 1');
  await s.advance(121_000);
  const late = await within(s.app.trustCertificate(), 'click 2 too late');
  assert.match(late.en, /Click again/);
  assert.equal(s.store.data, null);
  // Another certificate between the clicks: asked again, never pinned.
  const port = s.gw.port;
  await s.gw.close();
  const other = await fakeGira({ port, cert: certs.impostor });
  t.after(() => other.close());
  const changed = await within(s.app.trustCertificate(), 'click 2, other cert');
  assert.match(changed.en, /Click again/);
  assert.match(changed.en, new RegExp(certs.impostor.fingerprint256));
  assert.equal(s.store.data, null);
});

test('I8: Test twice within 10 s: the second gives the first result, no request', async (t) => {
  const s = await setup(t);
  await s.advance(60_000);
  s.app.lastReadMono = -Infinity;
  await within(s.app.testConnection(), 'test 1');
  const n = s.gw.requests.length;
  s.app.lastReadMono = -Infinity;
  await within(s.app.testConnection(), 'test 2');
  assert.equal(s.gw.requests.length, n);
});

test('I8: a device created again long after its last read gets no stale value', async (t) => {
  const s = await setup(t);
  const d = s.fake.devices.find((x) => x.external_id.endsWith(':a030'));
  await within(s.fake.deviceDeleted?.(d) ?? s.app.deviceDeleted(d), 'delete');
  s.app.createdIds.delete(d.external_id);
  for (const f of d.features) s.app.created.delete(f.external_id);
  await s.advance(10 * 60_000);
  await pause(20);
  const before = s.fake.states.length;
  await within(s.app.deviceCreated(d), 'create');
  await s.flush();
  assert.equal(s.fake.states.length, before);
});

test('I8: a failed read is never tried again sooner than the interval', async (t) => {
  const s = await setup(t, { config: { poll_interval: 3600 } });
  s.gw.replyFor = () => ({ status: 500, body: {} });
  await s.advance(3600_000);
  await waitFor(async () => {
    await s.advance(0);
    return !s.app.online;
  }, 'failed');
  const n = s.gw.requests.length;
  await s.advance(1800_000);
  await pause(30);
  assert.equal(s.gw.requests.length, n);
});

test('I8: Test checks the API envelope (GDS-REST-API)', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) => (r.path === '/' ? { status: 200, body: { info: 'other' } } : undefined);
  s.app.lastReadMono = -Infinity;
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /not understood/);
});

test('I8: an unreadable /data is never written over (typed pin, pause)', async (t) => {
  const s = await setup(t, {
    connect: false,
    pinned: false,
    config: { certificate_fingerprint: certs.device.fingerprint256 },
  });
  s.store.failLoad = true;
  await within(s.gladys.connect(), 'connect');
  await s.online();
  s.app.pause({ kind: 'rate', retryAfter: 60_000 });
  await pause(20);
  assert.equal(s.store.saves, 0);
});

test('I8: a switch-off kept for another address is neither sent nor lost', async (t) => {
  const s = await setup(t, { connect: false });
  s.store.data = {
    pins: { [s.gw.address]: s.gw.fingerprint },
    guards: [
      {
        address: '10.9.9.9:443',
        fid: 'a030',
        dpid: 'a031',
        key: 'OnOff',
        value: 0,
        at: Date.UTC(2026, 0, 1),
      },
    ],
  };
  s.gw.values.a031 = '1';
  await within(s.gladys.connect(), 'connect');
  await s.online();
  await s.advance(5000);
  await pause(30);
  assert.equal(s.gw.puts('a031').length, 0);
  await s.app.shutdown();
  assert.equal(s.store.data.guards.length, 1);
});
