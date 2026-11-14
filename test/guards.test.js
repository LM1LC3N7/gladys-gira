// -----------------------------------------------------------------------------
// The finer guards of the stops and commands: what a read may tell a kept
// stop, refusals of a stop, a scene cancelled by a stop, the registration
// that is never repeated in a loop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pause, setup, waitFor, within } from './helpers/setup.js';

const ackError = (ack) => ack.error ?? '';

test('a read started before a stop never counts as its read back', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '0';
  // A read of the light leaves, slow, and answers what it saw then ("0").
  let stale;
  let held = false;
  s.gw.latency = (r) => {
    if (r.method !== 'GET' || r.path !== '/values/a030' || stale) return 0;
    stale = r;
    return 700;
  };
  s.gw.replyFor = (r) => {
    if (r !== stale) return undefined;
    held = true;
    return { status: 200, body: { values: [{ uid: 'a031', value: '0' }] } };
  };
  await s.advance(60_000);
  await waitFor(() => stale !== undefined, 'the read in flight');
  // Meanwhile the light is switched on at the wall; the stop is taken, never applied.
  s.gw.values.a031 = '1';
  s.gw.applySets = false;
  const ack = await s.fire('a030', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  // Real time only: the confirmation reads (virtual timers) wait for the old read.
  await waitFor(() => held && !s.app.reading, 'the old read done');
  // The old read said "0": it never ends the guard; the reads after the answer say "1".
  for (let i = 0; i < 8; i += 1) {
    await s.advance(500);
    await pause(20);
  }
  assert.ok(s.gw.puts('a031').length >= 2, 'sent again after a read showing it not applied');
});

test('a stop refused by the server 4 times stays kept, without new sends', async (t) => {
  const s = await setup(t);
  s.gw.values.a031 = '1';
  s.gw.replyFor = (r) =>
    r.method === 'PUT'
      ? { status: 422, body: { error: { code: 'unprocessable', message: 'Wind alarm' } } }
      : undefined;
  const pending = s.fire('a030', 'on', 0);
  await waitFor(() => s.app.guardOf('a030')?.state === 'refused', 'the refusal');
  await s.advance(3500);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /Wind alarm/);
  for (let i = 0; i < 10; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  assert.equal(s.gw.puts('a031').length, 4);
  assert.equal([...s.app.guards.values()][0].stuck, true);
});

test('a command sent before a stop and answered after it never lifts it', async (t) => {
  const s = await setup(t, { config: { allow_control: true } });
  s.gw.latency = (r) => (r.method === 'PUT' && r.json?.value === 1 ? 600 : 0);
  s.gw.applySets = false;
  const on = s.fire('a030', 'on', 1);
  await waitFor(() => s.gw.puts('a031').length === 1, 'the on left');
  const off = await s.fire('a030', 'on', 0);
  assert.equal(off.success, true, ackError(off));
  await on;
  assert.equal(s.app.guards.size, 1, 'the stop is still kept');
});

test('a scene waiting for a slot is cancelled by any stop that arrives meanwhile', async (t) => {
  const s = await setup(t, { config: { allow_scenes: true } });
  s.app.slotsUsed = 99;
  const scene = s.fireScene({ function: 'a060', scene: 2 });
  await pause(30);
  const stop = await s.fire('a040', 'state', 0);
  assert.equal(stop.success, true, ackError(stop));
  s.app.slotsUsed = 0;
  s.app.release();
  const ack = await scene;
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /Cancelled by a stop/);
  assert.equal(s.gw.puts('a061').length, 0);
});

test('a fresh token refused on the main read: no second registration in the same read', async (t) => {
  const s = await setup(t);
  s.app.stop();
  s.app.token = '';
  s.app.tokenFor = '';
  s.gw.replyFor = (r) =>
    r.path === '/uiconfig/uid'
      ? { status: 401, body: { error: { code: 'invalidAuth', message: 'no' } } }
      : undefined;
  const before = s.gw.count('POST /clients');
  s.app.lastReadMono = -Infinity;
  await within(s.app.start(s.raw), 'restart');
  await waitFor(async () => {
    await s.advance(0);
    return s.app.lastError !== undefined;
  }, 'the failed read');
  assert.equal(s.gw.count('POST /clients'), before + 1);
  assert.equal(s.app.blocked, false);
});
