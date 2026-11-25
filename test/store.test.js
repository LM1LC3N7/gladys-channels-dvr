import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_STATES, Store } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'channels-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('absent: empty and writable; attempts written and read back', async (t) => {
  const file = join(await dir(t), 'sub', 's.json');
  const store = new Store({ filePath: file });
  assert.equal(await store.load(), STORE_STATES.OK);
  assert.equal(store.attempt('server'), null);
  assert.equal(await store.recordAttempts(['server', 'player:a'], 1_700_000_000_000), true);
  const again = new Store({ filePath: file });
  await again.load();
  assert.equal(again.attempt('player:a'), 1_700_000_000_000);
  assert.match(await readFile(file, 'utf8'), /"attempts"/);
});

test('not JSON: times unknown, replaced at the next write; odd entries dropped', async (t) => {
  const file = join(await dir(t), 's.json');
  await writeFile(file, '{"attempts":');
  const store = new Store({ filePath: file });
  assert.equal(await store.load(), STORE_STATES.CORRUPT);
  assert.equal(store.readable, true);
  await store.recordAttempts(['server'], 5_000_000_000);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    attempts: { server: 5_000_000_000 },
  });
  await writeFile(
    file,
    JSON.stringify({
      attempts: { server: 'x', 'player:a': -1, 'Bad Key': 1, ok: 2, __proto__: 3 },
    }),
  );
  const odd = new Store({ filePath: file });
  await odd.load();
  assert.deepEqual(odd.attempts, { ok: 2 });
});

test('unreadable: not empty, never written over, read again later', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads everything');
  const file = join(await dir(t), 's.json');
  await writeFile(file, JSON.stringify({ attempts: { server: 1 } }));
  await chmod(file, 0o000);
  const store = new Store({ filePath: file });
  assert.equal(await store.load(), STORE_STATES.UNREADABLE);
  assert.equal(store.readable, false);
  assert.equal(await store.recordAttempts(['server'], 9), false);
  await chmod(file, 0o600);
  assert.equal(await store.load(), STORE_STATES.OK);
  assert.equal(store.attempt('server'), 9, 'the later of the file and the memory');
});

test('a read that hangs: bounded, one read at a time', async () => {
  let reads = 0;
  const fs = { readFile: () => ((reads += 1), new Promise(() => {})) };
  const store = new Store({ filePath: '/nowhere', readTimeoutMs: 20, fs });
  assert.equal(await store.load(), STORE_STATES.UNREADABLE);
  assert.equal(await store.load(), STORE_STATES.UNREADABLE);
  assert.equal(reads, 1, 'the hung read keeps the slot');
});

test('a failed write keeps the times in memory', async (t) => {
  const fs = {
    readFile: async () => '{}',
    writeFile: async () => {
      throw Object.assign(new Error('nope'), { code: 'EROFS' });
    },
  };
  const logs = [];
  const store = new Store({
    filePath: join(await dir(t), 's.json'),
    fs,
    logger: { warn: (m) => logs.push(m) },
  });
  await store.load();
  assert.equal(await store.recordAttempts(['server'], 7), false);
  assert.equal(store.attempt('server'), 7);
  assert.match(logs.join(), /EROFS/);
});
