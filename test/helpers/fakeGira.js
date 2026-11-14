// -----------------------------------------------------------------------------
// A simulated Gira X1 on 127.0.0.1, built from the official PDF "Gira IoT REST
// API v2" only: HTTPS with a self-signed certificate (the kit's), the API
// under /api/v2, registration with Basic authorization (POST /clients gives
// the same token to the same user), the token as a query parameter, the UI
// configuration, values as strings, the error object. Latency, refusals,
// silences, 423 and 429 on demand; every request recorded (without secrets).
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { certs } from '../kit/certs.mjs';

export const USER = 'gladys';
export const PASSWORD = 'pa55-W0rd-of-test';
export const TOKEN = 'wlkTNYIsYLJLsrw68Z3goYdQf6uiO4jD';
export const OTHER_TOKEN = 'Zz9TNYIsYLJLsrw68Z3goYdQf6uiO4jE';

/** The project of the tests (the shape of PDF 8.2). */
export function fixtureConfig() {
  const fn = (uid, channel, displayName, points, functionType = '') => ({
    uid,
    functionType,
    channelType: `de.gira.schema.channels.${channel}`,
    displayName,
    dataPoints: points.map(([name, dpUid, flags = 'rw']) => ({
      uid: dpUid,
      name,
      canRead: flags.includes('r'),
      canWrite: flags.includes('w'),
      canEvent: true,
    })),
  });
  return {
    uid: 'a036',
    functions: [
      fn('a029', 'KNX.Dimmer', 'Lampe Links', [
        ['OnOff', 'a02a'],
        ['Shift', 'a02x', 'w'],
        ['Brightness', 'a02b'],
      ]),
      fn('a030', 'Switch', 'Flur', [['OnOff', 'a031']]),
      fn('a040', 'BlindWithPos', 'Rollladen Küche', [
        ['Step-Up-Down', 'a041', 'w'],
        ['Up-Down', 'a042', 'w'],
        ['Movement', 'a043', 'r'],
        ['Position', 'a044'],
        ['Slat-Position', 'a045'],
      ]),
      fn('a050', 'BlindWithPos', 'Markise', [
        ['Step-Up-Down', 'a051', 'w'],
        ['Up-Down', 'a052', 'w'],
      ]),
      fn('a060', 'SceneSet', 'Szenen', [
        ['Execute', 'a061', 'w'],
        ['Teach', 'a062', 'w'],
      ]),
      fn('a070', 'Sonos.Audio', 'Sonos-Audio', [
        ['Play', 'a071'],
        ['Volume', 'a072'],
      ]),
      fn('a080', 'DimmerRGBW', 'Farbe', [
        ['OnOff', 'a081'],
        ['Brightness', 'a082'],
        ['Red', 'a083'],
        ['Green', 'a084'],
        ['Blue', 'a085'],
      ]),
    ],
  };
}

export const fixtureValues = () => ({
  a02a: '0',
  a02b: '20',
  a031: '1',
  a043: '0',
  a044: '30',
  a045: '0',
  a071: '0',
  a072: '10',
  a081: '0',
  a082: '0',
  a083: '0',
  a084: '0',
  a085: '0',
});

/**
 * Options (all changeable on the returned object):
 * - latency(request) -> ms before the answer (default 0);
 * - silent(request) -> true: never answers; drop(request) -> true: closes the socket;
 * - replyFor(request) -> { status, body, headers } to answer instead;
 * - applySets: false -> a PUT is answered 200 but not applied;
 * - user, password, token; cert: the kit's device certificate (or another one).
 */
export async function fakeGira(options = {}) {
  const gira = {
    config: fixtureConfig(),
    values: fixtureValues(),
    user: USER,
    password: PASSWORD,
    token: TOKEN,
    latency: () => 0,
    silent: () => false,
    drop: () => false,
    replyFor: () => undefined,
    applySets: true,
    requests: [],
    port: 0,
    ...options,
  };
  const cert = options.cert ?? certs.device;
  gira.count = (match) =>
    gira.requests.filter((r) =>
      match instanceof RegExp
        ? match.test(`${r.method} ${r.path}`)
        : `${r.method} ${r.path}` === match,
    ).length;
  gira.puts = (uid) =>
    gira.requests.filter((r) => r.method === 'PUT' && r.path === `/values/${uid}`);
  /** The function owning a data point uid. */
  const owner = (uid) => gira.config.functions.find((f) => f.dataPoints.some((d) => d.uid === uid));

  const send = (res, status, body, headers = {}) => {
    if (res.destroyed) return;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      ...(text ? { 'content-type': 'application/json' } : {}),
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };
  const error = (res, status, code, message) => send(res, status, { error: { code, message } });

  const handle = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'https://gira');
    const path = url.pathname.replace(/^\/api\/v2/, '').replace(/^\/api/, '') || '/';
    let json;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const auth = req.headers.authorization ?? '';
    const basic = /^Basic (.+)$/.exec(auth);
    const creds = basic ? Buffer.from(basic[1], 'base64').toString('utf8') : undefined;
    const request = {
      method: req.method,
      path,
      token: url.searchParams.get('token'),
      creds,
      json,
      at: performance.now(),
      url: req.url,
    };
    gira.requests.push(request);
    const delay = gira.latency(request);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (gira.silent(request)) return;
    if (gira.drop(request)) return req.socket.destroy();
    const forced = gira.replyFor(request);
    if (forced) return send(res, forced.status, forced.body, forced.headers);
    if (req.method === 'GET' && path === '/') {
      return send(res, 200, {
        info: 'GDS-REST-API',
        version: '2',
        deviceName: 'X1 Haus',
        deviceType: 'GIGSRVKX02',
        deviceVersion: '2.4.415.0',
      });
    }
    if (req.method === 'POST' && path === '/clients') {
      if (!creds || creds !== `${gira.user}:${gira.password}`) {
        return error(res, 401, 'invalidAuth', 'Missing or invalid authentication.');
      }
      if (typeof json?.client !== 'string')
        return error(res, 400, 'missingContent', 'Body is empty');
      return send(res, 201, { token: gira.token });
    }
    if (request.token !== gira.token) {
      return error(res, 401, 'invalidToken', 'Missing or invalid token.');
    }
    if (req.method === 'GET' && path === '/uiconfig/uid')
      return send(res, 200, { uid: gira.config.uid });
    if (req.method === 'GET' && path === '/uiconfig') return send(res, 200, gira.config);
    const m = /^\/values\/([a-z][a-z0-9]{3})$/.exec(path);
    if (m) {
      const uid = m[1];
      const fn = gira.config.functions.find((f) => f.uid === uid);
      if (req.method === 'GET') {
        if (fn) {
          return send(res, 200, {
            values: fn.dataPoints
              .filter((d) => d.canRead)
              .map((d) => ({ uid: d.uid, value: gira.values[d.uid] ?? '' })),
          });
        }
        if (owner(uid)) return send(res, 200, { values: [{ uid, value: gira.values[uid] ?? '' }] });
        return error(res, 404, 'uidNotFound', `UID ${uid} not found.`);
      }
      if (req.method === 'PUT') {
        if (!owner(uid)) return error(res, 404, 'uidNotFound', `UID ${uid} not found.`);
        if (json?.value === undefined) return error(res, 400, 'missingContent', 'Missing value');
        if (gira.applySets) gira.apply(uid, json.value);
        return send(res, 200);
      }
    }
    return error(res, 404, 'resourceNotFound', 'Resource not found.');
  };

  /** What a PUT does on the simulated bus (KNX conventions of the PDF). */
  gira.apply = (uid, value) => {
    const fn = owner(uid);
    const dp = fn.dataPoints.find((d) => d.uid === uid);
    const pos = fn.dataPoints.find((d) => d.name === 'Position');
    if (dp.name === 'Up-Down') {
      if (pos) gira.values[pos.uid] = Number(value) === 1 ? '100' : '0';
    } else if (dp.name === 'Step-Up-Down') {
      // A stop: the position stays.
    } else if (dp.name === 'Brightness') {
      gira.values[uid] = String(Number(value) + 0.196078);
      const onOff = fn.dataPoints.find((d) => d.name === 'OnOff');
      if (onOff) gira.values[onOff.uid] = Number(value) > 0 ? '1' : '0';
    } else {
      gira.values[uid] = String(value);
    }
  };

  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    res.on('error', () => {});
    handle(req, res).catch(() => res.destroy());
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(gira.port, '127.0.0.1', resolve));
  gira.port = server.address().port;
  gira.address = `127.0.0.1:${gira.port}`;
  gira.fingerprint = cert.fingerprint256;
  gira.close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return gira;
}
