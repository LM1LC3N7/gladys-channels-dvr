// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a fake Channels network and
// a fake clock, through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ChannelsApp } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { ACTIONS, NOTHING, STORE_FILE, TIMINGS } from '../src/constants.js';
import { buildPlayerDevice, buildServerDevice } from '../src/model.js';
import { registerHandlers } from '../src/handlers.js';
import { fakeClock } from './helpers/clock.js';
import { NOW, createFakeChannels, job, playing } from './helpers/fakeChannels.js';

const SELECTOR = 'channels-dvr';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE = { server_url: '192.168.1.3', players: 'Living room=192.168.1.20, 192.168.1.21' };
const cfg = normalizeConfig(BASE);
const SERVER = buildServerDevice(ids, cfg.server);
const LIVING = buildPlayerDevice(ids, cfg.players[0]);
const BEDROOM = buildPlayerDevice(ids, cfg.players[1]);
const fid = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

/** test -> the apps it started and the directories it made */
const APPS = new WeakMap();

function makeLogger() {
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map(String).join(' ')}`),
    ]),
  );
  return { logs, logger };
}

async function setup(
  t,
  {
    config = {},
    created = [SERVER, LIVING, BEDROOM],
    dataDir,
    channels,
    clock,
    fs,
    getConfigFails = 0,
  } = {},
) {
  clock ??= fakeClock({ wall: NOW });
  channels ??= createFakeChannels({ clock });
  if (!channels.devices.has('192.168.1.20:57000')) channels.addPlayer('192.168.1.20');
  if (!channels.devices.has('192.168.1.21:57000'))
    channels.addPlayer('192.168.1.21', 57000, { status: 'stopped', muted: false });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE, ...config },
    devices: created,
  });
  if (getConfigFails > 0) {
    const original = gladys.getConfig.bind(gladys);
    // The first call is the SDK's own (before 'connected'); the next ones are ours.
    let calls = 0;
    gladys.getConfig = async () => {
      calls += 1;
      if (calls > 1 && calls <= 1 + getConfigFails) throw new Error('Gladys starting');
      return original();
    };
  }
  const { logs, logger } = makeLogger();
  let ownDir = false;
  if (!dataDir) {
    dataDir = mkdtempSync(join(tmpdir(), 'channels-app-'));
    ownDir = true;
  }
  const app = new ChannelsApp({
    gladys,
    logger,
    request: channels.request,
    dataDir,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    fs,
  });
  // Every app of the test stopped (its last /data write done) before a
  // directory is removed: a late write never recreates it.
  if (!APPS.has(t)) {
    APPS.set(t, { apps: [], dirs: [] });
    t.after(async () => {
      const { apps, dirs } = APPS.get(t);
      for (const one of apps) await one.stop();
      for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
  }
  APPS.get(t).apps.push(app);
  if (ownDir) APPS.get(t).dirs.push(dataDir);
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await clock.advance(0);
  return { gladys, channels, clock, logs, app, dataDir };
}

const last = (gladys, device, key) => gladys.fake.lastState(fid(device, key).external_id);
const statusText = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';
const reads = (channels, host) =>
  channels.count(new RegExp(`^GET ${host.replace(/\./g, '\\.')}:\\d+/api/(status|v1/jobs)$`));
const set = (gladys, device, key, value) => gladys.fake.setValue(device, fid(device, key), value);

test('start: Discovery of the server and the players; first round publishes the created devices', async (t) => {
  const { gladys, channels } = await setup(t);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:server:dvr`, 'Channels DVR'],
      [`ext:${SELECTOR}:player:192-168-1-20`, 'Living room'],
      [`ext:${SELECTOR}:player:192-168-1-21`, 'Channels 192.168.1.21'],
    ],
  );
  assert.equal(last(gladys, SERVER, 'recording'), 1);
  assert.equal(last(gladys, SERVER, 'upcoming'), 1, 'the skipped job is not counted');
  assert.equal(last(gladys, SERVER, 'recording_title'), 'NBC Nightly News');
  assert.equal(last(gladys, SERVER, 'next_title'), 'Family Feud');
  assert.equal(last(gladys, SERVER, 'disk_free'), 110.48);
  assert.equal(last(gladys, SERVER, 'disk_used'), 389.49);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1);
  assert.equal(last(gladys, LIVING, 'title'), 'Seinfeld — The Truth');
  assert.equal(last(gladys, LIVING, 'channel'), 552);
  assert.equal(last(gladys, LIVING, 'channel_name'), 'TBS HD');
  assert.equal(last(gladys, LIVING, 'mute'), 0);
  assert.equal(last(gladys, LIVING, 'online'), 1);
  assert.equal(last(gladys, BEDROOM, 'playback_state'), 2);
  assert.equal(last(gladys, BEDROOM, 'title'), '');
  assert.equal(last(gladys, BEDROOM, 'channel_name'), NOTHING);
  assert.equal(last(gladys, BEDROOM, 'channel'), undefined, 'no channel when stopped: unknown');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(gladys), /Server: 1 recording, 1 upcoming\. Players answering: 2 of 2\./);
  assert.deepEqual(
    gladys.fake.transports.map((e) => [e.device_external_id, e.transport]),
    [
      [SERVER.external_id, 'local'],
      [LIVING.external_id, 'local'],
      [BEDROOM.external_id, 'local'],
    ],
  );
  assert.equal(channels.count(/^POST/), 0, 'a reading never sends a command');
});

test('devices not created: read, nothing published for them', async (t) => {
  const { gladys } = await setup(t, { created: [LIVING] });
  assert.equal(last(gladys, SERVER, 'recording'), undefined);
  assert.equal(last(gladys, BEDROOM, 'playback_state'), undefined);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1);
  assert.deepEqual(
    gladys.fake.transports.map((e) => e.device_external_id),
    [LIVING.external_id],
  );
});

test('rounds every interval, measured from the start of a round', async (t) => {
  const { clock, channels } = await setup(t, { config: { poll_interval: '60' } });
  assert.equal(reads(channels, '192.168.1.20'), 1);
  await clock.advance(59_000);
  assert.equal(reads(channels, '192.168.1.20'), 1, 'never sooner than the interval');
  await clock.advance(1_000);
  assert.equal(reads(channels, '192.168.1.20'), 2);
  await clock.advance(60_000 * 5);
  assert.equal(reads(channels, '192.168.1.20'), 7);
  assert.equal(reads(channels, '192.168.1.3'), 7);
  // The disk: every 5 minutes, not every round.
  assert.equal(channels.count(/^GET 192\.168\.1\.3:8089\/dvr$/), 2);
});

test('a restart never reads sooner than the interval (attempt in /data before the reading)', async (t) => {
  const first = await setup(t);
  const stored = JSON.parse(readFileSync(join(first.dataDir, STORE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(stored.attempts).sort(), [
    'player:192-168-1-20',
    'player:192-168-1-21',
    'server',
  ]);
  assert.equal(stored.attempts.server, NOW);
  await first.app.stop();
  // 10 s later, a new container on the same /data.
  const clock = fakeClock({ wall: NOW + 10_000 });
  const second = await setup(t, { dataDir: first.dataDir, clock });
  assert.equal(second.channels.requests.length, 0, 'nothing read at start');
  await clock.advance(19_000);
  assert.equal(second.channels.requests.length, 0);
  await clock.advance(1_000);
  assert.equal(reads(second.channels, '192.168.1.3'), 1, '30 s after the last attempt');
});

test('restart: a new player is read at once; a date in the future is invalid', async (t) => {
  const first = await setup(t);
  await first.app.stop();
  const file = join(first.dataDir, STORE_FILE);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.attempts['player:192-168-1-21'] = NOW + 3_600_000; // clock set back since
  writeFileSync(file, JSON.stringify(stored));
  const clock = fakeClock({ wall: NOW + 5_000 });
  const channels = createFakeChannels({ clock });
  channels.addPlayer('192.168.1.22');
  const second = await setup(t, {
    dataDir: first.dataDir,
    clock,
    channels,
    config: { players: 'Living room=192.168.1.20, 192.168.1.21, 192.168.1.22' },
  });
  assert.equal(reads(second.channels, '192.168.1.22'), 1, 'new: read now');
  assert.equal(reads(second.channels, '192.168.1.21'), 1, 'future date: read now');
  assert.equal(reads(second.channels, '192.168.1.20'), 0, 'read 5 s ago: waits');
});

test('/data unreadable: one interval before the first reading, read again every 10 s, never written over', async (t) => {
  let unreadable = true;
  let readsOfData = 0;
  const writes = [];
  const fs = {
    readFile: async () => {
      readsOfData += 1;
      if (unreadable) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return JSON.stringify({ attempts: {} });
    },
    writeFile: async (path, data) => writes.push(data),
    rename: async () => {},
    rm: async () => {},
    mkdir: async () => {},
  };
  const { clock, channels, gladys } = await setup(t, { fs });
  assert.equal(channels.requests.length, 0);
  assert.match(statusText(gladys), /\/data cannot be read/);
  await clock.advance(10_000);
  assert.equal(readsOfData, 2);
  assert.equal(writes.length, 0, 'not written over while unreadable');
  await clock.advance(19_999);
  assert.equal(channels.requests.length, 0);
  await clock.advance(1);
  assert.ok(reads(channels, '192.168.1.3') === 1);
  assert.equal(writes.length, 0);
  unreadable = false;
  await clock.advance(10_000);
  await clock.advance(20_000);
  assert.equal(writes.length, 1, 'written once readable');
  assert.doesNotMatch(statusText(gladys), /\/data/);
});

test('/data read that hangs: bounded, the rounds go on', async (t) => {
  const fs = {
    readFile: () => new Promise(() => {}),
    writeFile: async () => {},
    rename: async () => {},
    rm: async () => {},
    mkdir: async () => {},
  };
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  const promise = setup(t, { fs, clock, channels });
  await clock.settle();
  await clock.advance(TIMINGS.DATA_READ_MS);
  const { gladys } = await promise;
  assert.match(statusText(gladys), /\/data cannot be read/);
  await clock.advance(30_000);
  assert.equal(reads(channels, '192.168.1.3'), 1);
});

test('server: no Date header -> counts unknown (never our clock); a failing disk never blocks the jobs', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  channels.server.date = () => null;
  channels.server.fail.dvr = 500;
  const { gladys } = await setup(t, { clock, channels });
  assert.equal(last(gladys, SERVER, 'recording'), undefined);
  assert.match(statusText(gladys), /Server not read \(unexpected answer\)/);
  channels.server.date = () => new Date(clock.now()).toUTCString();
  await clock.advance(30_000);
  assert.equal(last(gladys, SERVER, 'recording'), 1);
  assert.equal(last(gladys, SERVER, 'disk_free'), undefined, 'disk unknown, nothing published');
});

test('server: the time of the server decides, not ours', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  // The server's clock is 1 h ahead: Family Feud records, the news is over.
  channels.server.date = () => new Date(NOW + 3_700_000).toUTCString();
  const { gladys } = await setup(t, { clock, channels });
  assert.equal(last(gladys, SERVER, 'recording'), 1);
  assert.equal(last(gladys, SERVER, 'recording_title'), 'Family Feud');
  assert.equal(last(gladys, SERVER, 'upcoming'), 0);
  assert.equal(last(gladys, SERVER, 'next_title'), NOTHING);
});

test('server down, players fine: still connected; everything down: not connected', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  channels.server.fail.jobs = 'refused';
  const { gladys } = await setup(t, { clock, channels });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(gladys), /Server not read \(connection refused\)/);
  assert.equal(
    gladys.fake.transports.find((e) => e.device_external_id === SERVER.external_id).transport,
    'unreachable',
  );
  channels.devices.get('192.168.1.20:57000').state.mode = 'timeout';
  channels.devices.get('192.168.1.21:57000').state.mode = 503;
  await clock.advance(30_000);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(statusText(gladys), /Players answering: 0 of 2/);
});

test('player: app closed (refused) = nothing plays; no answer = only "not answering"', async (t) => {
  const { gladys, clock, channels } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.mode = 'refused';
  await clock.advance(30_000);
  assert.equal(last(gladys, LIVING, 'online'), 0);
  assert.equal(last(gladys, LIVING, 'playback_state'), 2);
  assert.equal(last(gladys, LIVING, 'title'), '');
  assert.equal(gladys.fake.connectionStatus.connected, true, 'an app closed is normal');
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.mode = 'ok';
  await clock.advance(30_000);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1);
  living.mode = 'timeout';
  await clock.advance(30_000);
  assert.equal(last(gladys, LIVING, 'online'), 0);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1, 'unknown: the last value stays');
  living.mode = 'garbage';
  await clock.advance(30_000);
  assert.equal(last(gladys, LIVING, 'online'), 0, 'alive only on a status of Channels');
});

test('command: pause, confirmed by the answer; already paused: nothing sent', async (t) => {
  const { gladys, channels } = await setup(t);
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, true);
  assert.equal(channels.count(/^POST 192\.168\.1\.20:57000\/api\/pause$/), 1);
  assert.equal(last(gladys, LIVING, 'playback_state'), 0);
  const again = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(again.success, true);
  assert.equal(channels.count(/^POST/), 1, 'already paused: nothing sent');
  await set(gladys, LIVING, 'playback_state', 1);
  assert.equal(channels.count(/^POST 192\.168\.1\.20:57000\/api\/resume$/), 1);
  await set(gladys, LIVING, 'playback_state', 2);
  assert.equal(channels.count(/^POST 192\.168\.1\.20:57000\/api\/stop$/), 1);
  assert.equal(last(gladys, LIVING, 'playback_state'), 2);
  assert.equal(last(gladys, LIVING, 'title'), '');
});

test('command: the status read just before decides (not the round)', async (t) => {
  const { gladys, channels } = await setup(t);
  // Paused on the remote since the last round.
  channels.devices.get('192.168.1.20:57000').state.state.status = 'paused';
  await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(channels.count(/^POST/), 0);
  const ack = await set(gladys, BEDROOM, 'playback_state', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing is playing.*nothing sent/);
  assert.equal(channels.count(/^POST/), 0);
});

test('command: refused or unreachable app -> nothing sent; invalid value -> no request', async (t) => {
  const { gladys, channels } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.mode = 'refused';
  let ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /app is not running: nothing sent/);
  living.mode = 'timeout';
  ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /no answer \(no answer in time\): nothing sent/);
  living.mode = 'ok';
  const before = channels.requests.length;
  for (const [key, value] of [
    ['playback_state', 3],
    ['playback_state', 0.5],
    ['mute', 2],
    ['channel', 0],
    ['channel', 100000],
    ['channel', 12.1234],
    ['channel', 'abc'],
  ]) {
    ack = await set(gladys, LIVING, key, value);
    assert.equal(ack.success, false, `${key} ${value}`);
    assert.match(ack.error, /nothing sent/);
  }
  assert.equal(channels.requests.length, before, 'an invalid value costs no request');
});

test('command: read-only features and the server refuse; a player no longer configured too', async (t) => {
  const { gladys, channels } = await setup(t);
  let ack = await set(gladys, SERVER, 'recording', 1);
  assert.match(ack.error, /read only/);
  ack = await set(gladys, LIVING, 'title', 1);
  assert.match(ack.error, /read only/);
  ack = await set(gladys, LIVING, 'online', 1);
  assert.match(ack.error, /read only/);
  await gladys.fake.configUpdated({ ...BASE, players: '192.168.1.21' });
  ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /no longer in the configuration/);
  assert.equal(channels.count(/^POST/), 0);
});

test('command: applied just after its answer -> seen by the reading within the budget: success', async (t) => {
  const { gladys, channels } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.late = true;
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, true);
  assert.equal(last(gladys, LIVING, 'playback_state'), 0);
  assert.equal(
    channels.count(/^GET 192\.168\.1\.20:57000\/api\/status$/),
    3,
    'round, before, after',
  );
});

test('command: accepted but never shown applied -> error "sent, without confirmation", follow-ups, warning', async (t) => {
  const { gladys, channels, clock, logs } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.ignore = true;
  const ack = await set(gladys, LIVING, 'channel', 7);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Living room: sent, without confirmation \(not seen applied yet\)/);
  assert.doesNotMatch(ack.error, /nothing sent/);
  assert.equal(channels.count(/play\/channel\/7$/), 1);
  await clock.advance(5_000);
  assert.ok(logs.some((l) => /warn Living room: the command is not seen applied/.test(l)));
  assert.equal(last(gladys, LIVING, 'channel'), 552);
});

test('command: sent without answer -> "sent, without confirmation", follow-ups publish', async (t) => {
  const { gladys, channels, clock } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.commandMode = 'lost';
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Living room: sent, without confirmation/);
  assert.doesNotMatch(ack.error, /nothing sent/);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1);
  await clock.advance(1_500);
  assert.equal(last(gladys, LIVING, 'playback_state'), 0, 'the follow-up reading shows it');
});

test('command: a slow answer past the deadline -> "sent, without confirmation" (never "nothing sent")', async (t) => {
  const { gladys, channels } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.commandLatencyMs = 3_800;
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Living room: sent, without confirmation \(no answer in time\)/);
});

test('command: HTTP 4xx = refused by the app; 5xx = sent, without confirmation', async (t) => {
  const { gladys, channels } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.commandMode = 405;
  let ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /the app refused the command \(HTTP 405\)/);
  living.commandMode = 500;
  ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /answered HTTP 500, sent, without confirmation/);
});

test('command: an answer that is not a status -> the reading within the budget decides', async (t) => {
  const { gladys, channels } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.commandEmpty = true;
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, true);
  assert.equal(last(gladys, LIVING, 'playback_state'), 0);
});

test('command: a slow app does not turn "App answering" to 0 through the short reading before', async (t) => {
  const { gladys, channels } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.slowMs = 2_000; // the 4 s reading sees it
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.match(ack.error, /no answer \(no answer in time\): nothing sent/);
  assert.equal(last(gladys, LIVING, 'online'), 1);
  assert.equal(channels.count(/^POST/), 0);
});

test('mute: already in the wanted state -> no toggle', async (t) => {
  const { gladys, channels } = await setup(t);
  const ack = await set(gladys, LIVING, 'mute', 0);
  assert.equal(ack.success, true);
  assert.equal(channels.count(/toggle_mute/), 0);
});

test('mute: a toggle not seen applied blocks the next one until it is seen', async (t) => {
  const { gladys, channels, clock } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.ignore = true;
  let ack = await set(gladys, LIVING, 'mute', 1);
  assert.match(ack.error, /sent, without confirmation/);
  assert.equal(channels.count(/toggle_mute/), 1);
  ack = await set(gladys, LIVING, 'mute', 1);
  assert.match(
    ack.error,
    /previous mute change is not seen applied yet \(retry in a few seconds\): nothing sent/,
  );
  assert.equal(channels.count(/toggle_mute/), 1);
  living.ignore = false;
  living.state.muted = true; // applied late
  await clock.advance(1_500); // the follow-up reading sees it: guard lifted
  ack = await set(gladys, LIVING, 'mute', 0);
  assert.equal(ack.success, true);
  assert.equal(channels.count(/toggle_mute/), 2);
  assert.equal(last(gladys, LIVING, 'mute'), 0);
});

test('mute: the guard ends with its time (6 s) even unseen; a 4xx lifts it at once', async (t) => {
  const { gladys, channels, clock } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.ignore = true;
  await set(gladys, LIVING, 'mute', 1);
  await clock.advance(TIMINGS.TOGGLE_GUARD_MS);
  await set(gladys, LIVING, 'mute', 1);
  assert.equal(channels.count(/toggle_mute/), 2, 'sent again after 6 s');
  await clock.advance(TIMINGS.TOGGLE_GUARD_MS);
  living.ignore = false;
  living.commandMode = 405;
  const refused = await set(gladys, LIVING, 'mute', 1);
  assert.match(refused.error, /refused the command \(HTTP 405\)/);
  living.commandMode = 'ok';
  const ack = await set(gladys, LIVING, 'mute', 1);
  assert.equal(ack.success, true, 'a refused toggle applied nothing: no guard');
  assert.equal(channels.count(/toggle_mute/), 4);
});

test('channel "12.10": kept as text, never published as 12.1; tuning 12.1 is sent', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  channels.addPlayer('192.168.1.20', 57000, playing('12.10', 'KCET HD'));
  const { gladys } = await setup(t, { clock, channels });
  assert.equal(last(gladys, LIVING, 'channel'), undefined);
  assert.equal(last(gladys, LIVING, 'channel_name'), 'KCET HD');
  const ack = await set(gladys, LIVING, 'channel', 12.1);
  assert.equal(ack.success, true);
  assert.equal(channels.count(/play\/channel\/12\.1$/), 1);
  assert.equal(last(gladys, LIVING, 'channel'), 12.1);
});

test('channel: tuned (subchannel "12.1" too); up and down; same channel: nothing sent', async (t) => {
  const { gladys, channels } = await setup(t);
  await set(gladys, LIVING, 'channel', 552);
  assert.equal(channels.count(/^POST/), 0, 'already on 552');
  await set(gladys, LIVING, 'channel', 12.1);
  assert.equal(channels.count(/^POST 192\.168\.1\.20:57000\/api\/play\/channel\/12\.1$/), 1);
  assert.equal(last(gladys, LIVING, 'channel'), 12.1);
  await set(gladys, LIVING, 'channel', 512);
  await set(gladys, LIVING, 'channel_up', 1);
  assert.equal(last(gladys, LIVING, 'channel'), 513);
  await set(gladys, LIVING, 'channel_down', 1);
  assert.equal(last(gladys, LIVING, 'channel'), 512);
  const ack = await set(gladys, BEDROOM, 'channel_up', 1);
  assert.match(ack.error, /no channel is being watched: nothing sent/);
  // A stopped app tunes a channel.
  const tune = await set(gladys, BEDROOM, 'channel', 7);
  assert.equal(tune.success, true);
  assert.equal(last(gladys, BEDROOM, 'playback_state'), 1);
});

test('commands are serialized per player; a queued command past the budget is dropped, never sent late', async (t) => {
  const { gladys, channels } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.latencyMs = 1_300; // real time: each request 1.3 s
  const [a, b] = await Promise.all([
    set(gladys, LIVING, 'playback_state', 0),
    set(gladys, LIVING, 'channel', 7),
  ]);
  assert.equal(a.success, true);
  assert.equal(b.success, false);
  assert.match(b.error, /no time left|no answer in time/);
  living.latencyMs = 0;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(channels.count(/play\/channel/), 0, 'never sent late');
});

test('Gladys stops waiting during the reading before: "nothing sent", and nothing is', async (t) => {
  const { gladys, channels } = await setup(t);
  const living = channels.devices.get('192.168.1.20:57000').state;
  living.latencyMs = 3_800; // real time: past the 3.6 s deadline
  const ack = await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Living room: no answer in time: nothing sent/);
  living.latencyMs = 0;
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(channels.count(/^POST/), 0);
});

test('a scene on 5 slow players (500-900 ms each) sets them all', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  const hosts = [20, 21, 22, 23, 24].map((n) => `192.168.1.${n}`);
  hosts.forEach((host, i) => {
    const p = channels.addPlayer(host);
    p.latencyMs = 500 + i * 100;
  });
  const config = { players: hosts.join(', ') };
  const devices = normalizeConfig({ ...BASE, ...config }).players.map((p) =>
    buildPlayerDevice(ids, p),
  );
  const { gladys } = await setup(t, { clock, channels, config, created: devices });
  const acks = await Promise.all(devices.map((d) => set(gladys, d, 'playback_state', 0)));
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, true, true, true],
  );
  assert.equal(channels.count(/^POST .*\/api\/pause$/), 5);
});

test('deviceCreated: states from a fresh reading only (never stale)', async (t) => {
  const { gladys, clock } = await setup(t, { created: [] });
  await clock.advance(10_000);
  await gladys.fake.deviceCreated(LIVING);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1, 'read 10 s ago: published');
  await clock.advance(25_000); // the next round was at 30 s: 5 s old
  await clock.advance(29_000); // 29 s old now, still fresh
  await clock.advance(1_000); // round at 60 s
  await clock.advance(29_999);
  await gladys.fake.deviceCreated(BEDROOM);
  assert.equal(last(gladys, BEDROOM, 'playback_state'), 2);
  const stale = await setup(t, { created: [] });
  stale.app.config.pollMs = 30_000;
  stale.app.readings.get('player:192-168-1-20').at -= 30_000;
  await stale.gladys.fake.deviceCreated(LIVING);
  assert.equal(last(stale.gladys, LIVING, 'playback_state'), undefined, 'too old: the next round');
});

test('getConfig failing in "connected": tried again every 30 s, then starts', async (t) => {
  const { gladys, clock, channels, logs } = await setup(t, { getConfigFails: 2 });
  assert.equal(channels.requests.length, 0);
  assert.ok(logs.some((l) => /Start failed/.test(l)));
  await clock.advance(30_000);
  assert.equal(channels.requests.length, 0);
  await clock.advance(30_000);
  assert.equal(reads(channels, '192.168.1.3'), 1, logs.join('\n'));
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('reconnection: everything published again, nothing stale', async (t) => {
  const { gladys, clock, channels } = await setup(t);
  await gladys.disconnect();
  await clock.settle();
  assert.equal(clock.pending.size, 0, 'no timer while away');
  const count = gladys.fake.states.length;
  await gladys.connect();
  await clock.settle();
  assert.equal(
    gladys.fake.states.length,
    count,
    'read 0 s ago: waits, nothing republished from memory',
  );
  await clock.advance(30_000);
  assert.ok(gladys.fake.states.length > count, 'the next reading publishes everything again');
  assert.equal(reads(channels, '192.168.1.3'), 2);
});

test('a restart during a slow round: the new configuration is read, the old round dropped', async (t) => {
  const { gladys, clock, channels } = await setup(t);
  let release;
  channels.server.hold = new Promise((resolve) => (release = resolve));
  await clock.advance(30_000); // a round starts, the server hangs
  const count = reads(channels, '192.168.1.3');
  channels.addPlayer('192.168.1.30');
  await gladys.fake.configUpdated({ ...BASE, players: '192.168.1.30' });
  await clock.advance(0);
  assert.equal(reads(channels, '192.168.1.30'), 1, 'the new player is read at once');
  channels.server.hold = null;
  release();
  await clock.advance(30_000);
  assert.equal(reads(channels, '192.168.1.3'), count + 1, 'the next round of the new run');
  assert.equal(reads(channels, '192.168.1.30'), 2);
});

test('a reading older than the one kept is not published (a round crossing a command)', async (t) => {
  const { app } = await setup(t);
  const player = app.config.players[0];
  const fresh = { online: true, status: { playback: 0, muted: false, channel: null, title: 'x' } };
  assert.equal(app.record(player, fresh, app.monotonic()), true);
  const old = { online: true, status: { playback: 1, muted: false, channel: null, title: 'y' } };
  assert.equal(app.record(player, old, app.monotonic() - 10_000), false);
  assert.equal(app.readings.get('player:192-168-1-20').reading, fresh);
});

test('a /data write that hangs never stops the rounds', async (t) => {
  const fs = {
    readFile: async () => JSON.stringify({ attempts: {} }),
    writeFile: () => new Promise(() => {}),
    rename: async () => {},
    rm: async () => {},
    mkdir: async () => {},
  };
  const { clock, channels } = await setup(t, { fs });
  await clock.advance(TIMINGS.DATA_READ_MS);
  assert.equal(reads(channels, '192.168.1.3'), 1, 'read after the bounded wait');
  await clock.advance(30_000);
  await clock.advance(30_000);
  assert.equal(reads(channels, '192.168.1.3'), 3);
});

test('an answer of an older run is never published', async (t) => {
  const { gladys, clock, channels } = await setup(t, { created: [LIVING] });
  const living = channels.devices.get('192.168.1.20:57000').state;
  let release;
  living.hold = new Promise((resolve) => (release = resolve));
  await clock.advance(30_000); // the round waits for the app
  const before = gladys.fake.states.length;
  await gladys.fake.configUpdated({ ...BASE, players: '192.168.1.21' });
  living.state.status = 'paused';
  living.hold = null;
  release();
  await clock.advance(0);
  const published = gladys.fake.states.slice(before).map((st) => st.device_feature_external_id);
  assert.ok(!published.some((id) => id.startsWith(LIVING.external_id)), published.join());
});

test('status: players refusing the connection are said (app closed, or a wrong address or port)', async (t) => {
  const { gladys, clock, channels } = await setup(t);
  for (const host of ['192.168.1.20', '192.168.1.21']) {
    channels.devices.get(`${host}:57000`).state.mode = 'refused';
  }
  await clock.advance(30_000);
  assert.match(
    statusText(gladys),
    /Players answering: 0 of 2\. 2 refuse the connection \(app closed, or a wrong address or port\)\./,
  );
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the server answers');
});

test('stop: no timer, no request afterwards', async (t) => {
  const { app, clock, channels, gladys } = await setup(t);
  channels.devices.get('192.168.1.20:57000').state.late = true;
  await set(gladys, LIVING, 'playback_state', 0);
  await app.stop();
  const count = channels.requests.length;
  assert.equal(clock.pending.size, 0);
  await clock.advance(120_000);
  assert.equal(channels.requests.length, count);
});

test('the test button: the last readings, never a reading out of turn', async (t) => {
  const { gladys, channels, clock } = await setup(t);
  await clock.advance(5_000);
  const before = channels.requests.length;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(channels.requests.length, before);
  assert.match(ack.data.message.en, /Server: 1 recording, 1 upcoming, 110\.5 GB free\./);
  assert.match(ack.data.message.en, /Living room: playback playing\./);
  assert.match(ack.data.message.en, /Channels 192\.168\.1\.21: playback stopped\./);
  assert.match(ack.data.message.fr, /110,5 Go libres/);
});

test('configuration problems are said; no target: not connected', async (t) => {
  let s = await setup(t, {
    config: { server_url: 'https://dvr.local', players: 'bad host, 224.0.0.1' },
  });
  assert.match(statusText(s.gladys), /https is not supported/);
  assert.match(statusText(s.gladys), /2 player entries ignored/);
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  s = await setup(t, { config: { server_url: '', players: '' } });
  assert.match(statusText(s.gladys), /Nothing to read/);
  const ack = await s.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
});

test('the rate limit of Gladys is never passed (states held back, then published)', async (t) => {
  const { app, gladys, clock, logs } = await setup(t);
  app.published.push([clock.monotonic(), 250]);
  await set(gladys, LIVING, 'playback_state', 0);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1, 'held back');
  assert.ok(logs.some((l) => /States held back/.test(l)));
  await clock.advance(30_000);
  assert.equal(last(gladys, LIVING, 'playback_state'), 1, 'still within the minute');
  await clock.advance(60_000);
  assert.equal(last(gladys, LIVING, 'playback_state'), 0, 'published by a later reading');
});

test('Discovery keeps the features of a created device unknown to this version', async (t) => {
  const extra = structuredClone(LIVING);
  extra.features.push({
    ...fid(LIVING, 'title'),
    external_id: `${LIVING.external_id}:future`,
    name: 'Future',
  });
  const { gladys } = await setup(t, { created: [SERVER, extra, BEDROOM] });
  const living = gladys.fake.discoveredDevices.find((d) => d.external_id === LIVING.external_id);
  assert.ok(living.features.some((f) => f.external_id.endsWith(':future')));
  await gladys.fake.scanRequest();
  assert.equal(gladys.fake.discoveredDevices.length, 3);
});

test('job titles: cleaned and capped; several recording at once', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const channels = createFakeChannels({ clock });
  channels.server.jobs = [
    job('B\u0007 show', -60, 600),
    job('A show', -120, 600),
    job('x'.repeat(500), 100, 600),
    job('Failed', -10, 600, { failed: true }),
  ];
  const { gladys } = await setup(t, { clock, channels });
  assert.equal(last(gladys, SERVER, 'recording'), 2);
  assert.equal(last(gladys, SERVER, 'recording_title'), 'A show, B show');
  assert.equal(last(gladys, SERVER, 'next_title').length, 200);
});
