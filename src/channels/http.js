// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP request (GET or
// POST without body) to a Channels DVR Server or a Channels app on the local
// network. A deadline for the whole exchange, a size cap on the body (cut as
// soon as it is passed, never read whole), no redirect followed, no keep-alive
// (`agent: false`: one connection per request, one request per connection).
//
// Resolves { status, headers, body } for any HTTP status; rejects a
// ChannelsError. `sent` on the error says whether the request may have reached
// the app: false only when no connection was made (refused, unreachable, a
// connection timeout), so "nothing sent" is said only when it is true.
// -----------------------------------------------------------------------------

import http from 'node:http';

export const CODES = Object.freeze({
  REFUSED: 'refused', // the port is closed: the app (or the server) does not run
  UNREACHABLE: 'unreachable', // no route, no such host, connection reset before sending
  TIMEOUT: 'timeout', // no (whole) answer in time
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected, or not HTTP at all
  TOO_LARGE: 'too_large', // answer above the size cap
});

export class ChannelsError extends Error {
  constructor(code, message, { status, sent = true } = {}) {
    super(message);
    this.name = 'ChannelsError';
    this.code = code;
    this.sent = sent;
    if (status !== undefined) this.status = status;
  }
}

/** A short code of Node (letters, digits, underscores) or nothing: never its message. */
const safeCode = (err) => {
  const code = String(err?.code ?? '');
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : '';
};

function transportError(err, connected) {
  const code = safeCode(err);
  if (code === 'ECONNREFUSED') {
    return new ChannelsError(CODES.REFUSED, 'Connection refused', { sent: false });
  }
  if (code.startsWith('HPE_')) {
    return new ChannelsError(CODES.BAD_ANSWER, `Not an HTTP answer (${code})`);
  }
  return new ChannelsError(CODES.UNREACHABLE, code || 'Connection failed', { sent: connected });
}

/**
 * @param {{ host: string, port: number }} target
 * @param {string} path absolute path, already encoded
 * @param {{ method?: 'GET' | 'POST', timeout: number, maxBytes: number }} options
 */
export function httpRequest(target, path, { method = 'GET', timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let req = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new ChannelsError(CODES.TIMEOUT, `No answer within ${Math.ceil(timeout / 1000)} s`, {
            sent: connected,
          }),
        ),
      timeout,
    );
    try {
      req = http.request(
        {
          method,
          host: target.host,
          port: target.port,
          path,
          agent: false,
          headers: {
            accept: 'application/json',
            ...(method === 'POST' ? { 'content-length': '0' } : {}),
          },
        },
        (res) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            finish(new ChannelsError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              finish(new ChannelsError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err, true)));
          res.on('aborted', () => finish(transportError({ code: 'ECONNRESET' }, true)));
        },
      );
      req.on('socket', (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => (connected = true));
      });
      req.on('error', (err) => finish(transportError(err, connected)));
      req.end();
    } catch (err) {
      // http.request throws synchronously on a path or header it refuses.
      finish(
        new ChannelsError(CODES.UNREACHABLE, safeCode(err) || 'Invalid request', { sent: false }),
      );
    }
  });
}
