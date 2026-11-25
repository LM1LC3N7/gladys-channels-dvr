// -----------------------------------------------------------------------------
// Gladys devices and states (pure).
//
//   server  `ext:<selector>:server:dvr` (one per integration), read only:
//           recordings in progress, upcoming recordings, what records now,
//           the next recording, free and used space of the recordings disk
//   player  `ext:<selector>:player:<address slug>` (one per Channels app):
//           playback state (writable: pause, resume, stop), title, mute
//           (writable), channel (writable: tunes it), channel name, channel
//           up / down push buttons, app answering
//
// No switch, no binary actuator: nothing an "everything off" could reach.
// Units only from DEVICE_FEATURE_UNITS_BY_CATEGORY of the core (gigabyte for
// `data`); the other categories carry none.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  LIMITS,
  NOTHING,
  PLAYBACK,
  PLAYER_FEATURES as PF,
  PLAYER_TYPE,
  SERVER_FEATURES as SF,
  SERVER_ID,
  SERVER_TYPE,
} from './constants.js';

export const serverIds = (gladys) => gladys.externalIds(SERVER_TYPE, SERVER_ID);
export const playerIds = (gladys, id) => gladys.externalIds(PLAYER_TYPE, id);

const readOnly = { read_only: true, has_feedback: false };
const counter = (name) => ({
  name,
  category: C.COUNTER_SENSOR,
  type: T.SENSOR.INTEGER,
  min: 0,
  max: LIMITS.COUNT_MAX,
  keep_history: true,
  ...readOnly,
});
const text = (name) => ({
  name,
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  keep_history: false,
  ...readOnly,
});
const gigabytes = (name) => ({
  name,
  category: C.DATA,
  type: T.DATA.SIZE,
  unit: U.GIGABYTE,
  min: 0,
  max: LIMITS.DISK_MAX_BYTES / 1e9,
  keep_history: true,
  ...readOnly,
});
const button = (type, name) => ({
  name,
  category: C.TELEVISION,
  type,
  min: 0,
  max: 1,
  keep_history: false,
  read_only: false,
  has_feedback: false,
});

export const SERVER_SPECS = Object.freeze({
  [SF.RECORDING]: counter('Recordings in progress'),
  [SF.UPCOMING]: counter('Upcoming recordings'),
  [SF.RECORDING_TITLE]: text('Recording now'),
  [SF.NEXT_TITLE]: text('Next recording'),
  [SF.DISK_FREE]: gigabytes('Disk free'),
  [SF.DISK_USED]: gigabytes('Disk used'),
});

export const PLAYER_SPECS = Object.freeze({
  [PF.ONLINE]: {
    name: 'App answering',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    keep_history: true,
    ...readOnly,
  },
  [PF.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    // Writable: 0 pause, 1 resume, 2 stop (BUFFERING is never written).
    min: 0,
    max: 2,
    keep_history: false,
    read_only: false,
    has_feedback: true,
  },
  [PF.TITLE]: {
    name: 'Now playing',
    category: C.MUSIC,
    type: T.MUSIC.TITLE,
    min: 0,
    max: 0,
    keep_history: false,
    ...readOnly,
  },
  [PF.MUTE]: {
    name: 'Mute',
    category: C.MUSIC,
    type: T.MUSIC.MUTE,
    min: 0,
    max: 1,
    keep_history: false,
    read_only: false,
    has_feedback: true,
  },
  [PF.CHANNEL]: {
    name: 'Channel',
    category: C.TELEVISION,
    type: T.TELEVISION.CHANNEL,
    min: 1,
    max: LIMITS.CHANNEL_MAX,
    keep_history: false,
    read_only: false,
    has_feedback: true,
  },
  [PF.CHANNEL_NAME]: text('Channel name'),
  [PF.CHANNEL_UP]: button(T.TELEVISION.CHANNEL_UP, 'Channel up'),
  [PF.CHANNEL_DOWN]: button(T.TELEVISION.CHANNEL_DOWN, 'Channel down'),
});

/** The feature keys a command may target. */
export const PLAYER_COMMANDS = new Set([
  PF.PLAYBACK,
  PF.MUTE,
  PF.CHANNEL,
  PF.CHANNEL_UP,
  PF.CHANNEL_DOWN,
]);

/**
 * The features of `specs`, plus every feature of the created device (from
 * `gladys.devices`) this list would not have: a device published again never
 * loses a feature.
 */
function features(ids, specs, created) {
  const list = Object.entries(specs).map(([key, spec]) => ({
    external_id: ids.feature(key),
    ...spec,
  }));
  const known = new Set(list.map((f) => f.external_id));
  for (const feature of Array.isArray(created?.features) ? created.features : []) {
    if (feature && typeof feature.external_id === 'string' && !known.has(feature.external_id)) {
      known.add(feature.external_id);
      list.push({ ...feature });
    }
  }
  return list;
}

export function buildServerDevice(gladys, server, created) {
  const ids = serverIds(gladys);
  return {
    name: 'Channels DVR',
    external_id: ids.device,
    model: 'Channels DVR Server',
    should_poll: false,
    params: [{ name: 'ADDRESS', value: server.origin }],
    features: features(ids, SERVER_SPECS, created),
  };
}

export function buildPlayerDevice(gladys, player, created) {
  const ids = playerIds(gladys, player.id);
  return {
    name: player.name,
    external_id: ids.device,
    model: 'Channels app',
    should_poll: false,
    params: [{ name: 'ADDRESS', value: player.origin }],
    features: features(ids, PLAYER_SPECS, created),
  };
}

/**
 * What an external id of this integration designates:
 * { kind: 'server' | 'player', id, feature } (feature null for the device), or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  for (const [kind, prefix] of [
    ['server', gladys.externalId(`${SERVER_TYPE}:`)],
    ['player', gladys.externalId(`${PLAYER_TYPE}:`)],
  ]) {
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !/^[a-z0-9-]{1,300}$/.test(id ?? '')) return null;
    if (kind === 'server' && id !== SERVER_ID) return null;
    if (feature !== undefined && !/^[a-z_]{1,40}$/.test(feature)) return null;
    return { kind, id, feature: feature ?? null };
  }
  return null;
}

const gb = (bytes) => Math.round(bytes / 1e7) / 100;

/**
 * The states of a server reading { jobs?, disk? } (an absent part publishes
 * nothing: unknown stays unknown).
 */
export function serverStates(gladys, reading) {
  const ids = serverIds(gladys);
  const states = [];
  const { jobs, disk } = reading ?? {};
  if (jobs) {
    states.push(
      { device_feature_external_id: ids.feature(SF.RECORDING), state: jobs.recording },
      { device_feature_external_id: ids.feature(SF.UPCOMING), state: jobs.upcoming },
      {
        device_feature_external_id: ids.feature(SF.RECORDING_TITLE),
        text: jobs.recordingTitle ?? NOTHING,
      },
      { device_feature_external_id: ids.feature(SF.NEXT_TITLE), text: jobs.nextTitle ?? NOTHING },
    );
  }
  if (disk) {
    states.push(
      { device_feature_external_id: ids.feature(SF.DISK_FREE), state: gb(disk.free) },
      { device_feature_external_id: ids.feature(SF.DISK_USED), state: gb(disk.used) },
    );
  }
  return states;
}

/**
 * The states of a player reading:
 *   { online: true, status }   what the app said (an unknown part: nothing)
 *   { online: false, closed }  closed: the port refuses (the app does not
 *                              run): nothing plays; else only "not answering"
 */
export function playerStates(gladys, player, reading) {
  const ids = playerIds(gladys, player.id);
  const id = (key) => ids.feature(key);
  if (reading?.online !== true && reading?.online !== false) return [];
  const states = [{ device_feature_external_id: id(PF.ONLINE), state: reading.online ? 1 : 0 }];
  if (!reading.online) {
    if (reading.closed) {
      states.push(
        { device_feature_external_id: id(PF.PLAYBACK), state: PLAYBACK.IDLE },
        { device_feature_external_id: id(PF.TITLE), text: '' },
        { device_feature_external_id: id(PF.CHANNEL_NAME), text: NOTHING },
      );
    }
    return states;
  }
  const { playback, muted, channel, title } = reading.status;
  if (playback !== null) {
    states.push({ device_feature_external_id: id(PF.PLAYBACK), state: playback });
  }
  if (muted !== null) {
    states.push({ device_feature_external_id: id(PF.MUTE), state: muted ? 1 : 0 });
  }
  if (playback === PLAYBACK.IDLE) {
    states.push(
      { device_feature_external_id: id(PF.TITLE), text: '' },
      { device_feature_external_id: id(PF.CHANNEL_NAME), text: NOTHING },
    );
    return states;
  }
  if (playback === null) return states;
  states.push({ device_feature_external_id: id(PF.TITLE), text: title });
  if (channel) {
    states.push(
      { device_feature_external_id: id(PF.CHANNEL), state: channel.number },
      { device_feature_external_id: id(PF.CHANNEL_NAME), text: channel.name || NOTHING },
    );
  } else {
    // A recording or a video of the library: no channel watched.
    states.push({ device_feature_external_id: id(PF.CHANNEL_NAME), text: NOTHING });
  }
  return states;
}
