// -----------------------------------------------------------------------------
// Keys, ports, limits and timings. The manifest keys and the external id
// shapes are stored in Gladys and in user scenes: never rename one
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/** `ext:<selector>:server:dvr`: one Channels DVR Server per integration. */
export const SERVER_TYPE = 'server';
export const SERVER_ID = 'dvr';
/** `ext:<selector>:player:<slug of the address>` (see src/config.js, playerId). */
export const PLAYER_TYPE = 'player';

export const SERVER_FEATURES = Object.freeze({
  /** Jobs whose time window holds the server's time (and not skipped nor failed). */
  RECORDING: 'recording',
  /** Jobs starting later (not skipped). */
  UPCOMING: 'upcoming',
  /** Names of the jobs recording now, or NOTHING. */
  RECORDING_TITLE: 'recording_title',
  /** Name of the next job to start, or NOTHING. */
  NEXT_TITLE: 'next_title',
  /** Free and used space of the recordings disk, in GB (10^9 bytes). */
  DISK_FREE: 'disk_free',
  DISK_USED: 'disk_used',
});

export const PLAYER_FEATURES = Object.freeze({
  /** 1 the Channels app answers on its API port, 0 not. */
  ONLINE: 'online',
  /** MUSIC_PLAYBACK_STATE, writable: 0 pause, 1 resume, 2 stop. */
  PLAYBACK: 'playback_state',
  /** What is playing (title, then the episode title), '' when nothing. */
  TITLE: 'title',
  /** Muted (1) or not (0); writable. */
  MUTE: 'mute',
  /** The channel number watched; writing it tunes the channel. */
  CHANNEL: 'channel',
  /** The name of the channel watched, or NOTHING. */
  CHANNEL_NAME: 'channel_name',
  /** Push buttons. */
  CHANNEL_UP: 'channel_up',
  CHANNEL_DOWN: 'channel_down',
});

/** MUSIC_PLAYBACK_STATE of the core (server/utils/constants.js). */
export const PLAYBACK = Object.freeze({ PAUSED: 0, PLAYING: 1, IDLE: 2 });

/** Seconds between two readings (the manifest options). */
export const POLL_INTERVALS = Object.freeze(['15', '30', '60', '120', '300']);

/** What a text feature shows when there is nothing. */
export const NOTHING = '—';

export const PORTS = Object.freeze({ SERVER: 8089, PLAYER: 57000 });

export const LIMITS = Object.freeze({
  /** Players followed (one device each). */
  PLAYERS: 10,
  /** Jobs read from one answer (a server has a few hundred at most). */
  JOBS: 5000,
  /** Characters of a text state (the core cuts music texts at 200). */
  TEXT: 200,
  /** Characters of a device name. */
  NAME: 60,
  /** A count above this is not a reading. */
  COUNT_MAX: 100_000,
  /** A disk above this (bytes, 1 EB) is not a reading. */
  DISK_MAX_BYTES: 1e18,
  /** Channel numbers: 1 to 99999, at most 3 decimals (ATSC "12.1"). */
  CHANNEL_MAX: 99_999,
  /** Gladys takes 300 states a minute per integration: we keep under this. */
  STATES_PER_MINUTE: 250,
});

/** Size caps of the answers (bytes). */
export const MAX_BYTES = Object.freeze({
  JOBS: 8 * 1024 * 1024,
  DVR: 1024 * 1024,
  STATUS: 256 * 1024,
});

export const TIMINGS = Object.freeze({
  /** One request to the server (the job list can be long). */
  SERVER_TIMEOUT_MS: 10_000,
  /** One request to a player. */
  PLAYER_TIMEOUT_MS: 4_000,
  /** The disk is read this often (a secondary reading). */
  DISK_EVERY_MS: 5 * 60_000,
  /** Gladys waits 5 s for the ack of a command: we answer within this. */
  COMMAND_BUDGET_MS: 3_500,
  /** Of which the status read before a command takes at most this. */
  PRE_READ_MS: 1_500,
  /** Follow-up readings after a command not seen applied (from the command). */
  FOLLOW_UPS_MS: Object.freeze([1_500, 5_000]),
  /** A mute toggle not seen applied blocks the next one this long (or until seen). */
  TOGGLE_GUARD_MS: 6_000,
  /** /data unreadable: read again this often. */
  DATA_RETRY_MS: 10_000,
  /** /data read: never waited longer than this. */
  DATA_READ_MS: 2_000,
  /** The configuration unreadable (Gladys starting): asked again this often. */
  CONFIG_RETRY_MS: 30_000,
  /** The "Test" button waits 30 s: answer before. */
  TEST_BUDGET_MS: 20_000,
});

/** The persistent store in /data (see src/store.js). */
export const STORE_FILE = 'channels-dvr.json';
