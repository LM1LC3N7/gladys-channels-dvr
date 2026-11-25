// -----------------------------------------------------------------------------
// A fake network of Channels: a server (jobs, disk) and players (status,
// commands), behind the transport the app takes (`request(target, path,
// options)`). Every request is recorded. A player can refuse (app closed),
// time out before or after sending, answer late (the command applied after
// its answer), answer an HTTP error or garbage.
// -----------------------------------------------------------------------------

import { ChannelsError, CODES } from '../../src/channels/http.js';

export const SERVER_HOST = '192.168.1.3';
export const NOW = Date.parse('2026-11-25T20:00:00Z');
const S = Math.floor(NOW / 1000);

export const job = (name, startOffsetS, durationS, extra = {}) => ({
  id: `${S + startOffsetS}-1`,
  name,
  start_time: S + startOffsetS,
  end_time: S + startOffsetS + durationS,
  duration: durationS,
  channels: ['512'],
  skipped: false,
  failed: false,
  updated_at: NOW,
  item: { title: name },
  ...extra,
});

export const playing = (number = '552', name = 'TBS HD', title = 'Seinfeld') => ({
  status: 'playing',
  muted: false,
  channel: { number, name, image_url: 'http://tmsimg.fancybits.co/x.png' },
  now_playing: { type: 'tv', title, episode_title: 'The Truth', season_number: 3 },
});

const json = (value, headers = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(value)),
});

export function createFakeChannels({ clock } = {}) {
  const devices = new Map();
  const requests = [];
  const httpDate = () => new Date(clock ? clock.now() : NOW).toUTCString();

  const server = {
    jobs: [
      job('NBC Nightly News', -600, 1800),
      job('Family Feud', 3600, 1800),
      job('Skipped', 7200, 1800, { skipped: true }),
    ],
    disk: { free: 110_477_296_271, total: 499_963_174_912, used: 389_485_878_641 },
    /** null: no Date header. */
    date: () => httpDate(),
    /** route -> 'refused' | 'timeout' | number (HTTP status) | 'garbage' */
    fail: {},
    /** a promise every answer of the server waits for (a slow server) */
    hold: null,
  };
  devices.set(`${SERVER_HOST}:8089`, { kind: 'server', state: server });

  const fake = {
    server,
    requests,
    devices,
    count: (pattern) =>
      requests.filter((r) => pattern.test(`${r.method} ${r.key}${r.path}`)).length,
    addPlayer(host, port = 57000, state = playing()) {
      const player = {
        state: structuredClone(state),
        /** 'ok' | 'refused' | 'timeout' (before sending) | 'lost' (sent, no answer) | number (HTTP) | 'garbage' */
        mode: 'ok',
        /** a command answers the old state, applied at the next status read */
        late: false,
        pending: null,
        /** ms of real latency (scene tests) */
        latencyMs: 0,
        /** the command answers no JSON */
        commandEmpty: false,
        /** commands only: 'ok' | 'lost' (sent, no answer) | number (HTTP status) */
        commandMode: 'ok',
      };
      devices.set(`${host}:${port}`, { kind: 'player', state: player });
      return player;
    },
    async request(target, path, { method = 'GET', timeout } = {}) {
      const key = `${target.host}:${target.port}`;
      requests.push({ key, method, path, timeout });
      const device = devices.get(key);
      if (!device) throw new ChannelsError(CODES.UNREACHABLE, 'EHOSTUNREACH', { sent: false });
      if (device.kind === 'server') {
        if (device.state.hold) await device.state.hold;
        return serverAnswer(device.state, path);
      }
      const p = device.state;
      if (p.latencyMs) await new Promise((resolve) => setTimeout(resolve, p.latencyMs));
      if (p.mode === 'refused')
        throw new ChannelsError(CODES.REFUSED, 'Connection refused', { sent: false });
      if (p.mode === 'timeout')
        throw new ChannelsError(CODES.TIMEOUT, 'No answer within 4 s', { sent: false });
      if (p.mode === 'lost') {
        if (method === 'POST') apply(p, path);
        throw new ChannelsError(CODES.TIMEOUT, 'No answer within 4 s', { sent: true });
      }
      if (typeof p.mode === 'number')
        return { status: p.mode, headers: {}, body: Buffer.from('{}') };
      if (p.mode === 'garbage') return { status: 200, headers: {}, body: Buffer.from('<html>') };
      if (method === 'GET' && path === '/api/status') {
        if (p.pending) {
          p.pending();
          p.pending = null;
        }
        return json(p.state);
      }
      if (method === 'POST' && p.commandMode === 'lost') {
        apply(p, path);
        throw new ChannelsError(CODES.TIMEOUT, 'No answer within 2 s', { sent: true });
      }
      if (method === 'POST' && typeof p.commandMode === 'number') {
        return { status: p.commandMode, headers: {}, body: Buffer.from('{}') };
      }
      if (method === 'POST') {
        const before = structuredClone(p.state);
        if (p.late) p.pending = () => apply(p, path);
        else apply(p, path);
        if (p.commandEmpty) return { status: 200, headers: {}, body: Buffer.alloc(0) };
        return json(p.late ? before : p.state);
      }
      return { status: 404, headers: {}, body: Buffer.from('404 page not found') };
    },
  };

  function serverAnswer(state, path) {
    const route = path === '/api/v1/jobs' ? 'jobs' : path === '/dvr' ? 'dvr' : null;
    const failure = state.fail[route];
    if (failure === 'refused')
      throw new ChannelsError(CODES.REFUSED, 'Connection refused', { sent: false });
    if (failure === 'timeout') throw new ChannelsError(CODES.TIMEOUT, 'No answer within 10 s');
    if (typeof failure === 'number')
      return { status: failure, headers: {}, body: Buffer.from('{}') };
    if (failure === 'garbage') return { status: 200, headers: {}, body: Buffer.from('[{') };
    const date = state.date();
    const headers = date ? { date } : {};
    if (route === 'jobs') return json(state.jobs, headers);
    if (route === 'dvr') return json({ disk: state.disk, enabled: true }, headers);
    return { status: 404, headers, body: Buffer.from('404 page not found') };
  }

  return fake;
}

/** What a command does to the state of the fake app. */
function apply(p, path) {
  const s = p.state;
  if (path === '/api/pause' && s.status === 'playing') s.status = 'paused';
  else if (path === '/api/resume' && s.status === 'paused') s.status = 'playing';
  else if (path === '/api/stop') {
    s.status = 'stopped';
    delete s.channel;
    delete s.now_playing;
  } else if (path === '/api/toggle_mute') s.muted = !s.muted;
  else if (path === '/api/channel_up' && s.channel)
    s.channel.number = String(Number(s.channel.number) + 1);
  else if (path === '/api/channel_down' && s.channel)
    s.channel.number = String(Number(s.channel.number) - 1);
  else if (path.startsWith('/api/play/channel/')) {
    const number = decodeURIComponent(path.slice('/api/play/channel/'.length));
    Object.assign(s, playing(number, `Channel ${number}`, 'News'));
  }
}
