// -----------------------------------------------------------------------------
// The answers of Channels, read strictly (pure). Anything not as documented is
// unknown, never a 0:
//
//   GET  :8089/api/v1/jobs   Server API (documented): the scheduled recordings
//        [{ id, name, start_time, end_time (s), skipped, failed, ... }]
//   GET  :8089/dvr           not in the Server API pages; read by the Channels
//        community (Home Assistant `rest` sensors): { disk: { free, total,
//        used } } in bytes. A secondary reading: its failure never blocks
//        the jobs.
//   GET  :57000/api/status   Client API (documented), also the answer of every
//        command: { status: playing | paused | stopped, muted, channel:
//        { number, name }, now_playing: { title, episode_title, ... } };
//        null properties are omitted.
// -----------------------------------------------------------------------------

import { LIMITS, PLAYBACK } from '../constants.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** A text of Channels for a text state: control characters out, capped. */
export function cleanText(value, max = LIMITS.TEXT) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The time of a `Date` header, in ms, or null when absent or unreadable. */
export function parseDateHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (
    typeof raw !== 'string' ||
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)
  ) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** A time of the Server API: whole seconds since 1970, between 2001 and 2286. */
const isSeconds = (value) => Number.isSafeInteger(value) && value >= 1e9 && value < 1e10;

/**
 * The recordings at the server's time `nowMs`:
 * { recording, upcoming, recordingTitle, nextTitle }, or null when the answer
 * is not a list of jobs (or a job that counts has unreadable times).
 */
export function parseJobs(json, nowMs) {
  if (!Array.isArray(json) || json.length > LIMITS.JOBS || !Number.isFinite(nowMs)) return null;
  const now = Math.floor(nowMs / 1000);
  const recording = [];
  let upcoming = 0;
  let next = null;
  for (const job of json) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return null;
    if (job.skipped === true) continue;
    if (job.skipped !== undefined && job.skipped !== false) return null;
    const { start_time: start, end_time: end } = job;
    if (!isSeconds(start) || !isSeconds(end) || end < start) return null;
    const name = cleanText(job.name) || cleanText(job.item?.title);
    if (start <= now && now < end) {
      // A failed job is not recording, even inside its window.
      if (job.failed !== true) recording.push({ start, name });
    } else if (start > now) {
      upcoming += 1;
      if (!next || start < next.start || (start === next.start && name < next.name)) {
        next = { start, name };
      }
    }
  }
  recording.sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : 1));
  const names = recording.map((r) => r.name).filter(Boolean);
  return {
    recording: recording.length,
    upcoming,
    recordingTitle: names.length > 0 ? cleanText(names.join(', ')) : null,
    nextTitle: next ? next.name || null : null,
  };
}

const isBytes = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.DISK_MAX_BYTES;

/** { free, used } in bytes, or null. `used` is total - free when not given. */
export function parseDvr(json) {
  const disk = json && typeof json === 'object' && !Array.isArray(json) ? json.disk : null;
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return null;
  const { free, total } = disk;
  if (!isBytes(free) || !isBytes(total) || total === 0 || free > total) return null;
  const used = disk.used === undefined ? total - free : disk.used;
  if (!isBytes(used) || used > total) return null;
  return { free, used };
}

const STATUS = Object.freeze({
  playing: PLAYBACK.PLAYING,
  paused: PLAYBACK.PAUSED,
  stopped: PLAYBACK.IDLE,
});

/** A channel number of Channels ("512", "12.1") as a number, or null. */
export function parseChannelNumber(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,9}(\.\d{1,3})?$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= LIMITS.CHANNEL_MAX ? n : null;
}

/**
 * The status model: { playback, muted, channel: { number, name } | null, title }
 * (`playback` or `muted` null when unknown), or null when it is not one.
 */
export function parseStatus(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (typeof json.status !== 'string') return null;
  const playback = Object.hasOwn(STATUS, json.status) ? STATUS[json.status] : null;
  const muted = typeof json.muted === 'boolean' ? json.muted : null;
  let channel = null;
  const c = json.channel;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const number = parseChannelNumber(c.number);
    if (number !== null) channel = { number, name: cleanText(c.name, LIMITS.TEXT) };
  }
  let title = '';
  const n = json.now_playing;
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    const main = cleanText(n.title);
    const episode = cleanText(n.episode_title);
    title = cleanText(main && episode ? `${main} — ${episode}` : main || episode);
  }
  return { playback, muted, channel, title };
}
