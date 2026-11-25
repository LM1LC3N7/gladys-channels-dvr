// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized
// (pure). Nothing here is a secret: Channels asks for no credential on the
// local network.
//
//   server_url     `host[:port]` or `http://host[:port]` (8089 by default);
//                  empty: no server device
//   players        `[name=]host[:port]` entries (57000 by default), separated
//                  by commas, semicolons or new lines; 10 at most
//   poll_interval  seconds, one of POLL_INTERVALS
//
// A player is keyed by its address: the Client API of Channels gives no
// identifier (no serial, no MAC), so `ext:<selector>:player:<slug>` is built
// from the host (and the port when it is not 57000), dots and colons turned
// into dashes. A new address is a new device (documented: reserve the IP).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVALS, PORTS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  poll_interval: '30',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HOST_NAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** An IPv4 address no device can have: unspecified, broadcast, multicast. */
function badIPv4(address) {
  const [a, , , d] = address.split('.').map(Number);
  return a === 0 || (a >= 224 && a <= 239) || (a === 255 && d === 255) || a >= 240;
}

/** An IPv6 address no device can have: unspecified, multicast. */
function badIPv6(address) {
  // The URL parser writes it compressed: `0:0::0` -> `[::]`.
  const compressed = new URL(`http://[${address}]`).hostname;
  return compressed === '[::]' || compressed.startsWith('[ff');
}

/**
 * `host[:port]`, with or without `http://`, a port given or `defaultPort`.
 *   -> { host, port, origin } or { error: 'empty' | 'invalid' | 'https' }
 */
export function parseAddress(value, defaultPort) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  if (CONTROL.test(raw) || /\s/.test(raw)) return { error: 'invalid' };
  if (/^https:\/\//i.test(raw)) return { error: 'https' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^http:\/\//i.test(raw)) return { error: 'invalid' };
  const rest = hasScheme ? raw.slice(raw.indexOf('//') + 2) : raw;
  // Nothing after the address but an optional slash: no path, query, credentials.
  const match = /^(\[[0-9a-fA-F:.]+\]|[^/:[\]@?#]+)(?::(\d{1,5}))?\/?$/.exec(rest);
  if (!match) return { error: 'invalid' };
  let host = match[1].toLowerCase();
  const bracketed = host.startsWith('[');
  if (bracketed) host = host.slice(1, -1);
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };
  const family = isIP(host);
  if (family === 4 && badIPv4(host)) return { error: 'invalid' };
  if (family === 6 && (!bracketed || badIPv6(host))) return { error: 'invalid' };
  if (family === 0 && (bracketed || !HOST_NAME.test(host) || /^[\d.]+$/.test(host))) {
    return { error: 'invalid' };
  }
  const shown = family === 6 ? `[${host}]` : host;
  return { host, port, origin: `http://${shown}:${port}` };
}

/** The frozen id of a player: its host, and its port when not the default. */
export function playerId({ host, port }) {
  const slug = host.replace(/[.:]/g, '-');
  return port === PORTS.PLAYER ? slug : `${slug}-${port}`;
}

/** A name typed by the user, or a readable default. */
function playerName(name, address) {
  const clean = text(name)
    .replace(new RegExp(CONTROL.source, 'g'), '')
    .slice(0, LIMITS.NAME)
    .trim();
  return clean || `Channels ${address.host}`;
}

/**
 * The players: `[{ id, name, host, port, origin }]` (10 at most) and the
 * number of entries refused (invalid, duplicate, beyond 10).
 */
export function parsePlayers(value) {
  const players = [];
  const ids = new Set();
  let invalid = 0;
  const entries = text(value)
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const equal = entry.lastIndexOf('=');
    const name = equal >= 0 ? entry.slice(0, equal) : '';
    const address = parseAddress(equal >= 0 ? entry.slice(equal + 1) : entry, PORTS.PLAYER);
    if (address.error) {
      invalid += 1;
      continue;
    }
    const id = playerId(address);
    if (ids.has(id) || players.length >= LIMITS.PLAYERS) {
      invalid += 1;
      continue;
    }
    ids.add(id);
    players.push({ id, name: playerName(name, address), ...address });
  }
  return { players, invalid };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const server = parseAddress(raw.server_url, PORTS.SERVER);
  const { players, invalid } = parsePlayers(raw.players);
  const interval = POLL_INTERVALS.includes(String(raw.poll_interval))
    ? String(raw.poll_interval)
    : DEFAULTS.poll_interval;
  return {
    server: server.error ? null : server,
    serverError: server.error === 'empty' ? null : (server.error ?? null),
    players,
    invalidPlayers: invalid,
    pollMs: Number(interval) * 1000,
  };
}
