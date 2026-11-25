// -----------------------------------------------------------------------------
// The real clock, sped up 100 times, against real loopback HTTP servers (a
// Channels DVR Server and a Channels app): the period of the rounds is
// measured (never faster than the interval, never a cycle late), and a stop
// leaves nothing behind.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ChannelsApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { realClock } from './helpers/clock.js';

const SPEED = 100;

async function serve(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(performance.now());
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return { port: server.address().port, hits };
}

const json = (res, value) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

test('rounds every 15 s (real clock x100), measured; a stop leaves no timer nor request', async (t) => {
  const dvr = await serve(t, (req, res) => {
    if (req.url === '/api/v1/jobs') json(res, []);
    else json(res, { disk: { free: 1e9, total: 2e9, used: 1e9 } });
  });
  const app = await serve(t, (req, res) => json(res, { status: 'stopped', muted: false }));
  const clock = realClock({ speed: SPEED });
  t.after(() => clock.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'channels-real-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const gladys = createFakeGladys({
    selector: 'channels-dvr',
    config: {
      server_url: `127.0.0.1:${dvr.port}`,
      players: `127.0.0.1:${app.port}`,
      poll_interval: '15',
    },
  });
  const channels = new ChannelsApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    dataDir,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(() => channels.stop());
  // The decision, not the requests (their latency blurs the period): each
  // round records its attempts first.
  const rounds = [];
  const record = channels.store.recordAttempts.bind(channels.store);
  channels.store.recordAttempts = (keys, at) => {
    rounds.push(clock.monotonic());
    return record(keys, at);
  };
  registerHandlers(gladys, channels, null);
  await gladys.connect();
  // 6 rounds: 15 s x 6 = 90 simulated s = 0.9 real s; bounded wait.
  const deadline = performance.now() + 20_000;
  while (app.hits.length < 6 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await channels.stop();
  assert.ok(app.hits.length >= 6, `${app.hits.length} readings`);
  const gaps = rounds.slice(1).map((at, i) => at - rounds[i]);
  assert.ok(gaps.length >= 5, `${gaps.length} gaps`);
  for (const gap of gaps) {
    assert.ok(gap >= 15_000 - 100, `gap ${Math.round(gap)} ms: faster than the interval`);
    assert.ok(gap <= 15_000 * 2, `gap ${Math.round(gap)} ms: a cycle late`);
  }
  const count = app.hits.length + dvr.hits.length;
  await new Promise((resolve) => setTimeout(resolve, 400)); // 40 simulated s
  assert.equal(app.hits.length + dvr.hits.length, count, 'nothing after stop');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
