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
const ALL = [C, A, GU, M, G];

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
    'if (guard.answered < LIMITS.stopSends) {',
    'if (guard.answered < 99) {',
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
    "if (guard.kind === 'state') this.persistGuards();",
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
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
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
