import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, parsePlayers, playerId } from '../src/config.js';

test('addresses: bare host or http://, default port, IPv6 in brackets', () => {
  assert.deepEqual(parseAddress('192.168.1.3', 8089), {
    host: '192.168.1.3',
    port: 8089,
    origin: 'http://192.168.1.3:8089',
  });
  assert.deepEqual(parseAddress(' http://DVR.local:9000/ ', 8089), {
    host: 'dvr.local',
    port: 9000,
    origin: 'http://dvr.local:9000',
  });
  assert.deepEqual(parseAddress('[fe80::1]:57000', 57000), {
    host: 'fe80::1',
    port: 57000,
    origin: 'http://[fe80::1]:57000',
  });
  assert.equal(parseAddress('', 8089).error, 'empty');
  assert.equal(parseAddress('https://dvr.local', 8089).error, 'https');
});

test('addresses refused: path, query, credentials, controls, broadcast, multicast, unspecified', () => {
  for (const value of [
    'http://dvr.local/api',
    'dvr.local?x=1',
    'http://user:pass@dvr.local',
    'user@dvr.local',
    'dvr.local\r\nX: y',
    'dvr .local',
    'ftp://dvr.local',
    'dvr.local:0',
    'dvr.local:70000',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.251',
    '239.1.2.3',
    '[::]',
    '[ff02::1]',
    'fe80::1',
    '-bad.local',
    '1.2.3',
    '..',
    'a..b',
  ]) {
    assert.equal(parseAddress(value, 8089).error, 'invalid', value);
  }
});

test('player ids: dots and colons out, port only when not 57000; frozen', () => {
  assert.equal(playerId({ host: '192.168.1.20', port: 57000 }), '192-168-1-20');
  assert.equal(playerId({ host: 'tv.local', port: 57001 }), 'tv-local-57001');
  assert.equal(playerId({ host: 'fe80::1', port: 57000 }), 'fe80--1');
  for (const id of ['192-168-1-20', 'tv-local-57001', 'fe80--1']) assert.doesNotMatch(id, /[.:]/);
});

test('players: names, duplicates, 10 at most, invalid counted', () => {
  const { players, invalid } = parsePlayers(
    'Living room=192.168.1.20; 192.168.1.20\n=192.168.1.21, Bad=nope host, a-b.local, a.b-local',
  );
  assert.deepEqual(
    players.map((p) => [p.id, p.name]),
    [
      ['192-168-1-20', 'Living room'],
      ['192-168-1-21', 'Channels 192.168.1.21'],
      ['a-b-local', 'Channels a-b.local'],
    ],
  );
  assert.equal(invalid, 3, 'duplicate address, invalid host, colliding id');
  const many = parsePlayers(Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`).join(','));
  assert.equal(many.players.length, 10);
  assert.equal(many.invalid, 2);
  const named = parsePlayers(`${'x'.repeat(80)}\u0007=10.0.0.1`);
  assert.equal(named.players[0].name, 'x'.repeat(60));
});

test('normalizeConfig: defaults, interval, errors', () => {
  const empty = normalizeConfig();
  assert.equal(empty.server, null);
  assert.equal(empty.serverError, null);
  assert.deepEqual(empty.players, []);
  assert.equal(empty.pollMs, 30_000);
  assert.equal(normalizeConfig({ poll_interval: '300' }).pollMs, 300_000);
  assert.equal(normalizeConfig({ poll_interval: 300 }).pollMs, 300_000);
  assert.equal(normalizeConfig({ poll_interval: '5' }).pollMs, 30_000);
  assert.equal(normalizeConfig({ server_url: 'https://x' }).serverError, 'https');
  assert.equal(normalizeConfig({ server_url: 'x/y' }).serverError, 'invalid');
  assert.equal(normalizeConfig({ server_url: 42 }).serverError, null, 'not a string: empty');
});
