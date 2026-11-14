// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized. Nothing here
// talks to the network.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LANGUAGES, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  server_address: '',
  username: '',
  certificate_fingerprint: '',
  poll_interval: POLL_INTERVAL.default,
  allow_control: false,
  allow_open: false,
  allow_scenes: false,
  excluded_functions: '',
  awning_functions: '',
  gate_functions: '',
  language: 'fr',
};

/** A UID of the API (PDF 2.1): four small letters and digits, a letter first (some room kept). */
export const UID = /^[a-z][a-z0-9]{2,11}$/;
/** A client access token (PDF 4.2): 32 letters and digits. */
export const TOKEN = /^[0-9A-Za-z]{32}$/;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The server address from what the user typed: "192.168.1.30",
 * "192.168.1.30:8443", "https://192.168.1.30/" or ".../api/v2".
 * @returns {{ host: string, port: number, key: string } | { error: string }}
 */
export function parseAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { error: 'empty' };
  if (CONTROL.test(text) || /\s/.test(text)) return { error: 'invalid' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { error: 'scheme' };
  if (url.username || url.password) return { error: 'credentials' };
  if (!/^\/((api(\/v2)?)\/?)?$/i.test(url.pathname) || url.search || url.hash) {
    return { error: 'path' };
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[')) {
    host = host.slice(1, -1);
    if (/^ff/i.test(host) || host === '::') return { error: 'broadcast' };
  } else if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) return { error: 'invalid' };
    if (parts[0] === 0 || (parts[0] >= 224 && parts[0] <= 239) || parts.every((p) => p === 255)) {
      return { error: 'broadcast' };
    }
  } else if (!HOSTNAME.test(host)) {
    return { error: 'invalid' };
  } else if (/\.local$/.test(host)) {
    // mDNS names do not resolve inside the container (bridge network).
    return { error: 'local-name' };
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };
  const shown = host.includes(':') ? `[${host}]` : host;
  return { host, port, key: `${shown}:${port}` };
}

/**
 * A SHA-256 certificate fingerprint as Node shows it (`AB:CD:...`, 32 bytes),
 * from hex with or without colons; '' is none.
 * @returns {{ fingerprint?: string, error?: 'fingerprint' }}
 */
export function parseFingerprint(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^sha-?256[:=\s]*/i, '');
  if (text === '') return {};
  const hex = text.replace(/[:\s]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { error: 'fingerprint' };
  return { fingerprint: hex.toUpperCase().match(/../g).join(':') };
}

/** A list of function ids (separated by commas, spaces or semicolons), and the invalid entries. */
export function parseUidList(raw) {
  const ids = new Set();
  let invalid = 0;
  for (const entry of String(raw ?? '').split(/[\s,;]+/)) {
    if (entry === '') continue;
    if (UID.test(entry) && ids.size < 500) ids.add(entry);
    else invalid += 1;
  }
  return { ids, invalid };
}

/** Only true (or "true") turns an option on: anything else keeps it off. */
const on = (raw) => raw === true || raw === 'true';

const bounded = (raw, { min, max, default: fallback }) => {
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : fallback;
};

/**
 * The user name and password of the Gira server user. Basic authentication
 * (RFC 7617): no ":" in the user name, no control character in either.
 */
function credentialsOf(c) {
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  if (username === '' && password === '') return { error: 'no-credentials' };
  if (username === '') return { error: 'no-username' };
  if (password === '') return { error: 'no-password' };
  if (username.includes(':') || CONTROL.test(username) || username.length > 64) {
    return { error: 'bad-username' };
  }
  if (CONTROL.test(password) || password.length > 128) return { error: 'bad-password' };
  return { username, password };
}

/**
 * @returns {{ host?: string, port?: number, address?: string, username: string,
 *   password: string, fingerprint?: string, error?: string, pollInterval: number,
 *   allowControl: boolean, allowOpen: boolean, allowScenes: boolean, excluded: Set<string>,
 *   awnings: Set<string>, gates: Set<string>, invalidLists: number, language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const target = parseAddress(c.server_address);
  const pin = parseFingerprint(c.certificate_fingerprint);
  const creds = credentialsOf(c);
  const error = target.error ?? pin.error ?? creds.error;
  const excluded = parseUidList(c.excluded_functions);
  const awnings = parseUidList(c.awning_functions);
  const gates = parseUidList(c.gate_functions);
  return {
    host: target.host,
    port: target.port,
    address: target.key,
    username: creds.error ? '' : creds.username,
    password: creds.error ? '' : creds.password,
    fingerprint: pin.fingerprint,
    error,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    allowControl: on(c.allow_control),
    allowOpen: on(c.allow_open),
    allowScenes: on(c.allow_scenes),
    excluded: excluded.ids,
    awnings: awnings.ids,
    gates: gates.ids,
    invalidLists: excluded.invalid + awnings.invalid + gates.invalid,
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULT_CONFIG.language,
  };
}

/** Two configurations that run the same way (a reconnection to Gladys keeps everything). */
const comparable = (c) => ({
  ...c,
  excluded: [...(c.excluded ?? [])].sort(),
  awnings: [...(c.awnings ?? [])].sort(),
  gates: [...(c.gates ?? [])].sort(),
});
export const sameConfig = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/** The parts of the configuration that make another session (address, account, pin). */
export const sameSession = (a, b) =>
  a.address === b.address &&
  a.username === b.username &&
  a.password === b.password &&
  a.fingerprint === b.fingerprint &&
  !a.error &&
  !b.error;
