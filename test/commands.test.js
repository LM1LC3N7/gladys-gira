// -----------------------------------------------------------------------------
// Commands and stops against the simulated Gira server. Writes are off by
// default; stops (turn off, cover stop and close) are never held back; a
// switch-off is kept until a read started after the server's answer shows it
// applied.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, TOKEN, fakeGira } from './helpers/fakeGira.js';
import { pause, setup, waitFor, within } from './helpers/setup.js';

const ackError = (ack) => ack.error ?? '';
const ALL = { allow_control: true, allow_open: true, allow_scenes: true };

/** Fires a command and moves the virtual clock until its ack (stops wait up to 3.5 s). */
async function fireUntil(s, fid, key, value) {
  const ack = s.fire(fid, key, value);
  let done = false;
  ack.finally(() => (done = true)).catch(() => {});
  for (let i = 0; i < 40 && !done; i += 1) {
    await s.advance(100);
    await pause(5);
  }
  return ack;
}

test('writes are off by default: on, brightness, open, position and scenes refused, nothing sent', async (t) => {
  const s = await setup(t);
  const before = s.gw.requests.length;
  for (const [fid, key, value, text] of [
    ['a030', 'on', 1, /Switching on and dimming are not allowed/],
    ['a029', 'brightness', 50, /Switching on and dimming are not allowed/],
    ['a040', 'state', 1, /Opening covers is not allowed/],
    ['a040', 'position', 40, /Opening covers is not allowed/],
  ]) {
    const ack = await s.fire(fid, key, value);
    assert.equal(ack.success, false, `${fid}:${key}`);
    assert.match(ackError(ack), text);
  }
  const scene = await s.fireScene({ function: 'a060', scene: 3 });
  assert.equal(scene.success, false);
  assert.match(ackError(scene), /Gira scenes are not allowed/);
  await pause(30);
  assert.equal(s.gw.requests.length, before, 'nothing sent');
  // The protective ones leave anyway.
  s.gw.values.a031 = '1';
  s.gw.values.a02a = '1';
  for (const [fid, key, value] of [
    ['a030', 'on', 0],
    ['a029', 'brightness', 0],
    ['a040', 'state', 0],
    ['a040', 'state', -1],
    ['a050', 'state', -1],
    ['a040', 'position', 0],
  ]) {
    const ack = await s.fire(fid, key, value);
    assert.equal(ack.success, true, `${fid}:${key}=${value}: ${ackError(ack)}`);
  }
  assert.equal(s.gw.values.a031, '0');
  assert.equal(s.gw.values.a02a, '0', 'brightness 0 is the switch-off');
  assert.deepEqual(
    s.gw.puts('a041').map((r) => r.json),
    [{ value: 1 }],
    'stop: Step-Up-Down 1',
  );
  assert.deepEqual(
    s.gw.puts('a042').map((r) => r.json),
    [{ value: 1 }, { value: 1 }],
    'close: Up-Down 1',
  );
  assert.deepEqual(
    s.gw.puts('a052').map((r) => r.json),
    [{ value: 1 }],
  );
  assert.equal(s.gw.puts('a044').length, 0, 'position 0 is a close on Up-Down');
});

test('allowed: on, brightness, open, position, scene; confirmed by a read', async (t) => {
  const s = await setup(t, { config: ALL });
  await s.fire('a030', 'on', 0);
  let ack = await s.fire('a030', 'on', 1);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.values.a031, '1');
  ack = await s.fire('a029', 'brightness', 70);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.puts('a02b').at(-1).json, { value: 70 });
  ack = await s.fire('a040', 'state', 1);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.puts('a042').at(-1).json, { value: 0 }, 'open: Up-Down 0');
  ack = await s.fire('a040', 'position', 40);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.puts('a044').at(-1).json, { value: 60 }, 'percent closed');
  ack = await s.fireScene({ function: 'a060', scene: 3 });
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.puts('a061').at(-1).json, { value: 3 });
  for (const fields of [
    { function: 'a060', scene: 65 },
    { function: 'a060', scene: 2.5 },
    { function: 'a029', scene: 1 },
    { function: '../x', scene: 1 },
  ]) {
    ack = await s.fireScene(fields);
    assert.equal(ack.success, false, JSON.stringify(fields));
  }
  ack = await s.fire('a029', 'brightness', 101);
  assert.match(ackError(ack), /out of bounds/);
  ack = await s.fire('a029', 'on', 'true');
  assert.match(ackError(ack), /out of bounds/);
});

test('a stop is never held back: 429 pause, stale project, stalled read, full slots, frozen /data', async (t) => {
  const s = await setup(t);
  s.app.pauseEnd = s.clock.monotonic() + 3600_000;
  s.app.stale = true;
  s.store.hang = true;
  s.gw.latency = (r) => (r.method === 'GET' && r.path.startsWith('/values/') ? 3000 : 0);
  s.app.slotsUsed = 99;
  s.app.reading = true;
  s.gw.values.a031 = '1';
  s.gw.values.a02a = '1';
  const t0 = performance.now();
  const acks = await Promise.all([
    s.fire('a030', 'on', 0),
    s.fire('a029', 'on', 0),
    s.fire('a040', 'state', -1),
  ]);
  assert.ok(performance.now() - t0 < 1500, 'never waited for the read, the slots nor /data');
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.values.a031, '0');
  assert.equal(s.gw.values.a02a, '0');
  assert.equal(s.gw.values.a044, '100');
  // A non-protective command is refused at once in the same state.
  s.app.config = { ...s.app.config, allowControl: true };
  const on = await s.fire('a030', 'on', 1);
  assert.equal(on.success, false);
});

test('a stop after a restart, before any read and without a token: registers, then leaves', async (t) => {
  const s = await setup(t);
  s.app.stop();
  s.app.token = '';
  s.app.tokenFor = '';
  s.app.inventory = undefined;
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  assert.equal(s.app.model.writers.size, 0, 'no function known');
  s.gw.values.a031 = '1';
  const before = s.gw.requests.length;
  let ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  const after = s.gw.requests.slice(before);
  assert.equal(after[0].path, '/clients');
  assert.equal(after[1].method, 'PUT');
  assert.equal(s.gw.values.a031, '0');
  ack = await s.fire('a040', 'state', 0);
  assert.equal(ack.success, true, ackError(ack));
  ack = await s.fire('a040', 'position', 0);
  assert.equal(ack.success, true, ackError(ack));
  s.app.config = { ...s.app.config, allowControl: true, allowOpen: true };
  for (const [fid, key, value] of [
    ['a030', 'on', 1],
    ['a040', 'state', 1],
    ['a029', 'brightness', 30],
  ]) {
    ack = await s.fire(fid, key, value);
    assert.equal(ack.success, false, `${fid}:${key}: not a stop, refused until read`);
  }
  assert.equal(s.gw.count('GET /uiconfig/uid') > 0, true);
});

test('a stop pressed while the password is refused: kept, nothing sent, leaves first with new ones', async (t) => {
  const s = await setup(t);
  s.gw.password = 'new-one';
  s.gw.token = 'Aa9TNYIsYLJLsrw68Z3goYdQf6uiO4jF';
  await s.cycle();
  await waitFor(() => s.app.blocked, 'refused');
  s.gw.values.a031 = '1';
  const before = s.gw.requests.length;
  const ack = await fireUntil(s, 'a030', 'on', 0);
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /user name or password refused/);
  await s.advance(20_000);
  await pause(50);
  assert.equal(s.gw.requests.length, before, 'nothing tried while refused');
  assert.equal(s.store.data.guards.length, 1, 'kept in /data');
  s.gw.latency = (r) => (r.path === '/uiconfig/uid' ? 300 : 0);
  await within(s.fake.configUpdated({ ...s.raw, password: 'new-one' }), 'config');
  await waitFor(async () => {
    await s.advance(100);
    return s.gw.values.a031 === '0';
  }, 'the stop sent with the new password');
  const after = s.gw.requests.slice(before);
  assert.equal(after[0].path, '/clients');
  const firstPut = after.findIndex((r) => r.method === 'PUT');
  const firstGet = after.findIndex((r) => r.method === 'GET');
  assert.ok(firstPut >= 0 && (firstGet < 0 || firstPut < firstGet), 'the stop before any read');
});

test('a switch-off that never reached the server: kept, sent every 5 s, lands when the server is back', async (t) => {
  const s = await setup(t);
  const port = s.gw.port;
  await s.gw.close();
  const ack = await fireUntil(s, 'a030', 'on', 0);
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /kept/i);
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  const guard = [...s.app.guards.values()][0];
  assert.equal(guard.sends, 0, 'nothing reached the server: not counted');
  assert.equal(s.store.data.guards.length, 1, 'kept in /data, dated');
  assert.ok(Number.isFinite(s.store.data.guards[0].at));
  await s.app.showStatus();
  assert.match(s.message(), /Stops kept: Flur/);
  const back = await fakeGira({ port });
  t.after(() => back.close());
  back.values.a031 = '1';
  await waitFor(async () => {
    await s.advance(500);
    return back.values.a031 === '0';
  }, 'the stop landed');
  await waitFor(async () => {
    await s.advance(100);
    return s.app.guards.size === 0;
  }, 'applied, dropped');
  assert.equal(s.store.data.guards.length, 0);
});

test('a switch-off never sent is given up 10 min after the click', async (t) => {
  const s = await setup(t);
  await s.gw.close();
  await fireUntil(s, 'a030', 'on', 0);
  for (let i = 0; i < 125; i += 1) {
    await s.advance(5000);
    await pause(2);
  }
  assert.equal(s.app.guards.size, 0);
  assert.equal(s.store.data.guards.length, 0);
});

test('a switch-off sent without answer: "without confirmation", read back, never replayed blindly', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  s.gw.drop = (r) => r.method === 'PUT';
  const ack = await fireUntil(s, 'a030', 'on', 0);
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /without answer/);
  assert.equal(s.gw.puts('a031').length, 1, 'no quick retry once it reached the server');
  assert.equal((s.store.data.guards ?? []).length, 0, 'never kept in /data once sent');
});

test('a switch-off read back not applied in its 10 s: sent again, 4 sends at most, then given up', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  s.gw.applySets = false;
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, 'taken by the server');
  for (let i = 0; i < 40; i += 1) {
    await s.advance(500);
    await pause(10);
  }
  assert.equal(s.gw.puts('a031').length, 4, 'never more than 4 sends');
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  assert.equal(s.app.guards.size, 0, 'given up after its window');
  assert.equal(s.gw.puts('a031').length, 4);
});

test('a switch-off applied, the light switched on by hand after its window: never switched off again', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  let fail = true;
  s.gw.replyFor = (r) =>
    fail && r.method === 'GET' && r.path === '/values/a030' ? { status: 503, body: {} } : undefined;
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true);
  s.gw.values.a031 = '1';
  for (let i = 0; i < 3; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  fail = false;
  await s.cycle();
  await s.advance(10_000);
  await pause(30);
  assert.equal(s.gw.values.a031, '1');
  assert.equal(s.gw.puts('a031').length, 1);
});

test('a read showing a switch-off not applied after its 10 s window never sends it again', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  s.gw.applySets = false;
  let fail = true;
  s.gw.replyFor = (r) =>
    fail && r.method === 'GET' && r.path === '/values/a030' ? { status: 503, body: {} } : undefined;
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true);
  // The 5 s timer would drop it at the end of the window: held, to see what a read does then.
  s.app.timers.clearTimeout(s.app.guardTimer);
  s.app.guardTimer = 'held';
  await s.advance(11_000);
  await pause(20);
  assert.equal(s.app.guards.size, 1, 'not yet dropped by the timer');
  fail = false;
  s.app.lastReadMono = -Infinity;
  s.app.scheduleRead(s.app.generation, 0);
  await waitFor(async () => {
    await s.advance(0);
    return s.gw.count('GET /values/a030') > 0 && !s.app.reading;
  }, 'a read after the window');
  await pause(30);
  assert.equal(s.gw.puts('a031').length, 1, 'out of the window: never sent again');
});

test('a kept switch-off: no read during a 429 pause', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  s.gw.applySets = false;
  s.app.pause({ kind: 'rate', retryAfter: 600_000 });
  const gets = s.gw.count(/^GET /);
  await s.fire('a030', 'on', 0);
  for (let i = 0; i < 6; i += 1) {
    await s.advance(2000);
    await pause(10);
  }
  assert.equal(s.gw.count(/^GET /), gets, 'no read during the pause');
});

test('locked (423) on a stop: not counted, sent again at the stop pace', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  let locked = true;
  s.gw.replyFor = (r) =>
    locked && r.method === 'PUT'
      ? { status: 423, body: { error: { code: 'locked', message: 'locked' } } }
      : undefined;
  const ack = await fireUntil(s, 'a030', 'on', 0);
  assert.equal(ack.success, false);
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  assert.ok(s.gw.puts('a031').length >= 5);
  assert.equal([...s.app.guards.values()][0].answered, 0);
  locked = false;
  await waitFor(async () => {
    await s.advance(500);
    return s.gw.values.a031 === '0';
  }, 'landed');
});

test('restart: a kept switch-off leaves first, before any read; a cover close is never replayed', async (t) => {
  const s = await setup(t, { connect: false });
  const address = s.gw.address;
  s.store.data = {
    pins: { [address]: s.gw.fingerprint },
    lastReadAt: Date.UTC(2026, 0, 1),
    guards: [
      { address, fid: 'a030', dpid: 'a031', key: 'OnOff', value: 0, at: Date.UTC(2026, 0, 1) },
      { address, fid: 'a040', dpid: 'a042', key: 'Up-Down', value: 1, at: Date.UTC(2026, 0, 1) },
    ],
  };
  s.gw.values.a031 = '1';
  await within(s.gladys.connect(), 'connect');
  await waitFor(() => s.gw.values.a031 === '0', 'the kept stop sent at start');
  assert.deepEqual(
    s.gw.requests.slice(0, 2).map((r) => `${r.method} ${r.path}`),
    ['POST /clients', 'PUT /values/a031'],
  );
  assert.equal(s.gw.count('GET /uiconfig/uid'), 0, 'no read yet (the interval after the last one)');
  assert.equal(s.gw.puts('a042').length, 0, 'a cover close is never replayed');
  await s.advance(59_000);
  await pause(50);
  assert.equal(s.gw.count('GET /uiconfig/uid'), 0);
  await s.advance(2000);
  await waitFor(() => s.gw.count('GET /uiconfig/uid') === 1, 'the first read');
});

test('nothing sent before a stop leaves after it: a queued command is cancelled by the stop', async (t) => {
  const s = await setup(t, { config: ALL });
  s.gw.latency = (r) => (r.method === 'PUT' && r.json?.value === 80 ? 800 : 0);
  const slow = s.fire('a040', 'position', 20); // 80 % closed, slow
  await waitFor(() => s.gw.puts('a044').length === 1, 'the slow one left');
  const queued = s.fire('a040', 'position', 60); // waits behind it
  await pause(20);
  const stop = await s.fire('a040', 'state', 0);
  assert.equal(stop.success, true, ackError(stop));
  const [, b] = await Promise.all([slow, queued]);
  assert.equal(b.success, false);
  assert.match(ackError(b), /stop/i);
  assert.equal(s.gw.puts('a044').length, 1, 'the queued one never left');
  assert.equal(s.gw.puts('a041').length, 1);
  await pause(50);
  assert.equal(s.app.guards.size, 0, 'a cover move is done once taken');
  assert.equal((s.store.data.guards ?? []).length, 0, 'never kept in /data');
});

test('a read started before a command never applies to it afterwards', async (t) => {
  const s = await setup(t, { config: ALL });
  s.gw.values.a031 = '0';
  // The next read of the light answers late with what the server had when asked ("0").
  let stale;
  let asked = false;
  s.gw.latency = (r) => {
    if (r.method !== 'GET' || r.path !== '/values/a030' || stale) return 0;
    stale = r;
    return 700;
  };
  s.gw.replyFor = (r) => {
    if (r !== stale) return undefined;
    asked = true;
    return { status: 200, body: { values: [{ uid: 'a031', value: '0' }] } };
  };
  await s.advance(60_000);
  await waitFor(() => stale !== undefined, 'the read in flight');
  const ack = await s.fire('a030', 'on', 1);
  assert.equal(ack.success, true, ackError(ack));
  await s.flush();
  assert.equal(s.lastState('a030', 'on'), 1);
  await waitFor(async () => {
    await s.advance(0);
    return asked && !s.app.reading;
  }, 'the old read done');
  await s.flush();
  assert.equal(s.lastState('a030', 'on'), 1, 'the older read did not put 0 back');
});

test('options re-read right before the first byte', async (t) => {
  const s = await setup(t, { config: ALL });
  s.gw.latency = (r) => (r.method === 'PUT' && r.path === '/values/a031' ? 600 : 0);
  const first = s.fire('a030', 'on', 1);
  await waitFor(() => s.gw.puts('a031').length === 1, 'the first left');
  const second = s.fire('a030', 'on', 1);
  await pause(20);
  s.app.config = { ...s.app.config, allowControl: false };
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.success, true, ackError(a));
  assert.match(ackError(b), /not allowed/);
  assert.equal(s.gw.puts('a031').length, 1);
});

test('a Gladys scene on 5 slow targets sets them all; a target in 5xx does not stop the others', async (t) => {
  const s = await setup(t, { config: ALL });
  for (const n of [2, 3, 4, 5]) {
    s.gw.config.functions.push({
      uid: `b${n}00`,
      functionType: 'de.gira.schema.functions.Switch',
      channelType: 'de.gira.schema.channels.Switch',
      displayName: `Licht ${n}`,
      dataPoints: [{ uid: `b${n}01`, name: 'OnOff', canRead: true, canWrite: true }],
    });
    s.gw.values[`b${n}01`] = '0';
  }
  s.gw.config.uid = 'a037';
  await s.cycle();
  await waitFor(() => s.app.inventory.functions.has('b500'), 'the new lights read');
  await s.createAll();
  const ids = ['a030', 'b200', 'b300', 'b400', 'b500'];
  s.gw.latency = (r) => (r.method === 'PUT' ? 500 + 80 * ids.length : 0);
  let acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 1)));
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 0)));
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.values.b501, '0');
  s.gw.replyFor = (r) =>
    r.path === '/values/b301' && r.method === 'PUT' ? { status: 503, body: {} } : undefined;
  acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 1)));
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, false, true, true],
  );
  assert.match(ackError(acks[2]), /without confirmation/);
});

test('outcomes: refused with the reason, locked, forbidden, not sent, sent without confirmation, too late', async (t) => {
  const s = await setup(t, { config: ALL });
  s.gw.replyFor = (r) =>
    r.method === 'PUT'
      ? { status: 422, body: { error: { code: 'unprocessable', message: 'Value out of range' } } }
      : undefined;
  let ack = await s.fire('a029', 'brightness', 50);
  assert.match(ackError(ack), /Refused by the server: Value out of range/);
  s.gw.replyFor = (r) =>
    r.method === 'PUT' ? { status: 423, body: { error: { code: 'locked' } } } : undefined;
  ack = await s.fire('a029', 'brightness', 50);
  assert.match(ackError(ack), /locked/);
  s.gw.replyFor = (r) => (r.method === 'PUT' ? { status: 403, body: {} } : undefined);
  ack = await s.fire('a029', 'brightness', 50);
  assert.match(ackError(ack), /Not allowed for this user/);
  assert.equal(s.app.blocked, false);
  s.gw.replyFor = () => undefined;
  s.gw.silent = (r) => r.method === 'PUT';
  ack = await s.fire('a029', 'brightness', 60);
  assert.match(ackError(ack), /without confirmation/);
  s.gw.silent = () => false;
  s.gw.latency = (r) => (r.method === 'PUT' ? 700 : 0);
  const slow = s.fire('a029', 'brightness', 70);
  await waitFor(() => s.gw.puts('a02b').length === 5, 'the slow one left');
  const late = s.fire('a029', 'brightness', 80);
  await pause(20);
  await s.advance(4000);
  ack = await late;
  assert.match(ackError(ack), /in time/);
  await slow;
  assert.equal(s.gw.puts('a02b').length, 5);
  s.gw.latency = () => 0;
  await s.gw.close();
  ack = await s.fire('a029', 'brightness', 90);
  assert.match(ackError(ack), /Nothing sent/);
});

test('a value read back equal to the one before is "not applied yet", never a success', async (t) => {
  const s = await setup(t, { config: ALL });
  s.gw.applySets = false;
  const ack = await s.fire('a029', 'brightness', 80);
  assert.match(ackError(ack), /not applied yet/);
  await s.app.publishAllTransports();
  assert.ok(
    s.fake.transports.some((b) => b.degraded),
    'the badge says it',
  );
});

test('a function that changed kind on the server: only a stop leaves', async (t) => {
  const s = await setup(t, { config: ALL });
  const created = s.fake.devices.find((d) => d.external_id.endsWith(':a030'));
  const changed = {
    ...created,
    params: created.params.map((p) =>
      p.name === 'GIRA_CHANNEL' ? { ...p, value: 'de.gira.schema.channels.Other' } : p,
    ),
  };
  const ack = await within(
    s.fake.setValue(changed, { external_id: `${created.external_id}:on` }, 1),
    'ack',
  );
  assert.match(ackError(ack), /changed on the server/);
  const off = await within(
    s.fake.setValue(changed, { external_id: `${created.external_id}:on` }, 0),
    'ack',
  );
  assert.equal(off.success, true, ackError(off));
});

test('the password and the token are never in a log, a status, /data nor an ack', async (t) => {
  const s = await setup(t, { config: ALL });
  await s.fire('a030', 'on', 0);
  await s.fire('a030', 'on', 1);
  s.gw.replyFor = (r) =>
    r.method === 'PUT'
      ? { status: 400, body: { error: { code: 'x', message: `bad ${TOKEN} ${PASSWORD}` } } }
      : undefined;
  await s.fire('a029', 'brightness', 30);
  s.gw.password = 'other';
  s.gw.token = 'Bb9TNYIsYLJLsrw68Z3goYdQf6uiO4jG';
  await s.cycle();
  await waitFor(() => s.app.blocked, 'refused');
  const everything = JSON.stringify([
    s.logs,
    s.fake.connectionStatuses,
    s.store.data,
    s.fake.requests,
    s.fake.acks ?? null,
  ]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(PASSWORD));
});
