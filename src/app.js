// -----------------------------------------------------------------------------
// ChannelsApp: the integration. One Channels DVR Server (optional) and up to
// ten Channels apps (players), all on the local network, no credential.
//
//   start(config)  (re)starts: Discovery published, rounds scheduled
//   rounds         every `poll_interval` (30 s by default), each target read
//                  when it is due: the server (jobs; the disk every 5 min, a
//                  secondary reading) and each player (status). The time of
//                  each attempt is written in /data BEFORE the reading, so a
//                  restart never reads a target sooner than the interval.
//   commands       on a player only: playback (pause, resume, stop), mute,
//                  channel, channel up / down. Serialized per player, status
//                  read just before (the decision), answered within 3.5 s,
//                  confirmed by the status the app answers or by follow-up
//                  readings, never reported applied when not seen.
//
// Two clocks: `monotonic` paces the rounds, the budgets and the guards (a
// wall clock set back or forward never stops nor hurries them); `now` (wall)
// only dates the attempts kept in /data. One read of the monotonic clock per
// decision.
//
// Every run belongs to a generation: a restart or a stop bumps it, and the
// result of an older run is dropped after each await.
// -----------------------------------------------------------------------------

import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ChannelsClient, COMMAND_PATHS, channelPath } from './channels/client.js';
import { ChannelsError, CODES } from './channels/http.js';
import { parseChannelNumber } from './channels/parse.js';
import { normalizeConfig } from './config.js';
import { LIMITS, PLAYBACK, PLAYER_FEATURES as PF, STORE_FILE, TIMINGS } from './constants.js';
import { T, reasonOf } from './i18n.js';
import {
  PLAYER_COMMANDS,
  buildPlayerDevice,
  buildServerDevice,
  parseExternalId,
  playerIds,
  playerStates,
  serverIds,
  serverStates,
} from './model.js';
import { Store } from './store.js';

const SERVER_KEY = 'server';
const playerKey = (id) => `player:${id}`;

/** An error saying nothing left the integration. */
const nothingSent = (message) =>
  new ChannelsError('nothing_sent', `${message}: nothing sent`, { sent: false });

export class ChannelsApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Channels)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now] wall clock (ms), only for /data
   * @param {() => number} [options.monotonic] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {object} [options.timings]
   * @param {object} [options.fs] file functions of the store (tests)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'channels-dvr' }),
    request,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    timings = TIMINGS,
    fs,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = new ChannelsClient(request ? { request } : {});
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.timings = timings;
    this.store = new Store({
      filePath: join(dataDir, STORE_FILE),
      logger,
      readTimeoutMs: timings.DATA_READ_MS,
      timers,
      fs,
    });
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.generation = 0;
    this.running = false;
    this.handles = new Set();
    this.tickHandle = null;
    this.queue = Promise.resolve();
    this.round = null;
    /** player id -> tail of its command queue */
    this.commandQueues = new Map();
    this.reset();
  }

  reset() {
    /** target key -> monotonic time of its next reading */
    this.dueAt = new Map();
    /** target key -> { reading, at (monotonic, when the reading started) } */
    this.readings = new Map();
    this.diskDueAt = 0;
    this.disk = null;
    /** player id -> { until (monotonic), wanted, sentAt } of a mute toggle not seen applied */
    this.toggleGuards = new Map();
    this.transports = new Map();
    this.lastStatus = null;
    /** [monotonic, count] of the states published in the last minute */
    this.published = [];
  }

  // --- Lifecycle ---------------------------------------------------------------

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** (Re)start with a configuration; calls are serialized. */
  start(rawConfig) {
    return this.enqueue(() => this.run(rawConfig));
  }

  async stop() {
    this.generation += 1;
    this.running = false;
    this.halt();
  }

  /** Clears every timer of the current generation. */
  halt() {
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
    this.tickHandle = null;
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(
      async () => {
        this.handles.delete(handle);
        try {
          await task();
        } catch (err) {
          this.logger.error(`Loop failed: ${this.describe(err)}`);
        }
      },
      Math.max(0, delay),
    );
    this.handles.add(handle);
    return handle;
  }

  /** A start that failed before reading the configuration: again later, never without a timer. */
  retryStart(task) {
    this.halt();
    this.schedule(this.timings.CONFIG_RETRY_MS, task);
  }

  describe(err) {
    if (err instanceof ChannelsError) return err.message;
    return `${err?.name ?? 'Error'}: ${String(err?.message ?? '').slice(0, 200)}`;
  }

  /** The configured targets: [{ key, kind, server | player }]. */
  targets() {
    const list = [];
    if (this.config.server)
      list.push({ key: SERVER_KEY, kind: 'server', server: this.config.server });
    for (const player of this.config.players) {
      list.push({ key: playerKey(player.id), kind: 'player', player });
    }
    return list;
  }

  async run(rawConfig) {
    this.halt();
    const generation = ++this.generation;
    this.running = true;
    this.rawConfig = rawConfig ?? {};
    this.config = normalizeConfig(rawConfig);
    this.reset();
    // Gladys may have restarted: every value, badge and the status go again.
    this.gladys.forgetPublishedStates?.();
    await this.store.load();
    if (generation !== this.generation) return;
    const targets = this.targets();
    this.store.keepOnly(targets.map((t) => t.key));
    const mono = this.monotonic();
    const wall = this.now();
    const { pollMs } = this.config;
    for (const target of targets) {
      let delay = 0;
      if (!this.store.readable) {
        // The last attempts are unknown: a whole interval, never sooner.
        delay = pollMs;
      } else {
        const last = this.store.attempt(target.key);
        // A time in the future (a clock set back) is invalid: read now.
        if (last !== null && last <= wall)
          delay = Math.min(pollMs, Math.max(0, last + pollMs - wall));
      }
      this.dueAt.set(target.key, mono + delay);
    }
    if (!this.store.readable) this.scheduleStoreRetry(generation);
    if (this.config.server) {
      this.logger.info(`Using Channels DVR Server at ${this.config.server.origin}`);
    }
    this.logger.info(`${this.config.players.length} Channels player(s) configured`);
    await this.publishDiscovery();
    await this.updateStatus();
    this.scheduleTick(generation);
  }

  /** /data unreadable: read again every 10 s (one read at a time) until it is. */
  scheduleStoreRetry(generation) {
    this.schedule(this.timings.DATA_RETRY_MS, async () => {
      if (generation !== this.generation) return;
      await this.store.load();
      if (generation !== this.generation) return;
      if (this.store.readable) await this.updateStatus();
      else this.scheduleStoreRetry(generation);
    });
  }

  /** The next round, when the first target is due. */
  scheduleTick(generation) {
    if (generation !== this.generation || !this.running) return;
    if (this.tickHandle !== null) {
      this.timers.clearTimeout(this.tickHandle);
      this.handles.delete(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.dueAt.size === 0) return;
    const mono = this.monotonic();
    const next = Math.min(...this.dueAt.values());
    this.tickHandle = this.schedule(next - mono, async () => {
      this.tickHandle = null;
      await this.tick();
    });
  }

  // --- Rounds ------------------------------------------------------------------

  /** Reads every target that is due (one round at a time), then schedules the next. */
  tick() {
    // A round of an older generation (a restart during a slow reading) never
    // stands for one of this generation.
    const generation = this.generation;
    if (this.round?.generation === generation) return this.round.promise;
    const promise = this.readDue().finally(() => {
      if (this.round?.promise === promise) this.round = null;
    });
    this.round = { generation, promise };
    return promise;
  }

  async readDue() {
    const generation = this.generation;
    if (!this.running) return;
    const mono = this.monotonic();
    const due = this.targets().filter((t) => (this.dueAt.get(t.key) ?? Infinity) <= mono);
    if (due.length > 0) {
      // The period runs from the start of the round: never a cycle late.
      for (const t of due) this.dueAt.set(t.key, mono + this.config.pollMs);
      // The attempt is in /data before the first byte (bounded: a hung /data
      // never stops the rounds).
      await this.within(
        this.store.recordAttempts(
          due.map((t) => t.key),
          this.now(),
        ),
        this.timings.DATA_READ_MS,
      ).catch(() => {});
      if (generation !== this.generation) return;
      await Promise.all(
        due.map((t) =>
          t.kind === 'server'
            ? this.readServer(t.server, generation)
            : this.readPlayer(t.player, generation),
        ),
      );
      if (generation !== this.generation) return;
      await this.publishTransports();
      await this.updateStatus();
    }
    this.scheduleTick(generation);
  }

  /** Resolves `promise`, or rejects after `ms` (the promise keeps running). */
  within(promise, ms, message = 'Too long') {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  async readServer(server, generation) {
    const at = this.monotonic();
    let jobs = null;
    let error = null;
    try {
      jobs = await this.client.jobs(server);
    } catch (err) {
      error = err;
    }
    if (generation !== this.generation) return;
    const previous = this.readings.get(SERVER_KEY)?.reading;
    if (error) {
      if (!previous || previous.jobs)
        this.logger.warn(`Channels DVR Server not read: ${this.describe(error)}`);
      this.readings.set(SERVER_KEY, { reading: { jobs: null, error }, at });
      return;
    }
    // The disk: a secondary reading, its failure never blocks the jobs.
    if (at >= this.diskDueAt) {
      this.diskDueAt = at + Math.max(this.timings.DISK_EVERY_MS, this.config.pollMs);
      try {
        this.disk = await this.client.disk(server);
      } catch (err) {
        this.disk = null;
        this.logger.debug(`Disk not read: ${this.describe(err)}`);
      }
      if (generation !== this.generation) return;
    }
    const reading = { jobs, error: null, disk: this.disk };
    this.readings.set(SERVER_KEY, { reading, at });
    if (!previous || previous.error)
      this.logger.info(
        `Channels DVR Server answers: ${jobs.recording} recording, ${jobs.upcoming} upcoming`,
      );
    if (this.isCreated(serverIds(this.gladys).device)) {
      await this.publishStates(serverStates(this.gladys, reading));
    }
  }

  /** One status reading of a player, published. Resolves the reading. */
  async readPlayer(player, generation, timeout = this.timings.PLAYER_TIMEOUT_MS) {
    const at = this.monotonic();
    let reading;
    try {
      reading = { online: true, status: await this.client.status(player, timeout) };
    } catch (err) {
      reading = { online: false, closed: err?.code === CODES.REFUSED, error: err };
    }
    if (generation !== this.generation) return null;
    // An older reading than the one kept (crossing a command's) is not published.
    if (this.record(player, reading, at)) await this.publishPlayer(player, reading);
    return reading;
  }

  /**
   * Keeps a reading of a player (started at `at`); lifts a mute guard it shows
   * applied. False when a newer reading is already kept.
   */
  record(player, reading, at) {
    const key = playerKey(player.id);
    const previous = this.readings.get(key);
    // An older reading never replaces a newer one (a command's and a round's crossing).
    if (previous && previous.at > at) return false;
    if (previous && previous.reading.online !== reading.online) {
      this.logger.info(
        `${player.name}: ${reading.online ? 'answers' : `not answering (${this.describe(reading.error)})`}`,
      );
    }
    this.readings.set(key, { reading, at });
    const guard = this.toggleGuards.get(player.id);
    if (guard && at > guard.sentAt && reading.online && reading.status.muted === guard.wanted) {
      this.toggleGuards.delete(player.id);
    }
    return true;
  }

  async publishPlayer(player, reading) {
    if (!this.isCreated(playerIds(this.gladys, player.id).device)) return;
    await this.publishStates(playerStates(this.gladys, player, reading));
  }

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((d) => d?.external_id === externalId);
  }

  /**
   * Changed values only. Gladys takes 300 states a minute per integration:
   * a batch that would pass LIMITS.STATES_PER_MINUTE waits for a later
   * reading (the values stay unpublished, so they go then).
   */
  async publishStates(list) {
    if (list.length === 0) return;
    const mono = this.monotonic();
    this.published = this.published.filter(([at]) => mono - at < 60_000);
    const used = this.published.reduce((sum, [, count]) => sum + count, 0);
    if (used + list.length > LIMITS.STATES_PER_MINUTE) {
      this.logger.debug('States held back: the rate limit of Gladys is near');
      return;
    }
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.published.push([mono, Number(result?.count) || 0]);
    } catch (err) {
      this.logger.warn(`States not published: ${this.describe(err)}`);
    }
  }

  async publishTransports() {
    const entries = [];
    const server = serverIds(this.gladys).device;
    const serverReading = this.readings.get(SERVER_KEY)?.reading;
    if (this.config.server && serverReading && this.isCreated(server)) {
      entries.push({
        external_id: server,
        transport: serverReading.jobs ? 'local' : 'unreachable',
      });
    }
    for (const player of this.config.players) {
      const id = playerIds(this.gladys, player.id).device;
      const reading = this.readings.get(playerKey(player.id))?.reading;
      if (reading && this.isCreated(id)) {
        entries.push({ external_id: id, transport: reading.online ? 'local' : 'unreachable' });
      }
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    for (const entry of changed) this.transports.set(entry.external_id, entry.transport);
    await this.gladys.publishTransports(changed).catch((err) => {
      for (const entry of changed) this.transports.delete(entry.external_id);
      this.logger.debug(`Transports not published: ${this.describe(err)}`);
    });
  }

  // --- Status ------------------------------------------------------------------

  async updateStatus() {
    if (!this.running) return;
    const generation = this.generation;
    const notes = [];
    let connected = true;
    const { server, serverError, players, invalidPlayers } = this.config;
    if (serverError === 'https') notes.push(T.status.serverHttps);
    else if (serverError) notes.push(T.status.serverInvalid);
    if (invalidPlayers > 0) notes.push(T.status.invalidPlayers(invalidPlayers));
    if (!server && players.length === 0) {
      connected = false;
      notes.unshift(T.status.nothing);
    } else {
      if (!this.store.readable && this.store.state !== 'unknown')
        notes.push(T.status.dataUnreadable);
      const read = this.targets()
        .map((t) => this.readings.get(t.key)?.reading)
        .filter(Boolean);
      if (read.length === 0) {
        notes.push(T.status.waiting);
      } else {
        const serverReading = this.readings.get(SERVER_KEY)?.reading;
        if (server && serverReading) {
          notes.push(
            serverReading.jobs
              ? T.status.server(serverReading.jobs)
              : T.status.serverDown(reasonOf(serverReading.error)),
          );
        }
        const playerReadings = players
          .map((p) => this.readings.get(playerKey(p.id))?.reading)
          .filter(Boolean);
        if (players.length > 0) {
          notes.push(
            T.status.players(playerReadings.filter((r) => r.online).length, players.length),
          );
        }
        // Everything read and nothing answers: not "connected". A player
        // whose app is closed (the port refuses) is a normal state, not a
        // failure of the integration.
        const answering =
          (serverReading?.jobs ? 1 : 0) + playerReadings.filter((r) => r.online || r.closed).length;
        if (read.length === this.targets().length && answering === 0) connected = false;
      }
    }
    const message = T.join(notes);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    if (generation !== this.generation) return;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${this.describe(err)}`);
    });
  }

  // --- Devices -----------------------------------------------------------------

  /** Discovery: the configured server and players (never a reading). */
  async publishDiscovery() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d?.external_id, d]));
    const devices = [];
    if (this.config.server) {
      devices.push(
        buildServerDevice(
          this.gladys,
          this.config.server,
          created.get(serverIds(this.gladys).device),
        ),
      );
    }
    for (const player of this.config.players) {
      devices.push(
        buildPlayerDevice(
          this.gladys,
          player,
          created.get(playerIds(this.gladys, player.id).device),
        ),
      );
    }
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${this.describe(err)}`);
    });
  }

  /** A device created: its states, only from a reading younger than the interval. */
  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) return;
    const key = parsed.kind === 'server' ? SERVER_KEY : playerKey(parsed.id);
    const last = this.readings.get(key);
    // (The SDK forgets the values published for it before: they go again.)
    this.transports.delete(device.external_id);
    if (last && this.monotonic() - last.at < this.config.pollMs) {
      if (parsed.kind === 'server') {
        await this.publishStates(serverStates(this.gladys, last.reading));
      } else {
        const player = this.config.players.find((p) => p.id === parsed.id);
        if (player) await this.publishStates(playerStates(this.gladys, player, last.reading));
      }
    }
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Commands ----------------------------------------------------------------

  async setValue(device, feature, value) {
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (
      !parsed ||
      parsed.feature === null ||
      feature.external_id.slice(0, device?.external_id?.length) !== device?.external_id
    ) {
      throw new Error(T.errors.unknownDevice);
    }
    if (parsed.kind !== 'player' || !PLAYER_COMMANDS.has(parsed.feature)) {
      throw new Error(T.errors.readOnly);
    }
    const player = this.config.players.find((p) => p.id === parsed.id);
    if (!player) throw new Error(T.errors.notConfigured);
    // Checked before anything is read: an invalid value never costs a request.
    const wanted = this.checkValue(parsed.feature, value);
    const started = this.monotonic();
    const generation = this.generation;
    // `late`: Gladys stopped waiting; `sending`: the command left (or may have).
    const progress = { late: false, sending: false };
    const previous = this.commandQueues.get(player.id) ?? Promise.resolve();
    const run = previous.then(() => {
      if (progress.late || this.remaining(started) < 300) {
        // Gladys stopped waiting while it was queued: dropped, never sent late.
        progress.late = true;
        throw nothingSent(`${player.name}: no time left for this command`);
      }
      return this.command(player, parsed.feature, wanted, started, generation, progress);
    });
    const tail = run.catch(() => {});
    this.commandQueues.set(player.id, tail);
    tail.then(() => {
      if (this.commandQueues.get(player.id) === tail) this.commandQueues.delete(player.id);
    });
    // A real-time deadline (not the injectable timers): the ack Gladys waits for.
    let handle;
    const deadline = new Promise((_, reject) => {
      handle = setTimeout(
        () => {
          progress.late = true;
          reject(
            progress.sending
              ? new ChannelsError(
                  CODES.TIMEOUT,
                  `${player.name}: sent, without confirmation (no answer in time)`,
                )
              : nothingSent(`${player.name}: no answer in time`),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(handle);
    }
  }

  remaining(started) {
    return this.timings.COMMAND_BUDGET_MS - (this.monotonic() - started);
  }

  /** The value of a command, checked: a number, a channel, or an error. */
  checkValue(key, value) {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim() || NaN);
    if (key === PF.PLAYBACK) {
      if (![PLAYBACK.PAUSED, PLAYBACK.PLAYING, PLAYBACK.IDLE].includes(n)) {
        throw nothingSent('Playback takes 0 (pause), 1 (play) or 2 (stop)');
      }
      return n;
    }
    if (key === PF.MUTE) {
      if (n !== 0 && n !== 1) throw nothingSent('Mute takes 0 or 1');
      return n;
    }
    if (key === PF.CHANNEL) {
      const channel = Number.isFinite(n) ? parseChannelNumber(String(n)) : null;
      if (channel === null)
        throw nothingSent('Invalid channel number (1 to 99999, "12.1" for a subchannel)');
      return channel;
    }
    return null; // a push button
  }

  async command(player, key, wanted, started, generation, progress = {}) {
    // The state just before decides (never the memory of a round).
    const preTimeout = Math.min(this.timings.PRE_READ_MS, this.remaining(started) - 300);
    if (preTimeout < 200) throw nothingSent(`${player.name}: no time left for this command`);
    const before = await this.readPlayer(player, generation, preTimeout);
    if (generation !== this.generation) throw nothingSent('Configuration changed');
    if (!before?.online) {
      throw nothingSent(
        before?.closed
          ? `${player.name}: the Channels app is not running`
          : `${player.name}: no answer (${reasonOf(before?.error).en})`,
      );
    }
    const status = before.status;
    let path;
    let check;
    if (key === PF.PLAYBACK) {
      if (status.playback === wanted) return; // already so: nothing to send
      if (wanted === PLAYBACK.IDLE) {
        path = COMMAND_PATHS.stop; // sent even on an unknown state
      } else if (status.playback === null) {
        throw nothingSent(`${player.name}: playback state unknown`);
      } else if (status.playback === PLAYBACK.IDLE) {
        throw nothingSent(`${player.name}: nothing is playing (tune a channel first)`);
      } else {
        path = wanted === PLAYBACK.PAUSED ? COMMAND_PATHS.pause : COMMAND_PATHS.resume;
      }
      check = (s) => s.playback === wanted;
    } else if (key === PF.MUTE) {
      // toggle_mute is a toggle: sent only on a state read just now, and
      // never while an earlier toggle is not seen applied.
      if (status.muted === null) throw nothingSent(`${player.name}: mute state unknown`);
      if (status.muted === (wanted === 1)) return;
      const guard = this.toggleGuards.get(player.id);
      if (guard && this.monotonic() < guard.until) {
        throw nothingSent(
          `${player.name}: the previous mute change is not seen applied yet (retry in a few seconds)`,
        );
      }
      path = COMMAND_PATHS.toggleMute;
      check = (s) => s.muted === (wanted === 1);
    } else if (key === PF.CHANNEL) {
      if (status.playback !== PLAYBACK.IDLE && status.channel?.number === wanted) return;
      path = channelPath(wanted);
      check = (s) => s.channel?.number === wanted;
    } else {
      const from = status.channel?.number;
      if (from === undefined) throw nothingSent(`${player.name}: no channel is being watched`);
      path = key === PF.CHANNEL_UP ? COMMAND_PATHS.channelUp : COMMAND_PATHS.channelDown;
      check = (s) => s.channel !== null && s.channel.number !== from;
    }
    const timeout = this.remaining(started) - 100;
    // Gladys stopped waiting during the reading: never sent late.
    if (progress.late || timeout < 300)
      throw nothingSent(`${player.name}: no time left for this command`);
    progress.sending = true;
    const sentAt = this.monotonic();
    if (key === PF.MUTE) {
      this.toggleGuards.set(player.id, {
        until: sentAt + this.timings.TOGGLE_GUARD_MS,
        wanted: wanted === 1,
        sentAt,
      });
    }
    let after;
    try {
      after = await this.client.command(player, path, timeout);
    } catch (err) {
      if (generation !== this.generation) throw nothingSent('Configuration changed');
      if (err?.sent === false) {
        if (key === PF.MUTE) this.toggleGuards.delete(player.id);
        throw nothingSent(`${player.name}: ${this.describe(err)}`);
      }
      this.followUps(player, check, generation);
      if (err?.code === CODES.HTTP) {
        throw new ChannelsError(
          CODES.HTTP,
          `${player.name}: the app answered HTTP ${err.status}, not seen applied`,
        );
      }
      throw new ChannelsError(
        err?.code ?? CODES.TIMEOUT,
        `${player.name}: sent, without confirmation (${this.describe(err)})`,
      );
    }
    if (generation !== this.generation) return;
    if (after) {
      const reading = { online: true, status: after };
      if (this.record(player, reading, sentAt + 0.001)) await this.publishPlayer(player, reading);
      if (check(after)) return;
    }
    // Sent and accepted, not seen applied yet: the app applies it a moment
    // later. Never reported applied; follow-up readings publish what it does.
    this.logger.info(`${player.name}: ${key} sent, not seen applied yet`);
    this.followUps(player, check, generation);
  }

  /** Readings after a command not seen applied; a warning if never seen. */
  followUps(player, check, generation) {
    const [first, last] = this.timings.FOLLOW_UPS_MS;
    const read = (isLast) => async () => {
      if (generation !== this.generation) return;
      const reading = await this.readPlayer(player, generation);
      if (generation !== this.generation || !isLast) return;
      if (!reading?.online || !check(reading.status)) {
        this.logger.warn(`${player.name}: the command is not seen applied`);
      }
    };
    this.schedule(first, read(false));
    this.schedule(last, read(true));
  }

  // --- Configuration button ----------------------------------------------------

  /**
   * The state of every target from its last reading. A round runs only for
   * the targets that are due: the button never reads faster than the interval.
   */
  async testConnection() {
    await this.within(
      this.queue.then(() => this.tick()),
      this.timings.TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    const { server, players, pollMs } = this.config;
    if (!server && players.length === 0) throw new Error(T.status.nothing.en);
    const lines = [];
    if (server) {
      const reading = this.readings.get(SERVER_KEY)?.reading;
      if (!reading) lines.push({ en: 'Server: not read yet.', fr: 'Serveur : pas encore lu.' });
      else if (reading.jobs) lines.push(T.test.server(reading.jobs, reading.disk));
      else lines.push(T.test.serverDown(reasonOf(reading.error)));
    }
    for (const player of players) {
      lines.push(T.test.player(player.name, this.readings.get(playerKey(player.id))?.reading));
    }
    lines.push(T.test.age(Math.round(pollMs / 1000)));
    return T.join(lines);
  }
}
