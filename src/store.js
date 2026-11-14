// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only:
//   - the certificate pinned for each server address (a public value);
//   - a user name and password refused by the server, as a 6-bit salted mark
//     only (it can never tell them, it only says "the same ones were refused");
//   - the end of a 429 pause, the time of the last read;
//   - the switch-offs that never reached the server, with the date of the
//     click: sent first after a restart, at most 10 min after the click. A
//     cover move, or a switch-off that reached the server, is never replayed.
// No token, no password, no label, no personal data.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (throws):
// an unreadable /data is never taken for an empty one (no pin is learnt over
// it). A special file (FIFO, device, directory) is refused without opening
// it. Writes go one at a time (temporary file, then rename).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { UID } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/gira-state.json';
const MAX_SIZE = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (!info.isFile()) throw new Error('state file unreadable (not a regular file)');
      if (info.size > MAX_SIZE) throw new Error('state file too large');
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (text.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip; `failLoad`, `failSave`, `hang`, `hangLoad` break it. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** The 6-bit mark of a user name and password with a salt (0 to 63): never enough to find them. */
export const credentialsMark = (salt, username, password) =>
  createHash('sha256').update(`${salt}\n${username}\n${password}`, 'utf8').digest()[0] & 0x3f;

export const newSalt = () => randomBytes(8).toString('hex');

const ADDRESS = /^[a-z0-9.:[\]-]{1,260}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** An empty memory. */
export const emptyMemory = () => ({
  pins: {},
  refused: null,
  pausedUntil: null,
  lastReadAt: null,
  guards: [],
});

/**
 * The persisted state, repaired and bounded. A date in the future is not
 * trusted: the last read counts as now, a pause is at most 6 h from now.
 * An unreadable count of sends is 0 (never "used up").
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = emptyMemory();
  const entries = (obj) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj).slice(0, 8) : [];
  for (const [address, fp] of entries(data.pins)) {
    if (ADDRESS.test(address) && typeof fp === 'string' && FINGERPRINT.test(fp)) {
      out.pins[address] = fp;
    }
  }
  const r = data.refused;
  if (
    r &&
    typeof r === 'object' &&
    typeof r.address === 'string' &&
    ADDRESS.test(r.address) &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{16}$/.test(r.salt) &&
    Number.isInteger(r.mark) &&
    r.mark >= 0 &&
    r.mark < 64
  ) {
    out.refused = { address: r.address, salt: r.salt, mark: r.mark };
  }
  if (Number.isFinite(data.pausedUntil) && data.pausedUntil > now) {
    out.pausedUntil = Math.min(data.pausedUntil, now + TIMINGS.rateLimitMax);
  }
  if (Number.isFinite(data.lastReadAt)) out.lastReadAt = Math.min(data.lastReadAt, now);
  if (Array.isArray(data.guards)) {
    const seen = new Set();
    for (const g of data.guards.slice(0, LIMITS.guards)) {
      if (!g || typeof g !== 'object') continue;
      // A switch-off never sent, dated: a date in the future or too old is dropped.
      const ok =
        typeof g.address === 'string' &&
        ADDRESS.test(g.address) &&
        typeof g.fid === 'string' &&
        UID.test(g.fid) &&
        typeof g.dpid === 'string' &&
        UID.test(g.dpid) &&
        g.key === 'OnOff' &&
        g.value === 0 &&
        Number.isFinite(g.at) &&
        g.at <= now &&
        now - g.at <= TIMINGS.stateMaxAge;
      const key = `${g.address} ${g.fid}`;
      if (!ok || seen.has(key)) continue;
      seen.add(key);
      out.guards.push({
        address: g.address,
        fid: g.fid,
        dpid: g.dpid,
        key: g.key,
        value: 0,
        at: g.at,
      });
    }
  }
  return out;
}
