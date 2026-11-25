// -----------------------------------------------------------------------------
// The calls the integration makes, read only on the server, a handful of
// commands on the players:
//
//   server  GET /api/v1/jobs, GET /dvr
//   player  GET /api/status
//           POST /api/pause | /api/resume | /api/stop | /api/toggle_mute
//                /api/channel_up | /api/channel_down | /api/play/channel/<n>
//
// Never `toggle_record`, `play/recording`, `navigate` nor `notify`. No
// credential: the APIs of Channels take none on the local network.
// -----------------------------------------------------------------------------

import { MAX_BYTES, TIMINGS } from '../constants.js';
import { ChannelsError, CODES, httpRequest } from './http.js';
import { parseDateHeader, parseDvr, parseJobs, parseStatus } from './parse.js';

export const COMMAND_PATHS = Object.freeze({
  pause: '/api/pause',
  resume: '/api/resume',
  stop: '/api/stop',
  toggleMute: '/api/toggle_mute',
  channelUp: '/api/channel_up',
  channelDown: '/api/channel_down',
});

/** The path that tunes a channel (number checked by the caller). */
export const channelPath = (number) => `/api/play/channel/${encodeURIComponent(String(number))}`;

function json(response) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function checkStatus(response) {
  if (response.status < 200 || response.status > 299) {
    throw new ChannelsError(CODES.HTTP, `HTTP ${response.status}`, { status: response.status });
  }
}

export class ChannelsClient {
  /** @param {{ request?: Function }} [options] the HTTP transport (tests inject a fake) */
  constructor({ request = httpRequest } = {}) {
    this.request = request;
  }

  /** The jobs at the server's time (its `Date` header): see parseJobs. */
  async jobs(server) {
    const response = await this.request(server, '/api/v1/jobs', {
      timeout: TIMINGS.SERVER_TIMEOUT_MS,
      maxBytes: MAX_BYTES.JOBS,
    });
    checkStatus(response);
    const serverNow = parseDateHeader(response.headers?.date);
    // Without the server's time, nothing says what records now: unknown,
    // never a guess from our own clock.
    if (serverNow === null) throw new ChannelsError(CODES.BAD_ANSWER, 'No readable Date header');
    const parsed = parseJobs(json(response), serverNow);
    if (!parsed) throw new ChannelsError(CODES.BAD_ANSWER, 'Not a list of jobs');
    return parsed;
  }

  /** The recordings disk: { free, used } bytes. */
  async disk(server) {
    const response = await this.request(server, '/dvr', {
      timeout: TIMINGS.SERVER_TIMEOUT_MS,
      maxBytes: MAX_BYTES.DVR,
    });
    checkStatus(response);
    const parsed = parseDvr(json(response));
    if (!parsed) throw new ChannelsError(CODES.BAD_ANSWER, 'No disk in the answer');
    return parsed;
  }

  /** The status of a player within `timeout` ms. */
  async status(player, timeout = TIMINGS.PLAYER_TIMEOUT_MS) {
    const response = await this.request(player, '/api/status', {
      timeout,
      maxBytes: MAX_BYTES.STATUS,
    });
    checkStatus(response);
    const parsed = parseStatus(json(response));
    if (!parsed) throw new ChannelsError(CODES.BAD_ANSWER, 'Not a status of Channels');
    return parsed;
  }

  /**
   * One command: the status the app answers (null when the answer is not a
   * status: sent, state unknown). A non-2xx status rejects (`sent` true).
   */
  async command(player, path, timeout) {
    const response = await this.request(player, path, {
      method: 'POST',
      timeout,
      maxBytes: MAX_BYTES.STATUS,
    });
    checkStatus(response);
    return parseStatus(json(response));
  }
}
