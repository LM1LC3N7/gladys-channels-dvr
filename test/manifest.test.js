// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS, normalizeConfig } from '../src/config.js';
import { ACTIONS, POLL_INTERVALS } from '../src/constants.js';
import { PLAYER_COMMANDS, buildPlayerDevice, buildServerDevice } from '../src/model.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const gladys = createFakeGladys({ selector: 'channels-dvr' });
const config = normalizeConfig({ server_url: '10.0.0.2', players: '10.0.0.3' });
const server = buildServerDevice(gladys, config.server);
const player = buildPlayerDevice(gladys, config.players[0]);
const features = [...server.features, ...player.features];

test('the store basics; version 0.1.0 set by hand everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries and the music types need 5.3');
  assert.deepEqual(manifest.countries, ['US', 'CA', 'GB'], 'the official list of Channels');
  assert.match(read('README.md'), /United States, Canada, United Kingdom/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-channels-dvr:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-channels-dvr');
  assert.equal(lock.name, 'gladys-channels-dvr');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.1$/);
  assert.match(pkg.scripts.test, /--test-timeout=60000/);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['multimedia', 'servers']);
  assert.equal(manifest.keywords, undefined);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested with a real Channels/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai Channels/i);
});

test('the license (standard, no name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /No third-party code/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual; no "encrypted"', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /chiffr|encrypt|hachage|hash/i);
});

test('the configuration matches the code; no secret, no key prefixed gladys_', () => {
  for (const [key, value] of Object.entries(DEFAULTS))
    assert.equal(fields[key].default, value, key);
  assert.deepEqual(
    fields.poll_interval.options.map((o) => o.value),
    POLL_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'server_url',
    'players',
    'poll_interval',
  ]);
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/);
    assert.notEqual(field.type, 'secret');
  }
  // The placeholders: the name differs from the address (an example, not an id).
  assert.match(fields.players.placeholder.en, /Living room=192\.168\.1\.20/);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) assert.ok(text.length <= 1000);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS))
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  for (const absent of ['scene_actions', 'scene_triggers', 'widgets', 'music']) {
    assert.equal(manifest[absent], undefined, absent);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', 'onDeviceCreated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('features: every NOT NULL column; no switch, no binary actuator', () => {
  for (const f of features) {
    for (const column of [
      'name',
      'min',
      'max',
      'read_only',
      'has_feedback',
      'category',
      'type',
      'external_id',
    ]) {
      assert.ok(f[column] !== undefined && f[column] !== null, `${f.external_id} ${column}`);
    }
    assert.ok(!['switch', 'light', 'lock', 'button'].includes(f.category), f.external_id);
    if (f.type === 'binary') assert.equal(f.read_only, true, `${f.external_id}: a writable binary`);
    assert.doesNotMatch(f.external_id.split(':').slice(2).join(':'), /\.|\.\./);
  }
  assert.ok(
    server.features.every((f) => f.read_only),
    'the server is read only',
  );
  const writable = player.features
    .filter((f) => !f.read_only)
    .map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(writable.sort(), [...PLAYER_COMMANDS].sort());
});

test('supported_options: none published (the rules of the core would apply to any)', () => {
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  const normalize = existsSync(core)
    ? createRequire(import.meta.url)(core).normalizeSupportedOptions
    : null;
  for (const f of features) {
    if (f.supported_options === undefined) continue;
    for (const option of f.supported_options) {
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.length > 0 && option.label === option.label.trim());
    }
    if (normalize)
      assert.deepEqual(
        normalize(f.supported_options, { allowStringValues: true }),
        f.supported_options,
      );
  }
  assert.equal(features.filter((f) => f.supported_options !== undefined).length, 0);
});

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  const allowed = {
    data: [
      'bit',
      'kilobit',
      'megabit',
      'gigabit',
      'byte',
      'kilobyte',
      'megabyte',
      'gigabyte',
      'terabyte',
    ],
  };
  const withUnit = features.filter((f) => f.unit !== undefined);
  for (const f of withUnit) {
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(f.unit));
    assert.ok(allowed[f.category]?.includes(f.unit), `${f.name}: ${f.unit}`);
  }
  assert.equal(withUnit.length, 2, 'the disk, in GB');
});
