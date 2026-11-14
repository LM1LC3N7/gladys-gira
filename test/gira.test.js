// -----------------------------------------------------------------------------
// The client of the Gira IoT REST API: pinned TLS (nothing written to another
// certificate), Basic authorization on the registration only, the token as a
// query parameter, bounded answers, the error object of the PDF.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import {
  GiraError,
  cleanReason,
  createGira,
  parseAnswer,
  readFingerprint,
  register,
  retryAfterOf,
} from '../src/gira.js';
import { certs } from './kit/certs.mjs';
import { PASSWORD, TOKEN, USER, fakeGira } from './helpers/fakeGira.js';

const client = (gw, pin = gw.fingerprint) =>
  createGira({ host: '127.0.0.1', port: gw.port, pin, token: () => TOKEN });

test('an impostor certificate gets no byte: neither the password nor the token', async (t) => {
  const gw = await fakeGira({ cert: certs.impostor });
  t.after(() => gw.close());
  await assert.rejects(
    register({
      host: '127.0.0.1',
      port: gw.port,
      pin: certs.device.fingerprint256,
      username: USER,
      password: PASSWORD,
    }),
    (err) => err.kind === 'pin' && err.fingerprint === certs.impostor.fingerprint256 && !err.sent,
  );
  await assert.rejects(
    client(gw, certs.device.fingerprint256).values('a029'),
    (e) => e.kind === 'pin',
  );
  assert.equal(gw.requests.length, 0);
  await assert.rejects(client(gw, null).values('a029'), (e) => e.kind === 'nopin');
  assert.equal(
    await readFingerprint({ host: '127.0.0.1', port: gw.port }),
    certs.impostor.fingerprint256,
  );
});

test('registration: Basic authorization, the client id, the token; 401 is "auth", the password never in the error', async (t) => {
  const gw = await fakeGira();
  t.after(() => gw.close());
  const args = {
    host: '127.0.0.1',
    port: gw.port,
    pin: gw.fingerprint,
    username: USER,
    password: PASSWORD,
  };
  assert.equal(await register(args), TOKEN);
  assert.equal(gw.requests[0].creds, `${USER}:${PASSWORD}`);
  assert.equal(gw.requests[0].url, '/api/v2/clients');
  assert.equal(gw.requests[0].token, null, 'no token on the registration');
  await assert.rejects(register({ ...args, password: 'wrong' }), (err) => {
    assert.equal(err.kind, 'auth');
    assert.ok(!err.message.includes('wrong'));
    return true;
  });
  gw.replyFor = () => ({ status: 201, body: { token: 'short' } });
  await assert.rejects(register(args), (e) => e.kind === 'format');
});

test('requests: the token in the query only, values parsed, PUT with an empty 200', async (t) => {
  const gw = await fakeGira();
  t.after(() => gw.close());
  const c = client(gw);
  assert.deepEqual(await c.uiconfigUid(), { uid: 'a036' });
  assert.equal(gw.requests[0].url, `/api/v2/uiconfig/uid?token=${TOKEN}`);
  assert.equal(gw.requests[0].creds, undefined);
  await c.uiconfig();
  assert.equal(gw.requests[1].url, `/api/v2/uiconfig?expand=dataPointFlags&token=${TOKEN}`);
  assert.deepEqual(await c.setValue('a02b', 70), {});
  assert.deepEqual(gw.requests[2].json, { value: 70 });
  const info = await c.info();
  assert.equal(info.info, 'GDS-REST-API');
  assert.equal(gw.requests[3].token, null, 'no token on the availability check');
});

test('errors: the PDF codes mapped; Retry-After; nothing secret in a reason', () => {
  const answer = (status, body, headers = {}) => ({ status, headers, body: JSON.stringify(body) });
  const kind = (a) => {
    try {
      parseAnswer(a);
    } catch (err) {
      return err.kind;
    }
    return 'ok';
  };
  const e = (code) => ({ error: { code, message: 'm' } });
  assert.equal(kind(answer(401, e('invalidAuth'))), 'auth');
  assert.equal(kind(answer(422, e('invalidToken'))), 'auth');
  assert.equal(kind(answer(422, e('unprocessable'))), 'refused');
  assert.equal(kind(answer(403, e('x'))), 'forbidden');
  assert.equal(kind(answer(423, e('locked'))), 'locked');
  assert.equal(kind(answer(429, {})), 'rate');
  assert.equal(kind(answer(404, e('uidNotFound'))), 'notfound');
  assert.equal(kind(answer(500, e('generic'))), 'server');
  assert.equal(kind(answer(302, {})), 'redirect');
  assert.equal(kind({ status: 200, body: 'not json' }), 'format');
  assert.equal(kind({ status: 200, body: '' }), 'format');
  assert.deepEqual(parseAnswer({ status: 200, body: '' }, { empty: true }), {});
  assert.throws(
    () =>
      parseAnswer(answer(400, { error: { code: 'x', message: `bad ${TOKEN} secret-pass\r\n` } }), {
        secrets: ['secret-pass'],
      }),
    (err) => err.message === 'bad *** ***',
  );
  assert.equal(cleanReason(`a ${'Q'.repeat(25)} b`), 'a *** b');
  assert.doesNotMatch(cleanReason('bad url /api/v2/values/a031?token=abc&x=1'), /token=/);
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(
    retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT', 'Wed, 21 Oct 2026 07:27:00 GMT'),
    60_000,
  );
  assert.equal(retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT'), undefined, 'never the local clock');
  assert.ok(new GiraError('auth', 'x', { status: 401 }).answered);
});

test('answers bounded: a body too large is cut before it is read whole; a silence ends', async (t) => {
  const gw = await fakeGira();
  t.after(() => gw.close());
  gw.replyFor = (r) =>
    r.path === '/values/a029'
      ? { status: 200, body: { values: [], pad: 'x'.repeat(400_000) } }
      : undefined;
  await assert.rejects(client(gw).values('a029'), (e) => e.kind === 'size');
  // Chunked, without a length: cut while reading.
  const server = createServer({ key: certs.device.key, cert: certs.device.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = 'x'.repeat(64 * 1024);
    let n = 0;
    const timer = setInterval(() => {
      if (res.destroyed || n++ > 100) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(chunk);
    }, 1);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const big = createGira({
    host: '127.0.0.1',
    port: server.address().port,
    pin: certs.device.fingerprint256,
  });
  await assert.rejects(big.values('a029'), (e) => e.kind === 'size');
  gw.replyFor = () => undefined;
  gw.silent = () => true;
  await assert.rejects(
    client(gw).values('a029', { timeout: 400 }),
    (e) => e.kind === 'timeout' && e.sent,
  );
});
