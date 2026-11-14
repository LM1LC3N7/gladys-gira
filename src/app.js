// -----------------------------------------------------------------------------
// The integration: one Gira server (X1, HomeServer, FacilityServer) through
// its IoT REST API v2; its lights, dimmers and covers turned into Gladys
// devices, its scenes run by a scene action; commands sent over REST, one
// HTTPS connection each, on the pinned certificate.
//
// Access: the user name and password of a user of the server register the
// client (POST /clients, Basic, PDF 4.2) and give a token, kept in memory only
// (the server gives the same one again at the next registration). Refused
// (401 there): kept as a 6-bit mark in /data, never tried again alone.
//
// Reads, at the interval, never sooner after the last one, even across a
// restart (/data): the UI configuration id (its full text when it changed),
// then the values of the functions created in Gladys, one request at a time.
// A 429 pauses every path but the stops.
//
// Writes are off by default. Protective commands (turn off, cover stop and
// close) are never held back: no option, no bound, no pause, no queue, no read
// nor command in flight stops them; they cancel what waits for the same
// target. A switch-off is kept (in /data) until a read started after the
// server's answer shows it applied; it is sent again at most 3 times when a
// read shows it is not, and only a send the server answered counts. Other
// commands leave within 3.5 s or not at all, after every check (option,
// configuration read, token, pause), checked again right before the first byte.
//
// Order: every request gets a number when it leaves (`beforeSend`); a read
// that started before a command of a target never applies to that target
// after it. Clocks: wall time only for /data, monotonic for every decision.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { UID, normalizeConfig, parseAddress, sameConfig, sameSession } from './config.js';
import { LIMITS, SCENE_NUMBER, TIMINGS } from './constants.js';
import { GiraError, createGira, readFingerprint, register } from './gira.js';
import { T, word } from './i18n.js';
import {
  Refusal,
  applied,
  buildModel,
  channelOfDevice,
  cleanText,
  commandNumber,
  emptyModel,
  inventoryOf,
  numberOf,
  stopFromDevice,
  valuesOf,
  valuesOfAnswer,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { credentialsMark, emptyMemory, fileStore, newSalt, normalizeMemory } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** The fields of a created feature kept when a device is published again. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

export class GiraApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'gira' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    fingerprint = readFingerprint,
    registerClient = register,
    request,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.readFingerprint = fingerprint;
    this.registerClient = registerClient;
    this.request = request;
    this.raw = {};
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'unloaded' | 'loaded' | 'unreadable' */
    this.memoryState = 'unloaded';
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    // Session (reset at each start).
    this.client = null;
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.reading = false;
    this.readTimer = undefined;
    this.readDue = 0;
    this.lastReadMono = -Infinity;
    this.blocked = false;
    this.pauseEnd = -Infinity;
    this.pinError = undefined;
    // Token (memory only) and the account it belongs to.
    this.token = '';
    this.tokenFor = '';
    this.tokenPromise = undefined;
    // UI configuration.
    this.inventory = undefined;
    this.stale = true;
    this.model = emptyModel();
    this.values = new Map();
    this.readCursor = 0;
    this.secondary = new Map();
    this.known = new Map();
    this.publishedDevices = undefined;
    this.transports = new Map();
    this.lastStatus = undefined;
    this.deviceInfo = undefined;
    // Commands and stops.
    this.counter = 0;
    /** target -> mark of the last request that left for it */
    this.lastSent = new Map();
    /** target -> number of stops received (a queued command of an older number is cancelled) */
    this.epochs = new Map();
    this.stopCount = 0;
    /** `${address} ${fid}` -> guard */
    this.guards = new Map();
    this.guardTimer = undefined;
    this.chains = new Map();
    this.slotsUsed = 0;
    this.slotWaiters = [];
    this.followUps = new Set();
    this.unconfirmed = new Set();
    // Values sent to Gladys.
    /** feature id -> { value, at (monotonic) } */
    this.lastValues = new Map();
    this.created = new Set();
    this.createdIds = new Set();
    // Buttons of the configuration screen.
    this.lastTest = undefined;
    this.pendingTrust = undefined;
    this.lastAttemptSaved = -Infinity;
    this.publisher = new StatePublisher({ gladys, logger, now: mono, timers });
  }

  // --- /data ---------------------------------------------------------------------

  /** A promise bounded in time: a slow /data never holds what waits on it. */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new Error('timed out')), ms);
      Promise.resolve(promise).then(
        (v) => {
          this.timers.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async loadMemory() {
    if (this.memoryState !== 'unloaded') return;
    try {
      const raw = await this.bounded(this.store.load(), TIMINGS.dataWait);
      this.memory = normalizeMemory(raw, this.now());
      this.memoryState = 'loaded';
    } catch (err) {
      // Unreadable is not empty: nothing learnt is written over it in this run.
      this.memoryState = 'unreadable';
      this.logger.warn(
        `Gira: /data unreadable (${err?.message ?? 'error'}): nothing kept this run`,
      );
    }
    const left = (this.memory.pausedUntil ?? 0) - this.now();
    if (left > 0) this.pauseEnd = this.mono() + Math.min(left, TIMINGS.rateLimitMax);
    // The last read of a previous run paces Scan and Test too (written at most
    // once a minute: it may have been up to a minute later than kept).
    if (this.memory.lastReadAt !== null) {
      const ago = Math.max(0, this.now() - this.memory.lastReadAt - TIMINGS.attemptWriteEvery);
      this.lastReadMono = Math.max(this.lastReadMono, this.mono() - ago);
    }
  }

  /** Writes /data in the background (never awaited on a command path). */
  saveSoon() {
    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));
    const write = Promise.resolve(this.store.save(this.memory));
    write.catch((err) => this.logger.warn(`Gira: writing /data failed (${err?.message})`));
    return write;
  }

  /** Writes /data and waits for it, bounded: for what must be kept before going on (a pin). */
  async saveNow() {
    if (this.memoryState !== 'loaded') throw new Error('/data unreadable');
    await this.bounded(this.store.save(this.memory), TIMINGS.dataWait);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Gira: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(Math.round(wait / 1000)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Gira: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: true });
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: false });
  }

  /** The same configuration keeps the session; options only keep it too; another one starts again. */
  async applyConfig(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    if (sameConfig(next, this.config)) {
      this.raw = { ...(raw ?? {}) };
      // Gladys may have restarted: what it keeps in memory only is sent again
      // (status, Discovery, badges), never an old value as a new one.
      this.lastStatus = undefined;
      this.publishedDevices = undefined;
      this.transports.clear();
      this.refreshCreated();
      await this.publishDevices();
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    if (sameSession(next, this.config)) {
      // Options only (writes, scenes, language, interval): the session goes on;
      // the Discovery is rebuilt at once, the reads keep their pace.
      this.raw = { ...(raw ?? {}) };
      this.config = next;
      this.rebuild();
      await this.publishDevices();
      if (this.online && !this.reading) {
        const interval = this.readInterval();
        this.scheduleRead(
          this.generation,
          clamp(this.lastReadMono + interval - this.mono(), 0, interval),
        );
      }
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    if (!reconnected) this.logger.info('Gira: configuration changed, starting again');
    await this.start(raw);
  }

  accountKey(c = this.config) {
    return c.address && c.username ? `${c.address}\n${c.username}\n${c.password}` : '';
  }

  /**
   * A new session. The first read is `tick`'s to time: never sooner than the
   * interval after the last read of this server (this run, or /data after a
   * restart), nor during a pause; another address or account reads at once.
   * `read`: the UI configuration the Test button has just read, taken as the
   * read of this session.
   */
  async start(raw = {}, { read } = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    const previous = this.config;
    this.config = normalizeConfig(raw);
    await this.loadMemory();
    if (!this.current(generation)) return;
    const accountChanged =
      previous.address !== undefined && this.accountKey(previous) !== this.accountKey();
    if (accountChanged && this.memory.refused) {
      // Other credentials saved while running are tried: the refusal kept in
      // /data is the older ones' (its 6-bit mark alone would take the new ones
      // for them 1 time in 64).
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
    // Another server or account, saved while running: read at once.
    if (accountChanged) this.lastReadMono = -Infinity;
    if (previous.address !== this.config.address) {
      this.inventory = undefined;
      this.model = emptyModel();
      this.known.clear();
      this.lastValues.clear();
      this.values.clear();
    }
    if (this.tokenFor !== this.accountKey()) {
      this.token = '';
      this.tokenFor = '';
    }
    this.abort = new AbortController();
    this.online = false;
    this.stale = true;
    this.lastError = undefined;
    this.failures = 0;
    this.pinError = undefined;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.transports.clear();
    this.secondary.clear();
    this.refreshCreated();
    this.publisher.start();
    this.adoptConfigPin();
    this.blocked = this.refusalKept();
    // The stops kept in /data for this server leave first: before any read.
    this.restoreGuards();
    this.flushGuards();
    if (this.config.error) {
      await this.showStatus();
      return;
    }
    if (read) {
      await this.takeRead(read.inventory);
      if (this.current(generation)) this.scheduleRead(generation, this.readInterval());
      return;
    }
    this.rebuild();
    await this.publishDevices();
    await this.showStatus();
    if (!this.current(generation)) return;
    // `tick` puts the read off to its time (interval after the last read, pause).
    this.scheduleRead(generation, 0);
  }

  /** The reads and the timers of this run end; a stop in flight goes on. */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    this.abort.abort();
    this.publisher.stop();
    this.client = null;
    this.online = false;
    this.reading = false;
    if (shutdown) {
      this.closed = true;
      this.timers.clearTimeout(this.configTimer);
      this.timers.clearTimeout(this.guardTimer);
      this.configTimer = undefined;
      this.guardTimer = undefined;
    }
  }

  /** The container stops: everything ends; /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    this.stopAbort?.abort();
    if (this.memoryState === 'loaded') {
      this.memory.guards = this.guardRecords();
      await this.saveNow().catch(() => {});
    }
  }

  current(generation) {
    return generation === this.generation && !this.closed;
  }

  pauseLeft() {
    return Math.max(0, this.pauseEnd - this.mono());
  }

  paused() {
    return this.pauseLeft() > 0;
  }

  // --- Pin, token, refusal -----------------------------------------------------------

  /** The pin of the configuration's address: the field typed by the user, else /data. */
  pin(address = this.config.address) {
    if (address === this.config.address && this.config.fingerprint) return this.config.fingerprint;
    return this.memory.pins[address];
  }

  /** A fingerprint typed in the configuration is kept in /data (it is the pin from then on). */
  adoptConfigPin() {
    const { address, fingerprint } = this.config;
    if (!address || !fingerprint || this.memory.pins[address] === fingerprint) return;
    this.memory.pins[address] = fingerprint;
    this.saveSoon().catch(() => {});
  }

  refusalKept() {
    const r = this.memory.refused;
    const c = this.config;
    if (!r || r.address !== c.address || !c.username) return false;
    return credentialsMark(r.salt, c.username, c.password) === r.mark;
  }

  /** The user name or password was refused (401 at the registration): kept, never tried alone. */
  refuseCredentials(account) {
    if (account.key !== this.accountKey()) return;
    this.token = '';
    this.tokenFor = '';
    if (this.blocked) return;
    this.blocked = true;
    this.logger.warn(
      'Gira: the server refused the user name or password; waiting for new ones or the Test button',
    );
    const salt = newSalt();
    this.memory.refused = {
      address: account.address,
      salt,
      mark: credentialsMark(salt, account.username, account.password),
    };
    this.saveSoon().catch(() => {});
  }

  clearRefusal() {
    this.blocked = false;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
  }

  /**
   * A token for the account of the configuration: the one in memory, else a
   * registration (one at a time, shared by reads and stops). A 401 there is a
   * refusal of the user name or password ('credentials').
   */
  ensureToken({ timeout = TIMINGS.readTimeout } = {}) {
    const key = this.accountKey();
    if (this.token && this.tokenFor === key) return Promise.resolve(this.token);
    if (this.tokenPromise?.key === key) return this.tokenPromise.promise;
    const c = this.config;
    if (c.error || !key) return Promise.reject(new GiraError('nopin', 'not configured'));
    if (this.blocked) {
      return Promise.reject(new GiraError('credentials', 'user name or password refused'));
    }
    const pin = this.pin();
    if (!pin) return Promise.reject(new GiraError('nopin', 'certificate not pinned'));
    const account = { key, address: c.address, username: c.username, password: c.password };
    const promise = this.registerClient({
      host: c.host,
      port: c.port,
      pin,
      username: c.username,
      password: c.password,
      request: this.request,
      timeout,
    })
      .then((token) => {
        if (account.key === this.accountKey() && !this.closed) {
          this.token = token;
          this.tokenFor = key;
        }
        return token;
      })
      .catch((err) => {
        if (err?.kind === 'auth') {
          this.refuseCredentials(account);
          throw new GiraError('credentials', 'user name or password refused', {
            status: err.status,
          });
        }
        if (err?.kind === 'pin' && account.key === this.accountKey()) this.pinError = err;
        throw err;
      })
      .finally(() => {
        if (this.tokenPromise?.promise === promise) this.tokenPromise = undefined;
      });
    this.tokenPromise = { key, promise };
    return promise;
  }

  // --- Reading -------------------------------------------------------------------

  readInterval() {
    return this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms) {
    this.timers.clearTimeout(this.readTimer);
    this.readDue = this.mono() + ms;
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = undefined;
      if (this.current(generation)) {
        this.tick(generation).catch((err) => this.logger.error(`Gira loop: ${err?.message}`));
      }
    }, ms);
  }

  /** A client of this run (address and pin frozen; the token read at each request). */
  sessionClient() {
    if (!this.client) {
      this.client = createGira({
        host: this.config.host,
        port: this.config.port,
        pin: this.pin(),
        token: () => this.token,
        secrets: () => [this.config.password],
        request: this.request,
        signal: this.abort.signal,
      });
    }
    return this.client;
  }

  /** Records the time of a read before it leaves (in /data at most once a minute). */
  noteAttempt() {
    this.lastReadMono = this.mono();
    if (this.memoryState !== 'loaded') return;
    const now = this.mono();
    if (now - this.lastAttemptSaved < TIMINGS.attemptWriteEvery) return;
    this.lastAttemptSaved = now;
    this.memory.lastReadAt = this.now();
    this.saveSoon().catch(() => {});
  }

  async tick(generation) {
    if (!this.current(generation) || this.reading) return;
    if (this.blocked || this.config.error || !this.pin()) {
      await this.showStatus();
      return;
    }
    if (this.paused()) {
      await this.showStatus();
      this.scheduleRead(generation, this.pauseLeft());
      return;
    }
    // Never sooner than the interval after the last read, whoever made it
    // (the Test button reads too): put off to its due time.
    const early = this.lastReadMono + this.readInterval() - this.mono();
    if (early > 0) {
      this.scheduleRead(generation, early);
      return;
    }
    this.reading = true;
    const client = this.sessionClient();
    const previousRead = this.lastReadMono;
    this.noteAttempt();
    try {
      let fresh = !this.token;
      await this.ensureToken();
      if (!this.current(generation)) return;
      let uidAnswer;
      try {
        uidAnswer = await client.uiconfigUid({ timeout: TIMINGS.readTimeout });
      } catch (err) {
        // The token of an earlier registration may be gone (user removed and
        // added again): one new registration, then the same read, once.
        if (err?.kind !== 'auth' || fresh) throw err;
        this.token = '';
        this.tokenFor = '';
        fresh = true;
        await this.ensureToken();
        if (!this.current(generation)) return;
        uidAnswer = await client.uiconfigUid({ timeout: TIMINGS.readTimeout });
      }
      if (!this.current(generation)) return;
      const uid =
        typeof uidAnswer?.uid === 'string' && UID.test(uidAnswer.uid) ? uidAnswer.uid : '';
      if (!uid) throw new GiraError('format', 'no UI configuration id');
      if (!this.inventory || this.inventory.uid !== uid || this.stale) {
        // Another project (GPA download, app change): no command before it is read.
        this.stale = true;
        const inventory = inventoryOf(await client.uiconfig({ timeout: TIMINGS.readTimeout }));
        if (!this.current(generation)) return;
        if (!inventory.uid) throw new GiraError('format', 'not a UI configuration');
        this.adoptInventory(inventory);
      }
      await this.readValues(client, generation);
      if (!this.current(generation)) return;
      await this.takeRead();
    } catch (err) {
      // A certificate refused at the handshake: nothing reached the server,
      // so it does not count as a read (the pace starts from the last real one).
      if (err?.kind === 'pin' || err?.kind === 'nopin') this.lastReadMono = previousRead;
      if (this.current(generation)) await this.fail(generation, err);
      return;
    } finally {
      if (this.current(generation)) this.reading = false;
    }
    if (!this.current(generation)) return;
    this.scheduleRead(generation, this.readInterval());
  }

  /** The functions whose values are read this cycle: created in Gladys or kept stops, in turn. */
  readQueue() {
    const wanted = [];
    for (const [fid, deviceId] of this.model.targetDevices) {
      const points = this.model.readPoints.get(fid);
      if (!points || points.size === 0) continue;
      if (this.createdIds.has(deviceId) || this.guardOf(fid)) wanted.push(fid);
    }
    if (wanted.length <= LIMITS.readsPerCycle) return wanted;
    // More than a cycle reads: in turn, none forgotten.
    const start = this.readCursor % wanted.length;
    const out = [];
    for (let i = 0; i < LIMITS.readsPerCycle; i += 1) out.push(wanted[(start + i) % wanted.length]);
    this.readCursor = (start + LIMITS.readsPerCycle) % wanted.length;
    return out;
  }

  /**
   * The values of each function, one request at a time. A secondary route: a
   * 401/403 or a 404 of one function never stops the others nor refuses the
   * account; a 429 or a changed certificate stops the cycle; when every read
   * fails, the cycle fails.
   */
  async readValues(client, generation) {
    const queue = this.readQueue();
    let failed = 0;
    let lastErr;
    for (const fid of queue) {
      if (!this.current(generation)) return;
      const held = this.secondary.get(fid);
      if (held && this.mono() < held.until) continue;
      const startMark = ++this.counter;
      try {
        const map = valuesOfAnswer(await client.values(fid, { timeout: TIMINGS.readTimeout }));
        if (!this.current(generation)) return;
        this.secondary.delete(fid);
        for (const [dpid, text] of map) this.applyValue(fid, dpid, text, startMark);
      } catch (err) {
        if (['rate', 'pin', 'nopin', 'aborted', 'locked'].includes(err?.kind)) throw err;
        failed += 1;
        lastErr = err;
        if (err?.kind === 'notfound') {
          // Gone from the project: the UI configuration is read again next time.
          this.stale = true;
        } else if (err?.kind === 'auth' || err?.kind === 'forbidden') {
          // Not a refusal of the account nor of the token (the main read
          // decides): "not read", spaced, doubling up to 1 h.
          const n = (held?.n ?? 0) + 1;
          this.secondary.set(fid, {
            n,
            until: this.mono() + Math.min(TIMINGS.secondaryMax, this.readInterval() * 2 ** n),
          });
        }
        this.logger.debug?.(`Gira: values of ${fid} not read (${err?.message})`);
      }
    }
    if (queue.length > 0 && failed === queue.length && lastErr?.kind !== 'notfound') throw lastErr;
  }

  /** A UI configuration read: the model, the Discovery; commands allowed again. */
  adoptInventory(inventory) {
    this.inventory = inventory;
    this.rebuild();
    this.stale = false;
  }

  /** A read done (by the loop or the Test button): online, Discovery, status. */
  async takeRead(inventory) {
    if (inventory) this.adoptInventory(inventory);
    const wasOnline = this.online;
    this.online = true;
    this.failures = 0;
    this.lastError = undefined;
    this.pinError = undefined;
    if (!wasOnline) {
      this.logger.info(
        `Gira: connected, ${this.model.counts.offered} functions offered, ${this.model.counts.scenes} scene functions`,
      );
    }
    await this.publishDevices();
    await this.showStatus();
    await this.publishAllTransports();
  }

  retryDelay(err) {
    if (err?.kind === 'rate') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.readInterval());
  }

  pause(err) {
    const delay = this.retryDelay(err);
    this.pauseEnd = Math.max(this.pauseEnd, this.mono() + delay);
    this.memory.pausedUntil = this.now() + delay;
    this.saveSoon().catch(() => {});
    return delay;
  }

  async fail(generation, err) {
    this.online = false;
    this.lastError = err;
    if (err?.kind === 'credentials') {
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    if (err?.kind === 'pin' || err?.kind === 'nopin') {
      // A changed certificate: never learnt again by itself; nothing is sent.
      this.pinError = err;
    }
    this.failures += 1;
    const delay = err?.kind === 'rate' ? this.pause(err) : this.retryDelay(err);
    if (err instanceof GiraError) {
      this.logger.warn(`Gira: ${err.message} (next read in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('Gira: unexpected failure', err);
    }
    await this.showStatus();
    await this.publishAllTransports();
    if (this.current(generation)) this.scheduleRead(generation, delay);
  }

  /**
   * A request that failed on a side path (read back, command, scene): a 429
   * pauses. A 401/403 there is never a refused account nor a lost token: the
   * main read decides (the UI configuration id, at the interval).
   */
  sideError(err) {
    if (err?.kind === 'rate') this.pause(err);
  }

  rebuild() {
    this.model = this.inventory
      ? buildModel((type, id) => this.gladys.externalIds(type, id), this.inventory.functions, {
          language: this.config.language,
        })
      : emptyModel();
  }

  /**
   * One data point value read. A read that started before a command of its
   * function left never applies (the command may have changed it); it still
   * tells a kept stop whether it is applied when it started after its answer.
   */
  applyValue(fid, dpid, text, startMark) {
    const guard = this.guardOf(fid);
    if (guard) this.considerGuard(guard, dpid, text, startMark);
    if ((this.lastSent.get(fid) ?? 0) > startMark) return;
    this.values.set(dpid, text);
    const at = this.mono();
    for (const { featureId, value } of valuesOf(this.model, dpid, text)) {
      this.lastValues.set(featureId, { value, at });
      if (this.created.has(featureId)) this.publisher.push(featureId, { state: value });
    }
  }

  // --- Discovery, badges, status --------------------------------------------------

  /** The devices of the model, merged: a device never loses a feature in a run. */
  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const fresh of this.model.devices) {
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) features.set(f.external_id, f);
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (json === this.publishedDevices) return;
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.publishedDevices = json;
    } catch (err) {
      this.logger.warn(`Gira: publishing the Discovery failed (${err?.message})`);
    }
  }

  transportOf(deviceId) {
    if (!this.online) return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    for (const [target, id] of this.model.targetDevices) {
      if (id !== deviceId) continue;
      if (this.guardOf(target)) {
        return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.stopKept };
      }
      if (this.unconfirmed.has(target)) {
        return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
      }
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishAllTransports() {
    const entries = [];
    for (const deviceId of this.createdIds) {
      if (!this.known.has(deviceId)) continue;
      const badge = this.transportOf(deviceId);
      const key = JSON.stringify(badge);
      if (this.transports.get(deviceId) !== key) {
        this.transports.set(deviceId, key);
        entries.push({ external_id: deviceId, ...badge });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Gira: badges failed (${err?.message})`));
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`Gira: setConnectionStatus failed (${err?.message})`));
  }

  /** The status from what is known now (one text, bounded). */
  statusText() {
    const c = this.config;
    const parts = [];
    let connected = false;
    if (c.error) parts.push(T.configError(c.error));
    else if (this.pinError?.kind === 'pin') parts.push(T.pinChanged(this.pinError.fingerprint));
    else if (!this.pin()) parts.push(T.noPin);
    else if (this.blocked) parts.push(T.credentialsRefused);
    else if (this.paused()) parts.push(T.paused(Math.ceil(this.pauseLeft() / 60_000)));
    else if (this.online) {
      connected = true;
      parts.push(T.connected(this.model.counts, c.pollInterval));
      if (this.stale) parts.push(T.configStale);
    } else if (this.lastError) parts.push(T.failure(this.lastError));
    else parts.push(T.connecting);
    const guards = this.ownGuards();
    if (guards.length > 0) parts.push(T.guards(guards.map((g) => this.guardSummary(g))));
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    return { connected, message: T.join(parts) };
  }

  async showStatus() {
    if (this.closed) return;
    const { connected, message } = this.statusText();
    await this.setStatus(connected, message);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(`Gira: ${err?.message}`));
  }

  // --- Devices created by the user -------------------------------------------------

  refreshCreated() {
    const devices = this.gladys.devices ?? [];
    this.createdIds = new Set(devices.map((d) => d.external_id));
    this.created = new Set(devices.flatMap((d) => (d.features ?? []).map((f) => f.external_id)));
  }

  /** A device created (or updated): its fresh values only, never an old one as new. */
  async deviceCreated(device) {
    this.refreshCreated();
    if (device?.external_id) this.createdIds.add(device.external_id);
    for (const f of device?.features ?? []) {
      this.created.add(f.external_id);
      const last = this.lastValues.get(f.external_id);
      if (last && this.mono() - last.at <= TIMINGS.freshness && this.online) {
        this.publisher.push(f.external_id, { state: last.value });
      }
    }
    this.transports.delete(device?.external_id);
    await this.publishAllTransports();
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Scan button: never a read sooner than the interval after the last one. */
  async scan() {
    const generation = this.generation;
    if (this.reading || this.mono() - this.lastReadMono < this.readInterval()) {
      this.publishedDevices = undefined;
      await this.publishDevices();
      return;
    }
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    await this.tick(generation);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(code, ...args) {
    const text = T.denied[code];
    return new Refusal(
      code,
      word(typeof text === 'function' ? text(...args) : text, this.config.language),
    );
  }

  async setValue(device, feature, value) {
    // The deadline counts from the arrival of the command, before any wait.
    const received = this.mono();
    const writer = this.model.writers.get(feature?.external_id);
    let op;
    if (writer) {
      try {
        op = writer.write(value);
      } catch (err) {
        throw err instanceof Refusal ? this.refusal('badValue') : err;
      }
      // The function changed kind on the server since the device was created.
      const channel = channelOfDevice(device);
      if (channel !== undefined && channel !== writer.channelType) {
        op = stopFromDevice(device, feature, value);
        if (!op) throw this.refusal('identityChanged');
      }
    } else {
      // UI configuration not known (before the first read): a stop still
      // leaves, from the device's params.
      op = stopFromDevice(device, feature, value);
      if (!op) throw this.refusal(this.online ? 'notCommand' : 'notConnected');
    }
    try {
      if (op.protective) return await this.protect(op);
      return await this.command(op, received);
    } catch (err) {
      // Gladys shows the value asked for: the last value read goes again.
      this.gladys.forgetPublishedStates?.(feature.external_id);
      const last = this.lastValues.get(feature.external_id);
      if (last && this.created.has(feature.external_id)) {
        this.publisher.push(feature.external_id, { state: last.value });
      }
      throw err;
    }
  }

  /** The scene action: runs scene `scene` of the scene function `function`. */
  async runScene(fields = {}) {
    const received = this.mono();
    const uid = typeof fields.function === 'string' ? fields.function.trim() : '';
    const n = commandNumber(fields.scene);
    if (!Number.isInteger(n) || n < SCENE_NUMBER.min || n > SCENE_NUMBER.max) {
      throw this.refusal('badValue');
    }
    if (!UID.test(uid)) throw this.refusal('sceneUnknown');
    // The option, the connection and the project read first (checkReady).
    const scene = this.model.scenes.get(uid);
    const target = `scene:${uid}`;
    const op = {
      target,
      dpid: scene?.execute.uid,
      key: scene?.execute.name,
      value: n,
      protective: false,
      kind: 'scene',
      need: 'scenes',
    };
    this.checkReady(op);
    if (!scene) throw this.refusal('sceneUnknown');
    await this.command(op, received);
    return undefined;
  }

  /** Runs `task` after the previous one of the same target. */
  serialized(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** A slot for a non-protective request, within the deadline (stops never take one). */
  async slot(deadline) {
    if (this.slotsUsed < LIMITS.commandSlots) {
      this.slotsUsed += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = this.timers.setTimeout(
        () => {
          this.slotWaiters = this.slotWaiters.filter((w) => w !== waiter);
          reject(this.refusal('tooLate'));
        },
        Math.max(0, deadline - this.mono()),
      );
      this.slotWaiters.push(waiter);
    });
  }

  release() {
    const next = this.slotWaiters.shift();
    if (next) {
      this.timers.clearTimeout(next.timer);
      next.resolve();
    } else {
      this.slotsUsed = Math.max(0, this.slotsUsed - 1);
    }
  }

  /** Every check of a non-protective command (again right before its first byte). */
  checkReady(op) {
    const c = this.config;
    if (c.error) throw this.refusal('notConfigured');
    if (this.blocked) throw this.refusal('credentialsRefused');
    if (op.need === 'control' && !c.allowControl) throw this.refusal('controlOff');
    if (op.need === 'open' && !c.allowOpen) throw this.refusal('openOff');
    if (op.need === 'scenes' && !c.allowScenes) throw this.refusal('scenesOff');
    if (this.paused()) throw this.refusal('paused');
    if (!this.pin()) throw this.refusal('noPin');
    if (!this.online || this.closed || !this.token) throw this.refusal('notConnected');
    if (this.stale) throw this.refusal('configStale');
    const guard = op.fid ? this.guardOf(op.fid) : undefined;
    if (guard?.inFlight) throw this.refusal('stopInFlight');
  }

  /** A non-protective command: sent within 3.5 s of its arrival, or not at all. */
  async command(op, received) {
    const deadline = received + TIMINGS.commandDeadline;
    this.checkReady(op);
    const epoch = this.epochs.get(op.target) ?? 0;
    const stops = this.stopCount;
    return this.serialized(op.target, async () => {
      this.checkReady(op);
      if (this.mono() > deadline) throw this.refusal('tooLate');
      await this.slot(deadline);
      // The slot is given back once the request is answered (not after the read back).
      let held = true;
      const release = () => {
        if (held) {
          held = false;
          this.release();
        }
      };
      try {
        return await this.send(op, deadline, epoch, stops, release);
      } finally {
        release();
      }
    });
  }

  async send(op, deadline, epoch, stops, release = () => {}) {
    const client = this.sessionClient();
    let mark;
    const beforeSend = () => {
      if (this.mono() > deadline) throw this.refusal('tooLate');
      this.checkReady(op);
      // A stop arrived since: what came before it never leaves after it.
      if (
        (this.epochs.get(op.target) ?? 0) !== epoch ||
        (op.kind === 'scene' && this.stopCount !== stops)
      ) {
        throw this.refusal('cancelled');
      }
      mark = ++this.counter;
      this.lastSent.set(op.target, mark);
    };
    const timeout = () => Math.max(300, deadline - this.mono());
    try {
      await client.setValue(op.dpid, op.value, { timeout: timeout(), beforeSend });
    } catch (err) {
      if (err instanceof Refusal) throw err;
      if (!err?.sent) throw this.refusal('notSent', err?.message ?? 'error');
      this.sideError(err);
      if (err.kind === 'auth') throw this.refusal('authRoute');
      if (err.kind === 'forbidden') throw this.refusal('forbidden');
      if (err.kind === 'locked') throw this.refusal('locked');
      if (err.kind === 'rate') throw this.refusal('paused');
      if (err.answered && ['refused', 'notfound', 'redirect'].includes(err.kind)) {
        throw this.refusal('refused', err.message);
      }
      // Sent, and no answer (or a 5xx): it may have been done.
      if (op.fid) this.markUnconfirmed(op);
      throw this.refusal(op.kind === 'scene' ? 'sceneUnconfirmed' : 'sentUnconfirmed');
    }
    release();
    // The server took it: a stop kept for this target gives way to it.
    if (op.fid) this.liftGuard(op.fid, mark);
    if (op.kind === 'scene') return undefined;
    if (!['OnOff', 'Brightness', 'Position'].includes(op.key)) {
      // Up-Down cannot be read back (PDF 9.2, write only): taken by the
      // server; the position is read again later.
      this.scheduleFollowUps(op, false);
      return undefined;
    }
    // Done only when a read started after the answer shows the value.
    const readMark = ++this.counter;
    let text;
    try {
      const map = valuesOfAnswer(await client.values(op.fid, { timeout: timeout() }));
      for (const [dpid, t] of map) this.applyValue(op.fid, dpid, t, readMark);
      text = map.get(op.dpid);
    } catch (err) {
      this.sideError(err);
    }
    if (applied(op, text) === true) {
      this.unconfirmed.delete(op.fid);
      return undefined;
    }
    this.markUnconfirmed(op);
    throw this.refusal('notYetApplied');
  }

  /** Read back later (5 s, 20 s); the badge says it until a read shows the state. */
  markUnconfirmed(op) {
    this.unconfirmed.add(op.fid);
    this.background(this.publishAllTransports());
    this.scheduleFollowUps(op, true);
  }

  scheduleFollowUps(op, confirm) {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(async () => {
        this.followUps.delete(timer);
        if (!this.current(generation) || !this.online || this.paused() || this.blocked) return;
        const readMark = ++this.counter;
        try {
          const map = valuesOfAnswer(
            await this.sessionClient().values(op.fid, { timeout: TIMINGS.readTimeout }),
          );
          if (!this.current(generation)) return;
          for (const [dpid, t] of map) this.applyValue(op.fid, dpid, t, readMark);
          if (
            confirm &&
            applied(op, map.get(op.dpid)) === true &&
            this.unconfirmed.delete(op.fid)
          ) {
            await this.publishAllTransports();
          }
        } catch (err) {
          this.sideError(err);
        }
      }, delay);
      this.followUps.add(timer);
    }
  }

  // --- Stops (protective commands) ------------------------------------------------

  guardKey(address, fid) {
    return `${address} ${fid}`;
  }

  guardOf(fid) {
    return this.config.address
      ? this.guards.get(this.guardKey(this.config.address, fid))
      : undefined;
  }

  ownGuards() {
    return [...this.guards.values()].filter((g) => g.address === this.config.address);
  }

  guardRecords() {
    // Only switch-offs are kept (never a cover move).
    const kept = [...this.guards.values()]
      .filter((g) => g.kind === 'state')
      .map(({ address, fid, dpid, key, value, answered }) => ({
        address,
        fid,
        dpid,
        key,
        value,
        answered,
      }));
    // Guards of other addresses kept in /data are not lost.
    for (const g of this.memory.guards) {
      if (!this.guards.has(this.guardKey(g.address, g.fid))) kept.push(g);
    }
    return kept.slice(0, LIMITS.guards);
  }

  persistGuards() {
    if (this.memoryState !== 'loaded') return;
    this.memory.guards = this.guardRecords();
    this.saveSoon().catch(() => {});
  }

  /** The stops kept in /data for this address become live guards (sent first). */
  restoreGuards() {
    for (const g of this.memory.guards) {
      if (g.address !== this.config.address) continue;
      const key = this.guardKey(g.address, g.fid);
      if (this.guards.has(key)) continue;
      this.guards.set(
        key,
        this.newGuard(
          { ...g, target: g.fid, kind: 'state', protective: true },
          g.address,
          g.answered,
        ),
      );
      this.logger.warn(
        `Gira: a switch-off of ${g.fid} not seen applied before the restart, sent again`,
      );
    }
  }

  newGuard(op, address, answered = 0) {
    return {
      address,
      fid: op.fid,
      dpid: op.dpid,
      key: op.key,
      value: op.value,
      kind: op.kind,
      answered,
      ok: false,
      okMark: undefined,
      sentMark: undefined,
      inFlight: undefined,
      again: false,
      stuck: false,
      reason: undefined,
      state: 'waiting',
      // A cover close: the position known when it was clicked (undefined:
      // unknown, never "changed elsewhere"), and the reads in a row showing it opened since.
      close: Boolean(op.close),
      posDpid: op.posDpid,
      before: undefined,
      changed: 0,
      needRead: false,
      reading: false,
    };
  }

  /** The position of a cover (percent closed) as last read, or undefined. */
  knownPosition(posDpid) {
    if (!posDpid) return undefined;
    const n = numberOf(this.values.get(posDpid));
    return n !== undefined && n >= 0 && n <= 100 ? Math.round(n) : undefined;
  }

  /**
   * A protective command: never held back by anything but a missing or
   * refused account or pin (then kept, and sent as soon as they are there).
   * The answer to Gladys waits for the first try at most 3.5 s; the stop goes
   * on after it.
   */
  async protect(op) {
    const address = this.config.address;
    if (!address) throw this.refusal('notConfigured');
    this.epochs.set(op.target, (this.epochs.get(op.target) ?? 0) + 1);
    this.stopCount += 1;
    const key = this.guardKey(address, op.fid);
    const guard = this.newGuard(op, address);
    if (guard.close) guard.before = this.knownPosition(op.posDpid);
    this.guards.set(key, guard);
    // Kept first (not awaited: a slow /data never holds a stop).
    if (guard.kind === 'state') this.persistGuards();
    this.armGuardTimer();
    const first = this.sendGuard(guard);
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TIMINGS.commandDeadline);
    });
    await Promise.race([first, late]);
    this.timers.clearTimeout(timer);
    this.background(this.publishAllTransports());
    this.background(this.showStatus());
    if (guard.ok || guard.state === 'applied') return undefined;
    throw this.refusal('stopKept', this.guardSummary(guard));
  }

  /** Whether a guard can leave now; else it waits (kept) for what it needs. */
  guardSendable(guard) {
    const c = this.config;
    if (this.closed || this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard)
      return false;
    if (guard.address !== c.address || !c.username || c.error) {
      guard.state = 'noAccount';
      return false;
    }
    if (this.blocked) {
      guard.state = 'refusedCredentials';
      return false;
    }
    if (!this.pin(guard.address)) {
      guard.state = 'noPin';
      return false;
    }
    return true;
  }

  /** Sends a guard now (with two quick retries within ~250 ms when it did not reach the server). */
  sendGuard(guard) {
    if (guard.inFlight) {
      guard.again = true;
      return guard.inFlight;
    }
    if (!this.guardSendable(guard)) return Promise.resolve();
    // A close sent again after a read of the cover leaves once for that read,
    // without quick retries: the cover may be opened by hand right after it.
    const quick = guard.close && guard.needRead ? [] : TIMINGS.stopQuickRetries;
    guard.inFlight = (async () => {
      for (let i = 0; i <= quick.length; i += 1) {
        if (i > 0) {
          await new Promise((resolve) => this.timers.setTimeout(resolve, quick[i - 1]));
          if (!this.guardSendable(guard)) return;
        }
        const outcome = await this.sendGuardOnce(guard);
        if (outcome !== 'unanswered') return;
      }
      // A close that did not reach the server is sent again only after a read
      // (the cover may have been opened by hand meanwhile).
      if (guard.close) guard.needRead = true;
    })().finally(() => {
      guard.inFlight = undefined;
      const again = guard.again;
      guard.again = false;
      // Asked again meanwhile (a flush, new credentials): once more, unless taken.
      if (again && !guard.ok) this.retryGuard(guard);
    });
    return guard.inFlight;
  }

  stopClient(guard) {
    const target = parseAddress(guard.address);
    if (!this.stopAbort || this.stopAbort.signal.aborted) this.stopAbort = new AbortController();
    return createGira({
      host: target.host,
      port: target.port,
      pin: this.pin(guard.address),
      token: () => this.token,
      secrets: () => [this.config.password],
      request: this.request,
      signal: this.stopAbort.signal,
    });
  }

  async sendGuardOnce(guard) {
    try {
      // No token yet (after a restart): the registration first, in the stop's budget.
      await this.ensureToken({ timeout: TIMINGS.stopTimeout });
    } catch (err) {
      return this.guardFailed(guard, err);
    }
    const client = this.stopClient(guard);
    try {
      await client.setValue(guard.dpid, guard.value, {
        timeout: TIMINGS.stopTimeout,
        beforeSend: () => {
          const mark = ++this.counter;
          guard.sentMark = mark;
          this.lastSent.set(guard.fid, mark);
        },
      });
    } catch (err) {
      return this.guardFailed(guard, err);
    }
    if (this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard) return 'ok';
    guard.answered += 1;
    guard.ok = true;
    guard.okMark = ++this.counter;
    guard.reason = undefined;
    if (guard.kind === 'move') {
      // A cover move is done once the server took it: never sent again on a
      // read (the user may have moved the cover since, from the wall or the app).
      guard.state = 'done';
      this.dropGuard(guard);
      this.background(this.readBackTarget(guard));
      return 'ok';
    }
    guard.state = 'sent';
    this.persistGuards();
    this.background(this.confirmGuard(guard));
    return 'ok';
  }

  /** What a failed send means for a stop; only an answer of the server counts as a send. */
  guardFailed(guard, err) {
    const kind = err?.kind;
    if (kind === 'credentials') {
      guard.state = 'refusedCredentials';
      this.background(this.showStatus());
      return 'refusedRoute';
    }
    if (kind === 'auth' || kind === 'forbidden') {
      // Not a refused account (only the registration says so): not counted,
      // kept, sent again at the stop pace.
      guard.state = 'authRoute';
      this.background(this.showStatus());
      return 'refusedRoute';
    }
    if (kind === 'pin') {
      this.pinError = err;
      guard.state = 'pinChanged';
      return 'unanswered';
    }
    if (kind === 'nopin') {
      guard.state = 'noPin';
      return 'refusedRoute';
    }
    if (kind === 'notfound') {
      // The data point is not on the server (any more): nothing to stop.
      guard.state = 'unknown';
      this.dropGuard(guard);
      this.logger.warn(`Gira: stop of ${guard.fid}: unknown on the server, dropped`);
      return 'gone';
    }
    if (kind === 'locked') {
      // Locked during a project download: not counted, sent again at the stop pace.
      guard.state = 'locked';
      return 'refusedRoute';
    }
    if (kind === 'refused' && err.answered) {
      guard.answered += 1;
      guard.state = 'refused';
      guard.reason = err.message;
      // Refused by the server 4 times: kept, shown, no more sends.
      if (guard.answered >= LIMITS.stopSends) guard.stuck = true;
      this.persistGuards();
      this.background(this.showStatus());
      return 'refused';
    }
    if (kind === 'rate') this.pause(err);
    guard.state = err?.sent ? 'noAnswer' : 'notSent';
    guard.reason = err?.message;
    return 'unanswered';
  }

  dropGuard(guard) {
    const key = this.guardKey(guard.address, guard.fid);
    if (this.guards.get(key) !== guard) return;
    this.guards.delete(key);
    this.memory.guards = this.memory.guards.filter((g) => this.guardKey(g.address, g.fid) !== key);
    this.persistGuards();
    this.background(this.publishAllTransports());
    this.background(this.showStatus());
  }

  /** A newer command of the target, taken by the server, lifts a kept stop sent before it. */
  liftGuard(fid, mark) {
    const guard = this.guardOf(fid);
    if (guard && !guard.inFlight && (guard.sentMark === undefined || guard.sentMark < mark)) {
      this.logger.info(`Gira: the stop of ${fid} gives way to a newer command`);
      this.dropGuard(guard);
    }
  }

  /** A read started after the answer: applied ends the guard; not applied sends it again (3 times at most). */
  considerGuard(guard, dpid, text, startMark) {
    if (dpid !== guard.dpid) return;
    // Only a read started after the last answer (refused: after the last send) tells.
    const after = guard.ok ? guard.okMark : guard.sentMark;
    if (after === undefined || startMark <= after) return;
    const result = applied(guard, text);
    if (result === true) {
      guard.state = 'applied';
      this.dropGuard(guard);
      return;
    }
    if (result !== false || !guard.ok) return;
    if (guard.answered < LIMITS.stopSends) {
      guard.ok = false;
      guard.state = 'contradicted';
      this.sendGuard(guard);
    } else if (!guard.stuck) {
      guard.stuck = true;
      guard.state = 'notApplied';
      this.logger.warn(
        `Gira: stop of ${guard.fid} still not applied after ${guard.answered} sends`,
      );
      this.background(this.showStatus());
    }
  }

  async readGuardValues(guard) {
    const map = valuesOfAnswer(
      await this.stopClient(guard).values(guard.fid, { timeout: TIMINGS.readTimeout }),
    );
    return map;
  }

  async confirmGuard(guard) {
    const readMark = ++this.counter;
    let map;
    try {
      map = await this.readGuardValues(guard);
    } catch {
      // Not read (any cause, 401/403 included): the stop timer reads again.
      return;
    }
    if (guard.address !== this.config.address) return;
    for (const [dpid, text] of map) this.applyValue(guard.fid, dpid, text, readMark);
  }

  async readBackTarget(guard) {
    if (guard.address !== this.config.address || !this.online || !guard.posDpid) return;
    const readMark = ++this.counter;
    try {
      const map = await this.readGuardValues(guard);
      for (const [dpid, text] of map) this.applyValue(guard.fid, dpid, text, readMark);
    } catch {
      // The next read brings it.
    }
  }

  /** Every kept stop of this address: sent (or read back) now. */
  flushGuards() {
    for (const guard of this.ownGuards()) this.workGuard(guard);
    this.armGuardTimer();
  }

  workGuard(guard) {
    if (guard.inFlight) {
      guard.again = true;
      return;
    }
    if (!guard.ok) {
      // Never taken by the server, or contradicted: sent (refusals counted, at most 4).
      if (guard.state !== 'refused' || guard.answered < LIMITS.stopSends) this.retryGuard(guard);
      return;
    }
    if (!guard.stuck) this.background(this.confirmGuard(guard));
  }

  retryGuard(guard) {
    if (guard.close && guard.needRead) this.background(this.checkClose(guard));
    else this.sendGuard(guard);
  }

  /**
   * A close that did not reach the server, before it is sent again: the
   * position is read (when the cover has one). Closed: done. Closer than when
   * clicked: moving, taken. More open than when clicked in two reads in a row:
   * opened elsewhere, the close is dropped (never re-closed over a hand
   * opening a read showed). Otherwise sent again, once for this read. A read
   * that fails sends nothing (the stop timer reads again).
   */
  async checkClose(guard) {
    if (guard.reading || guard.inFlight || !this.guardSendable(guard)) return;
    let closed;
    if (guard.posDpid) {
      guard.reading = true;
      try {
        const n = numberOf((await this.readGuardValues(guard)).get(guard.posDpid));
        closed = n !== undefined && n >= 0 && n <= 100 ? Math.round(n) : undefined;
      } catch {
        return;
      } finally {
        guard.reading = false;
      }
    }
    if (this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard) return;
    if (closed === 100) {
      guard.state = 'applied';
      this.dropGuard(guard);
      return;
    }
    if (guard.before !== undefined && closed !== undefined && closed > guard.before) {
      guard.state = 'done';
      this.dropGuard(guard);
      return;
    }
    if (guard.before !== undefined && closed !== undefined && closed < guard.before) {
      guard.changed += 1;
      if (guard.changed >= 2) {
        guard.state = 'changedElsewhere';
        this.logger.info(`Gira: close of ${guard.fid} dropped: opened elsewhere meanwhile`);
        this.dropGuard(guard);
      }
      return;
    }
    guard.changed = 0;
    this.sendGuard(guard);
  }

  /** While a stop is not done, it is worked on every 5 s, without end (no age limit). */
  armGuardTimer() {
    if (this.guardTimer !== undefined || this.closed) return;
    this.guardTimer = this.timers.setTimeout(() => {
      this.guardTimer = undefined;
      if (this.closed) return;
      const pending = this.ownGuards().filter((g) => !g.stuck);
      for (const guard of pending) this.workGuard(guard);
      if (pending.length > 0) this.armGuardTimer();
      this.background(this.showStatus());
    }, TIMINGS.stopRetry);
  }

  guardSummary(guard) {
    const fn = this.inventory?.functions.get(guard.fid);
    return {
      name: fn?.label || guard.fid,
      state: guard.state,
      sends: guard.answered,
      reason: guard.reason,
    };
  }

  // --- Buttons of the configuration screen ------------------------------------------

  /**
   * "Test the connection": without a pin, only shows the certificate (nothing
   * sent). Then the API check, the registration (the user name and password)
   * and the UI configuration. A success lifts a refused account (the kept
   * stops leave first).
   */
  async testConnection() {
    await this.loadMemory();
    const now = this.mono();
    if (this.lastTest && now - this.lastTest.at < TIMINGS.testSpacing) return this.lastTest.result;
    const result = await this.runTest();
    this.lastTest = { at: this.mono(), result };
    return result;
  }

  async runTest() {
    const c = this.config;
    if (c.error) return T.configError(c.error);
    // The session the test speaks for: another configuration saved meanwhile
    // gets nothing from it (token, list).
    const generation = this.generation;
    const pin = this.pin();
    try {
      if (!pin) {
        const fp = await this.readFingerprint({ host: c.host, port: c.port });
        return T.test.noPin(fp);
      }
      // A 429 pause holds every request but the stops, the Test button's too.
      if (this.paused()) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.pauseLeft() / 1000));
      }
      // Never a read sooner than the interval after the last one; while the
      // account is refused (no read runs then), Test may try at once (once
      // per 10 s, the Test spacing).
      const wait = this.lastReadMono + this.readInterval() - this.mono();
      if (wait > 0 && !this.blocked) {
        const { message } = this.statusText();
        return T.test.waiting(message, Math.ceil(wait / 1000));
      }
      this.noteAttempt();
      let token = '';
      const client = createGira({
        host: c.host,
        port: c.port,
        pin,
        token: () => token,
        secrets: () => [c.password],
        request: this.request,
      });
      const info = await client.info({ timeout: TIMINGS.readTimeout });
      if (info?.info !== 'GDS-REST-API') throw new GiraError('format', 'not a Gira IoT REST API');
      token = await this.registerClient({
        host: c.host,
        port: c.port,
        pin,
        username: c.username,
        password: c.password,
        request: this.request,
      }).catch((err) => {
        // Only a 401 of the registration refuses the user name or password.
        throw err?.kind === 'auth'
          ? new GiraError('credentials', 'user name or password refused', { status: err.status })
          : err;
      });
      const inventory = inventoryOf(await client.uiconfig({ timeout: TIMINGS.readTimeout }));
      if (!inventory.uid) throw new GiraError('format', 'not a UI configuration');
      const counts = buildModel(
        (type, id) => this.gladys.externalIds(type, id),
        inventory.functions,
      ).counts;
      const ok = T.test.ok({
        name: cleanText(info.deviceName, 40),
        type: cleanText(info.deviceType, 20),
        version: cleanText(info.deviceVersion, 20),
        counts,
      });
      if (!this.current(generation)) return ok;
      this.token = token;
      this.tokenFor = this.accountKey();
      const wasBlocked = this.blocked;
      if (wasBlocked) {
        this.clearRefusal();
        this.logger.info('Gira: user accepted again (Test button), the kept stops leave first');
      }
      if (wasBlocked || !this.online) {
        this.background(this.start(this.raw, { read: { inventory } }));
      } else {
        this.background(this.takeRead(inventory));
      }
      return ok;
    } catch (err) {
      if (err?.kind === 'rate') this.pause(err);
      if (err?.kind === 'credentials' && this.current(generation)) {
        this.refuseCredentials({
          key: this.accountKey(c),
          address: c.address,
          username: c.username,
          password: c.password,
        });
        return T.credentialsRefused;
      }
      if (err?.kind === 'pin' && this.current(generation)) this.pinError = err;
      if (!(err instanceof GiraError)) this.logger.error('Gira: test failed', err);
      return T.failure(err);
    }
  }

  /**
   * "Trust the certificate", in two clicks: the first shows the fingerprint
   * seen (nothing else is sent), the second (within 2 min, the same one seen
   * again) pins it. The first pin and a changed certificate alike.
   */
  async trustCertificate() {
    await this.loadMemory();
    const c = this.config;
    if (c.error && !c.host) return T.configError(c.error);
    const target = parseAddress(this.raw.server_address);
    if (target.error) return T.configError(target.error);
    let fp;
    try {
      fp = await this.readFingerprint({ host: target.host, port: target.port });
    } catch (err) {
      return T.failure(err);
    }
    const current = this.pin(target.key);
    if (fp === current) return T.trust.same(fp);
    if (c.fingerprint && target.key === c.address) return T.trust.typed(fp);
    const pending = this.pendingTrust;
    if (
      !pending ||
      pending.address !== target.key ||
      pending.fp !== fp ||
      this.mono() - pending.at > TIMINGS.trustWindow
    ) {
      this.pendingTrust = { address: target.key, fp, at: this.mono() };
      return T.trust.confirm(fp, current === undefined);
    }
    this.pendingTrust = undefined;
    if (this.memoryState !== 'loaded') return T.pinNotKept(fp);
    const before = this.memory.pins[target.key];
    this.memory.pins[target.key] = fp;
    try {
      await this.saveNow();
    } catch {
      if (before === undefined) delete this.memory.pins[target.key];
      else this.memory.pins[target.key] = before;
      return T.pinNotKept(fp);
    }
    this.logger.info('Gira: certificate of the server trusted (two clicks)');
    // A new certificate may be another server: its token is asked again.
    this.token = '';
    this.tokenFor = '';
    this.background(this.start(this.raw));
    return T.trust.done(fp);
  }

  /** "List the scenes": the scene functions of the last UI configuration read (no request). */
  listScenes() {
    const list = [...this.model.scenes.values()];
    if (list.length === 0) return T.scenes.none;
    const items = list.slice(0, LIMITS.scenesListed).map((s) => `${s.uid}: ${s.label || s.uid}`);
    return T.scenes.list(items, Math.max(0, list.length - items.length));
  }
}
