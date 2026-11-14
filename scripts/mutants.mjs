// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const GU = 'test/guards.test.js';
const M = 'test/model.test.js';
const G = 'test/gira.test.js';
const R = 'test/review-r1.test.js';
const ALL = [C, A, GU, M, G, R];

/** [name, file, from (found exactly once), to, test files]. */
export const MUTANTS = [
  ['control option', 'src/app.js', "op.need === 'control' && !c.allowControl", 'false', [C]],
  ['open option', 'src/app.js', "op.need === 'open' && !c.allowOpen", 'false', [C]],
  ['scenes option', 'src/app.js', "op.need === 'scenes' && !c.allowScenes", 'false', [C]],
  ['stale project', 'src/app.js', "if (this.stale) throw this.refusal('configStale');", '', [A]],
  [
    'epoch before send',
    'src/app.js',
    '(this.epochs.get(op.target) ?? 0) !== epoch ||',
    'false ||',
    [C],
  ],
  [
    'scene cancelled by any stop',
    'src/app.js',
    "(op.kind === 'scene' && this.stopCount !== stops)",
    'false',
    [GU],
  ],
  [
    'read before command',
    'src/app.js',
    'if ((this.lastSent.get(fid) ?? 0) > startMark) return;',
    '',
    [C],
  ],
  [
    'guard read after answer',
    'src/app.js',
    'if (after === undefined || startMark <= after) return;',
    'if (after === undefined) return;',
    [GU],
  ],
  [
    '4 answered sends',
    'src/app.js',
    'if (guard.sends < LIMITS.stopSends) {',
    'if (guard.sends < 99) {',
    [C],
  ],
  [
    'stuck refused',
    'src/app.js',
    'if (guard.answered >= LIMITS.stopSends) guard.stuck = true;',
    '',
    [GU],
  ],
  [
    'lift only newer',
    'src/app.js',
    '(guard.sentMark === undefined || guard.sentMark < mark)',
    'true',
    [GU],
  ],
  [
    'refusal kept at start',
    'src/app.js',
    'this.blocked = this.refusalKept();',
    'this.blocked = false;',
    [A],
  ],
  [
    'one registration per read',
    'src/app.js',
    "if (err?.kind !== 'auth' || fresh) throw err;",
    "if (err?.kind !== 'auth') throw err;",
    [GU],
  ],
  [
    'values 401 not a failure',
    'src/app.js',
    "['rate', 'pin', 'nopin', 'aborted', 'locked'].includes(err?.kind)",
    "['rate', 'pin', 'nopin', 'aborted', 'locked', 'auth', 'forbidden'].includes(err?.kind)",
    [A],
  ],
  [
    'all values failing',
    'src/app.js',
    "if (queue.length > 0 && failed === queue.length && lastErr?.kind !== 'notfound') throw lastErr;",
    '',
    [A],
  ],
  [
    'tick early',
    'src/app.js',
    '    if (early > 0) {\n      this.scheduleRead(generation, early);\n      return;\n    }',
    '',
    [A],
  ],
  [
    'seed last read',
    'src/app.js',
    'this.lastReadMono = Math.max(this.lastReadMono, this.mono() - ago);',
    '',
    [C],
  ],
  [
    'channel changed',
    'src/app.js',
    'if (channel !== undefined && channel !== writer.channelType) {',
    'if (false) {',
    [C],
  ],
  [
    'persist switch-off',
    'src/app.js',
    "if (guard.kind === 'state' || previous) this.persistGuards();",
    '',
    [C],
  ],
  ['pin checked', 'src/gira.js', 'if (seen !== pin) {', 'if (false) {', [G]],
  [
    'no pin, nothing sent',
    'src/gira.js',
    '    if (!pin) {\n      reject(',
    '    if (false) {\n      reject(',
    [G],
  ],
  ['size bound', 'src/gira.js', '        if (size > maxBytes) {', '        if (false) {', [G]],
  [
    'token secret stripped',
    'src/gira.js',
    "for (const s of secrets) if (s) out = out.split(s).join('***');",
    '',
    [G, C],
  ],
  ['brightness 0 is off', 'src/model.js', 'if (Math.round(v) === 0) return off();', '', [M]],
  ['position 0 is a close', 'src/model.js', 'if (open === 0) return close();', '', [M]],
  [
    'strict command number',
    'src/model.js',
    "if (typeof value === 'string' && /^-?\\d{1,9}(\\.\\d{1,6})?$/.test(value)) return Number(value);",
    "if (typeof value === 'string' && value.trim() !== '') return Number(value);",
    [M],
  ],
  [
    'server date',
    'src/gira.js',
    'Number.isFinite(date) && Number.isFinite(now)',
    'Number.isFinite(date)',
    [G],
  ],
  [
    'port bound',
    'src/config.js',
    "  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };",
    '',
    [M],
  ],
  [
    'password without user',
    'src/config.js',
    "  if (username === '') return { error: 'no-username' };",
    '',
    [M],
  ],
  // Review r1.
  [
    'B1 replaced never writes',
    'src/app.js',
    "if (guard.replaced || this.guards.get(key) !== guard) {\n                throw new GiraError('aborted', 'replaced');",
    "if (false) {\n                throw new GiraError('aborted', 'replaced');",
    [R],
  ],
  [
    'B1 waits the written one',
    'src/app.js',
    '    if (previous) await this.bounded(previous, TIMINGS.stopTimeout).catch(() => {});',
    '',
    [R],
  ],
  [
    'B2 sent move never again',
    'src/app.js',
    "        this.giveUp(guard, 'sentNoAnswer', err.message);\n        return 'final';",
    "        guard.state = 'noAnswer';\n        return 'unsent';",
    [R],
  ],
  [
    'I1 close age',
    'src/app.js',
    "const max = guard.kind === 'move' ? TIMINGS.moveMaxAge : TIMINGS.stateMaxAge;",
    'const max = TIMINGS.stateMaxAge;',
    [R],
  ],
  [
    'I2 switch-off age',
    'src/app.js',
    "const max = guard.kind === 'move' ? TIMINGS.moveMaxAge : TIMINGS.stateMaxAge;",
    "const max = guard.kind === 'move' ? TIMINGS.moveMaxAge : Infinity;",
    [C],
  ],
  [
    'I2 window',
    'src/app.js',
    '    if (this.mono() - guard.okMono > TIMINGS.confirmWindow) return;',
    '',
    [C],
  ],
  [
    'I2 answered dropped after window',
    'src/app.js',
    '    if (guard.ok) return now - guard.okMono > TIMINGS.confirmWindow;',
    '    if (guard.ok) return false;',
    [C],
  ],
  [
    'I2 no confirm read in pause',
    'src/app.js',
    '      this.closed ||\n      this.paused() ||\n      this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard',
    '      this.closed ||\n      this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard',
    [C],
  ],
  [
    'I2 /data date',
    'src/store.js',
    '        now - g.at <= TIMINGS.stateMaxAge;',
    '        true;',
    ['test/store.test.js'],
  ],
  [
    'I2 unreadable OnOff done',
    'src/app.js',
    '    if (!this.pointReadable(guard.fid, guard.dpid)) {',
    '    if (false) {',
    [R],
  ],
  [
    'I3 registered again on a stop',
    'src/app.js',
    "          if (err?.kind === 'auth' && !registeredAgain) {",
    '          if (false) {',
    [R],
  ],
  [
    'I3 once per send',
    'src/app.js',
    "          if (err?.kind === 'auth' && !registeredAgain) {",
    "          if (err?.kind === 'auth') {",
    [R],
  ],
  [
    'I5 own registration',
    'src/app.js',
    '    if (!own && this.tokenPromise?.key === key) return this.tokenPromise.promise;',
    '    if (this.tokenPromise?.key === key) return this.tokenPromise.promise;',
    [R],
  ],
  [
    'I4 /data read again',
    'src/app.js',
    '      this.armMemoryRetry();\n    }\n    this.memoryTimes();',
    '    }\n    this.memoryTimes();',
    [R],
  ],
  [
    'I6 excluded',
    'src/app.js',
    '    if (this.config.excluded.has(fid) || this.config.excluded.has(writer?.target)) {',
    '    if (false) {',
    [R],
  ],
  [
    'I6 gate close needs option',
    'src/model.js',
    "          ? op(upDown, closeValue, { protective: false, kind: 'move', need: 'open' })",
    "          ? op(upDown, closeValue, { protective: true, kind: 'move' })",
    [R],
  ],
  [
    'I6 awning closes up',
    'src/model.js',
    "      const closeValue = sense === 'awning' ? 0 : 1;",
    '      const closeValue = 1;',
    [R],
  ],
  [
    'm1 stop slots',
    'src/app.js',
    '    if (this.stopSlotsUsed < LIMITS.stopSlots) {',
    '    if (true) {',
    [R],
  ],
  ['token= stripped', 'src/gira.js', "    .replace(/\\btoken=\\S*/gi, '***')", '', [G]],
  [
    'I8 paused refusal',
    'src/app.js',
    "    if (this.paused()) throw this.refusal('paused');",
    '',
    [R],
  ],
  [
    'I8 checkReady before byte',
    'src/app.js',
    "      if (this.mono() > deadline) throw this.refusal('tooLate');\n      this.checkReady(op);\n      // A stop arrived",
    "      if (this.mono() > deadline) throw this.refusal('tooLate');\n      // A stop arrived",
    [R],
  ],
  [
    'I8 stop in flight',
    'src/app.js',
    "    if (guard?.inFlight) throw this.refusal('stopInFlight');",
    '',
    [R],
  ],
  ['I8 trust same fp', 'src/app.js', '      pending.fp !== fp ||', '', [R]],
  ['I8 trust window', 'src/app.js', 'this.mono() - pending.at > TIMINGS.trustWindow', 'false', [R]],
  ['I8 test spacing', 'src/app.js', 'now - this.lastTest.at < TIMINGS.testSpacing', 'false', [R]],
  ['I8 fresh on created', 'src/app.js', 'this.mono() - last.at <= TIMINGS.freshness && ', '', [R]],
  [
    'I8 lift not in flight',
    'src/app.js',
    '    if (guard && !guard.inFlight && (guard.sentMark',
    '    if (guard && (guard.sentMark',
    [R],
  ],
  [
    'I8 envelope',
    'src/app.js',
    "if (info?.info !== 'GDS-REST-API') throw",
    'if (false) throw',
    [R],
  ],
  [
    'I8 unreadable not saved',
    'src/app.js',
    "    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));",
    '',
    [R],
  ],
  ['I8 close closed', 'src/app.js', '    if (open === 0) {', '    if (false) {', [R]],
  [
    'I8 close closer',
    'src/app.js',
    '    if (guard.before !== undefined && open !== undefined && open < guard.before) {',
    '    if (false) {',
    [R],
  ],
  ['I8 close twice', 'src/app.js', 'if (guard.changed >= 2) {', 'if (guard.changed >= 1) {', [R]],
  // Review r2.
  [
    'r2 awning stop up',
    'src/model.js',
    "          : op(step, sense === 'awning' ? 0 : 1, {",
    '          : op(step, 1, {',
    [R],
  ],
  [
    'r2 gate reads Movement',
    'src/app.js',
    '        if (guard.movementDpid && (attempt > 0 || guard.gate)) {',
    '        if (guard.movementDpid && attempt > 0) {',
    [R],
  ],
  [
    'r2 Movement 0 gives up',
    'src/app.js',
    '          if (moving === 0) {',
    '          if (false) {',
    [R],
  ],
  [
    'r2 stop window',
    'src/app.js',
    '        if (this.mono() - guard.created + TIMINGS.stopRetryStep > this.stopWindow(guard)) {',
    '        if (false) {',
    [R],
  ],
  [
    'r2 window by Movement',
    'src/app.js',
    '    return guard.movementDpid ? TIMINGS.stopWindowMovement : TIMINGS.stopWindow;',
    '    return TIMINGS.stopWindowMovement;',
    [R],
  ],
  [
    'r2 gate without Movement',
    'src/model.js',
    "        sense === 'gate' && !found.movement",
    'false',
    [R],
  ],
  [
    'r2 params gate never closes',
    'src/model.js',
    "    if (sense === 'gate') return undefined;",
    '',
    [R],
  ],
  [
    'r2 params gate stop',
    'src/model.js',
    "      if (sense === 'gate' && !movement) return undefined;",
    '',
    [R],
  ],
  [
    'r2 step ack trying',
    'src/app.js',
    '    if (guard.step && guard.inFlight) {',
    '    if (false) {',
    [R],
  ],
  [
    'r2 step given up on wait',
    'src/app.js',
    "        if (outcome === 'wait') {",
    '        if (false) {',
    [R],
  ],
  [
    'r2 readBack in pause',
    'src/app.js',
    '!guard.posDpid || this.paused())',
    '!guard.posDpid)',
    [R],
  ],
  [
    'r2 checkClose in pause',
    'src/app.js',
    '!this.guardSendable(guard) || this.paused()) return;',
    '!this.guardSendable(guard)) return;',
    [R],
  ],
  [
    'r2 close once per read',
    'src/app.js',
    'const quick = guard.close && guard.needRead ? [] : TIMINGS.stopQuickRetries;',
    'const quick = TIMINGS.stopQuickRetries;',
    [R],
  ],
  [
    'r2 own token only',
    'src/app.js',
    '            if (token === this.token) {',
    '            if (true) {',
    [R],
  ],
  [
    'r2 excluded kept guard',
    'src/app.js',
    '    if (c.excluded.has(guard.fid)) {',
    '    if (false) {',
    [R],
  ],
  [
    'r2 slot bounded',
    'src/app.js',
    '      }, TIMINGS.stopTimeout);\n      waiter.resolve',
    '      }, 1e9);\n      waiter.resolve',
    [R],
  ],
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
  [
    'r2 late /data keeps own pins',
    'src/app.js',
    '    late.pins = { ...late.pins, ...now.pins };',
    'while /data is unreadable, the only pin of the run is the typed one, which pin() prefers anyway',
  ],
  [
    'B2 stop never later',
    'src/app.js',
    '    if (guard.ok || guard.stuck || guard.step) return;',
    'a stop guard is always given up or dropped by its first send; none is left for the timer',
  ],
  [
    'I8 backoff under interval',
    'src/app.js',
    'return Math.max(backoff, this.readInterval());',
    'tick() puts any read before the interval off to its due time (mutant "tick early")',
  ],
  [
    'I8 restore this address',
    'src/app.js',
    '      if (g.address !== this.config.address) continue;\n      const key',
    'guardSendable() never sends a guard of another address; guardRecords() keeps it',
  ],
  [
    'blocked guard waits',
    'src/app.js',
    "      guard.state = 'refusedCredentials';\n      return false;",
    'ensureToken() refuses while blocked, before any byte, with the same state',
  ],
  [
    'declared content-length',
    'src/gira.js',
    'if (Number.isFinite(declared) && declared > maxBytes) {',
    'the streaming count cuts the same answer a few kilobytes later',
  ],
];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  {
    const dir = mkdtempSync(join(base, 'baseline-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const { code } = await run(dir, ALL, 300_000);
      if (code !== 0) {
        console.log('baseline FAILED');
        rmSync(modules, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }
      console.log('baseline ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
