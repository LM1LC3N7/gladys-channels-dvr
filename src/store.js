// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume: when each target (the
// server, each player) was last read, wall clock ms, written BEFORE the
// reading. A restart (a crash loop, a reconnection to Gladys, the
// configuration saved unchanged) therefore never reads a target sooner than
// the polling interval. Nothing else, and nothing secret: Channels takes no
// credential.
//
// /data unreadable (EACCES, EIO, a read that hangs) is not "empty": the
// times are unknown, the caller waits a whole interval, the file is read
// again every 10 s (one read at a time, each bounded to 2 s) and never
// written over until read. A file that is not JSON (truncated) is replaced
// by the next write: it holds nothing that cannot be learned again.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STORE_STATES = Object.freeze({
  UNKNOWN: 'unknown', // not read yet
  OK: 'ok',
  UNREADABLE: 'unreadable',
  CORRUPT: 'corrupt',
});

export class Store {
  #writes = Promise.resolve();
  #reading = null;

  /**
   * @param {{ filePath: string, logger?: object, readTimeoutMs?: number,
   *   timers?: { setTimeout: Function, clearTimeout: Function },
   *   fs?: { readFile: Function, writeFile: Function, rename: Function, rm: Function, mkdir: Function } }} options
   */
  constructor({ filePath, logger, readTimeoutMs = 2_000, timers = globalThis, fs }) {
    this.filePath = filePath;
    this.logger = logger;
    this.readTimeoutMs = readTimeoutMs;
    this.timers = timers;
    this.fs = { readFile, writeFile, rename, rm, mkdir, ...fs };
    this.attempts = {};
    this.state = STORE_STATES.UNKNOWN;
  }

  get readable() {
    return this.state === STORE_STATES.OK || this.state === STORE_STATES.CORRUPT;
  }

  /** Reads the file (one read at a time, bounded); resolves the new state. */
  load() {
    if (this.#reading) return this.#reading;
    let handle;
    const read = this.fs.readFile(this.filePath, 'utf8').then(
      (content) => {
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          return { state: STORE_STATES.CORRUPT, attempts: {} };
        }
        const attempts = {};
        const raw = parsed?.attempts;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [key, value] of Object.entries(raw)) {
            if (/^[a-z0-9:-]{1,320}$/.test(key) && Number.isSafeInteger(value) && value > 0) {
              attempts[key] = value;
            }
          }
        }
        return { state: STORE_STATES.OK, attempts };
      },
      (err) =>
        err?.code === 'ENOENT'
          ? { state: STORE_STATES.OK, attempts: {} }
          : { state: STORE_STATES.UNREADABLE, code: String(err?.code ?? '') },
    );
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ state: STORE_STATES.UNREADABLE, code: 'TIMEOUT' }),
        this.readTimeoutMs,
      );
    });
    // The read that hangs keeps the slot until it settles: never two at once.
    read.finally(() => {
      this.timers.clearTimeout(handle);
      this.#reading = null;
    });
    const result = Promise.race([read, limit]).then((outcome) => {
      if (outcome.state === STORE_STATES.UNREADABLE) {
        if (this.state !== STORE_STATES.UNREADABLE) {
          this.logger?.warn(
            `/data unreadable (${outcome.code || 'error'}): read again in a moment`,
          );
        }
        // Times learned meanwhile (in memory) are kept; nothing written.
        this.state = STORE_STATES.UNREADABLE;
        return this.state;
      }
      if (outcome.state === STORE_STATES.CORRUPT && this.state !== STORE_STATES.CORRUPT) {
        this.logger?.warn('/data file is not JSON: replaced at the next write');
      }
      // The file and what this run learned: the later time of each.
      for (const [key, value] of Object.entries(outcome.attempts)) {
        if (!(this.attempts[key] >= value)) this.attempts[key] = value;
      }
      this.state = outcome.state;
      return this.state;
    });
    this.#reading = result;
    return result;
  }

  attempt(key) {
    return this.attempts[key] ?? null;
  }

  /**
   * Records the attempt times, then writes the file. Resolves true when
   * written; false when /data is unreadable (not written over) or the write
   * failed (the times stay in memory).
   */
  async recordAttempts(keys, at) {
    for (const key of keys) this.attempts[key] = at;
    if (!this.readable) return false;
    return this.#save();
  }

  /** Forgets the targets no longer configured (next write). */
  keepOnly(keys) {
    const wanted = new Set(keys);
    for (const key of Object.keys(this.attempts)) if (!wanted.has(key)) delete this.attempts[key];
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.filePath), { recursive: true });
      await this.fs.writeFile(tmp, `${JSON.stringify({ attempts: this.attempts }, null, 2)}\n`, {
        mode: 0o600,
      });
      await this.fs.rename(tmp, this.filePath);
      return true;
    } catch (err) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(
        `/data not written (${String(err?.code ?? 'error')}): times kept in memory`,
      );
      return false;
    }
  }
}
