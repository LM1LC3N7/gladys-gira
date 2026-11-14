// -----------------------------------------------------------------------------
// The Gira IoT REST API v2 of a Gira X1, HomeServer or FacilityServer
// (https://<server>/api/v2), from the official PDF "Gira IoT REST API v2".
//
// TLS: the server cannot show a trusted certificate (PDF, chapter 1: clients
// must skip the CA check). Here the CA check is replaced by a pin: every
// connection is a bare TLS handshake first; the certificate seen is compared
// with the pinned SHA-256 fingerprint BEFORE anything is written or read. A
// mismatch closes the socket: the password and the token never reach another
// server. Then one HTTP request is written on that socket (`createConnection`,
// no agent, `Connection: close`): one request per connection, never a pipeline.
//
// The password goes in the Basic authorization of the registration only
// (POST /clients, PDF 4.2); the token in the `token` query parameter (PDF 2.3).
// Neither is ever logged nor put in an error message: errors never carry the
// path. Redirections are never followed.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { API_BASE, CLIENT_ID, LIMITS, PATHS, TIMINGS } from './constants.js';
import { TOKEN } from './config.js';

export class GiraError extends Error {
  /**
   * @param {'nopin'|'pin'|'auth'|'forbidden'|'locked'|'rate'|'notfound'|'refused'|'server'|'redirect'|'network'|'timeout'|'size'|'format'|'aborted'} kind
   * @param {string} message never a token nor a password
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, fingerprint?: string, code?: string }} details
   *   sent: the request was written (it may have been done); status: the server answered
   */
  constructor(kind, message, { status, sent = false, retryAfter, fingerprint, code } = {}) {
    super(message);
    this.name = 'GiraError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.fingerprint = fingerprint;
    this.code = code;
  }

  /** The server answered (any status): the request reached it. */
  get answered() {
    return this.status !== undefined;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const networkError = (err, sent) =>
  err instanceof GiraError
    ? err
    : new GiraError('network', NETWORK[err?.code] ?? 'network error', { sent });

/** A short text of the server: no control character, nothing that looks like a token or a secret. */
export function cleanReason(text, secrets = []) {
  let out = typeof text === 'string' ? text : '';
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out
    .replace(/[0-9A-Za-z]{20,}/g, '***')
    .replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Retry-After (seconds, decimals accepted, or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, serverDate) {
  if (value === undefined || value === null || value === '') return undefined;
  if (/^\d{1,9}(\.\d+)?$/.test(String(value).trim())) {
    return Math.round(Number(String(value).trim()) * 1000);
  }
  // An HTTP date is compared with the server's own Date header, never with
  // the local clock; without a readable one, the default pause applies.
  const date = Date.parse(String(value));
  const now = Date.parse(String(serverDate ?? ''));
  return Number.isFinite(date) && Number.isFinite(now) ? Math.max(0, date - now) : undefined;
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * A TLS connection whose certificate is the pinned one; nothing is written nor
 * read before the check. Without a pin: refused (nothing sent).
 */
export function connectPinned({ host, port, pin, timeout = TIMINGS.connectTimeout, signal }) {
  return new Promise((resolve, reject) => {
    if (!pin) {
      reject(new GiraError('nopin', 'certificate not pinned'));
      return;
    }
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      // Self-signed (PDF, chapter 1): the CA check cannot pass; the pin below replaces it.
      rejectUnauthorized: false,
    });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => finish(new GiraError('aborted', 'stopped'));
    const onSecure = () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (seen !== pin) {
        finish(
          new GiraError('pin', 'the certificate of the server changed', {
            fingerprint: typeof seen === 'string' && FINGERPRINT.test(seen) ? seen : undefined,
          }),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new GiraError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', onSecure);
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/** The fingerprint of the certificate the server shows (a bare handshake: nothing is sent). */
export function readFingerprint({ host, port, timeout = TIMINGS.connectTimeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new GiraError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (typeof seen === 'string' && FINGERPRINT.test(seen)) finish(undefined, seen);
      else finish(new GiraError('format', 'no certificate shown'));
    });
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/**
 * One request on a pinned connection; resolves { status, headers, body }.
 * `beforeSend()` runs once the certificate is checked, just before the first
 * byte of the request: it may throw to cancel (nothing sent).
 */
export async function pinnedRequest({
  host,
  port,
  pin,
  method,
  path,
  token,
  basic,
  json,
  timeout = TIMINGS.readTimeout,
  idleTimeout = TIMINGS.idleTimeout,
  maxBytes = LIMITS.responseBytes,
  beforeSend,
  signal,
}) {
  const started = performance.now();
  const socket = await connectPinned({
    host,
    port,
    pin,
    timeout: Math.min(timeout, TIMINGS.connectTimeout),
    signal,
  });
  try {
    beforeSend?.();
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const left = Math.max(1, timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => settle(new GiraError('aborted', 'stopped', { sent }));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new GiraError('timeout', 'the server stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (basic) {
      headers.Authorization = `Basic ${Buffer.from(`${basic.username}:${basic.password}`, 'utf8').toString('base64')}`;
    }
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const query = token
      ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      : '';
    // No agent: the verified socket is the connection (never `agent: false`).
    const req = http.request({
      host,
      port,
      method,
      path: `${API_BASE}${path}${query}`,
      headers,
      createConnection: () => socket,
    });
    req.on('response', (res) => {
      armIdle();
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        settle(new GiraError('size', 'answer too large', { status: res.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new GiraError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
    const timer = setTimeout(
      () => settle(new GiraError('timeout', 'no answer within the delay', { sent })),
      left,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    sent = true;
    armIdle();
    req.end(body);
  });
}

/**
 * The JSON of an answer, or the GiraError it is (PDF 2: error object
 * `{ error: { code, message } }`). `empty`: a 2xx without body is fine (PUT).
 */
export function parseAnswer({ status, headers = {}, body }, { secrets = [], empty = false } = {}) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  const error = json && typeof json === 'object' ? json.error : undefined;
  const code =
    typeof error?.code === 'string' && /^[A-Za-z]{1,40}$/.test(error.code) ? error.code : undefined;
  const reason = cleanReason(error?.message, secrets);
  const at = { status, code };
  if (status >= 300 && status < 400) {
    throw new GiraError('redirect', `redirected (HTTP ${status})`, at);
  }
  if (status === 401 || (status === 422 && code === 'invalidToken')) {
    throw new GiraError('auth', `authorization refused (HTTP ${status})`, at);
  }
  if (status === 403) throw new GiraError('forbidden', 'not allowed for this user (HTTP 403)', at);
  if (status === 423) throw new GiraError('locked', 'the server is locked (HTTP 423)', at);
  if (status === 429) {
    throw new GiraError('rate', 'too many requests (HTTP 429)', {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status === 404) throw new GiraError('notfound', reason || 'not found (HTTP 404)', at);
  if (status >= 500) throw new GiraError('server', `HTTP ${status}`, at);
  if (status >= 400) throw new GiraError('refused', reason || `HTTP ${status}`, at);
  if (status < 200 || status >= 300) throw new GiraError('format', `HTTP ${status}`, at);
  if (json === undefined) {
    if (empty && (body ?? '').trim() === '') return {};
    throw new GiraError('format', 'not an answer of a Gira server', at);
  }
  return json;
}

/**
 * A client of one server: its address and pinned certificate are frozen for
 * the client's life; the token is read from `token()` at each request.
 */
export function createGira({
  host,
  port,
  pin,
  token = () => '',
  secrets = () => [],
  request = pinnedRequest,
  signal,
}) {
  const call = async (method, path, options = {}) => {
    const { empty, ...rest } = options;
    const tok = rest.token === null ? undefined : token();
    const answer = await request({ host, port, pin, method, path, signal, ...rest, token: tok });
    return parseAnswer(answer, { secrets: [tok, ...secrets()], empty });
  };
  return {
    host,
    port,
    pin,
    /** The API availability check (PDF 3): no token. */
    info: (o) => call('GET', PATHS.info, { ...o, token: null }),
    uiconfigUid: (o) => call('GET', PATHS.uiconfigUid, o),
    uiconfig: (o) => call('GET', PATHS.uiconfig, { maxBytes: LIMITS.uiconfigBytes, ...o }),
    values: (uid, o) => call('GET', PATHS.values(uid), o),
    /** Sets one data point (PDF 6.3); the 200 carries no value (a read confirms). */
    setValue: (uid, value, o) =>
      call('PUT', PATHS.values(uid), { ...o, json: { value }, empty: true }),
  };
}

/**
 * Registers the client with the user name and password (PDF 4.2): the server
 * gives the same token to the same user and client identifier at every call.
 * @returns {Promise<string>} the token (never log it)
 */
export async function register({
  host,
  port,
  pin,
  username,
  password,
  request = pinnedRequest,
  signal,
  timeout = TIMINGS.readTimeout,
  beforeSend,
}) {
  const answer = await request({
    host,
    port,
    pin,
    method: 'POST',
    path: PATHS.clients,
    basic: { username, password },
    json: { client: CLIENT_ID },
    timeout,
    maxBytes: 16 * 1024,
    signal,
    beforeSend,
  });
  const json = parseAnswer(answer, { secrets: [password] });
  const token = typeof json?.token === 'string' ? json.token.trim() : '';
  if (!TOKEN.test(token)) throw new GiraError('format', 'the server answered without a token');
  return token;
}
