// -----------------------------------------------------------------------------
// /data: a missing file is empty, an unreadable one is not; bounded, repaired;
// no token nor password ever kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsMark, fileStore, newSalt, normalizeMemory } from '../src/store.js';
import { PASSWORD, USER } from './helpers/fakeGira.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const FP = 'AB:'.repeat(31) + 'AB';

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'gira-store-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('fileStore: no file is null, a file round-trips (0600), unreadable is an error', async (t) => {
  const d = await dir(t);
  const store = fileStore(join(d, 'state.json'));
  assert.equal(await store.load(), null);
  await store.save({ pins: { 'a:443': FP } });
  assert.deepEqual(await store.load(), { pins: { 'a:443': FP } });
  assert.equal((await stat(join(d, 'state.json'))).mode & 0o777, 0o600);
  await writeFile(join(d, 'state.json'), '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(join(d, 'state.json'), 'x'.repeat(70 * 1024));
  await assert.rejects(store.load(), /too large/);
});

test('fileStore: a special file (FIFO, directory) is refused without opening it', async (t) => {
  const d = await dir(t);
  await mkdir(join(d, 'dir.json'));
  await assert.rejects(fileStore(join(d, 'dir.json')).load(), /not a regular file/);
  execFileSync('mkfifo', [join(d, 'fifo.json')]);
  await assert.rejects(fileStore(join(d, 'fifo.json')).load(), /not a regular file/);
});

test('fileStore: writes go one at a time, the last one wins', async (t) => {
  const d = await dir(t);
  const store = fileStore(join(d, 'state.json'));
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ n })));
  assert.deepEqual(JSON.parse(await readFile(join(d, 'state.json'), 'utf8')), { n: 5 });
});

test('normalizeMemory: bounded, repaired; future dates not trusted; only switch-offs kept', () => {
  const guard = (extra) => ({
    address: '10.0.0.2:443',
    fid: 'a030',
    dpid: 'a031',
    key: 'OnOff',
    value: 0,
    answered: 1,
    ...extra,
  });
  const m = normalizeMemory(
    {
      pins: { '10.0.0.2:443': FP, 'bad host': FP, '10.0.0.3:443': 'nope' },
      refused: { address: '10.0.0.2:443', salt: '0011223344556677', mark: 70 },
      pausedUntil: NOW + 30 * 3600_000,
      lastReadAt: NOW + 3600_000,
      guards: [
        guard(),
        guard({ fid: 'a040', dpid: 'a042', key: 'Up-Down', value: 1 }),
        guard({ fid: 'a050', value: 1 }),
        guard({ fid: '../x' }),
        guard(),
        guard({ fid: 'a060', dpid: 'a061', answered: 'x' }),
        guard({ fid: 'a070', dpid: 'a071', answered: 99 }),
      ],
    },
    NOW,
  );
  assert.deepEqual(m.pins, { '10.0.0.2:443': FP });
  assert.equal(m.refused, null, 'a mark out of 0..63');
  assert.equal(m.pausedUntil, NOW + 6 * 3600_000);
  assert.equal(m.lastReadAt, NOW);
  assert.deepEqual(
    m.guards.map((g) => [g.fid, g.answered]),
    [
      ['a030', 1],
      ['a060', 0],
      ['a070', 4],
    ],
  );
  assert.deepEqual(normalizeMemory('junk', NOW).guards, []);
  assert.equal(normalizeMemory({ pausedUntil: NOW - 1 }, NOW).pausedUntil, null);
});

test('the refused mark: 6 bits, salted; about one other password in 64 shares it', () => {
  const salt = newSalt();
  assert.match(salt, /^[0-9a-f]{16}$/);
  const mark = credentialsMark(salt, USER, PASSWORD);
  assert.ok(mark >= 0 && mark < 64);
  assert.equal(credentialsMark(salt, USER, PASSWORD), mark);
  // Brute force over the mark alone: many candidates fit, so it never tells the password.
  let fits = 0;
  for (let i = 0; i < 6400; i += 1)
    if (credentialsMark(salt, USER, `guess${i}`) === mark) fits += 1;
  assert.ok(fits > 50 && fits < 200, `${fits} candidates fit`);
  assert.notEqual(
    credentialsMark(newSalt(), USER, PASSWORD) === mark &&
      credentialsMark(newSalt(), USER, PASSWORD) === mark &&
      credentialsMark(newSalt(), USER, PASSWORD) === mark,
    true,
  );
});
