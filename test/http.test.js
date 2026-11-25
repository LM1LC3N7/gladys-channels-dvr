// -----------------------------------------------------------------------------
// The transport against real loopback sockets: answers, caps, deadlines, and
// whether a failure may have reached the app (`sent`).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { CODES, httpRequest } from '../src/channels/http.js';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return { host: '127.0.0.1', port: server.address().port };
}

const options = { timeout: 1_000, maxBytes: 1_000 };

test('GET: status, headers and body; Accept JSON; no keep-alive', async (t) => {
  const seen = [];
  const target = await listen(
    t,
    http.createServer((req, res) => {
      seen.push([req.method, req.url, req.headers.accept, req.headers.connection]);
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"playing"}');
    }),
  );
  const response = await httpRequest(target, '/api/status', options);
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), '{"status":"playing"}');
  assert.ok(response.headers.date);
  assert.deepEqual(seen, [['GET', '/api/status', 'application/json', 'close']]);
});

test('POST without body; a redirect is not followed', async (t) => {
  const seen = [];
  const target = await listen(
    t,
    http.createServer((req, res) => {
      seen.push([req.method, req.url, req.headers['content-length']]);
      res.writeHead(302, { location: 'http://example.com/' });
      res.end();
    }),
  );
  const response = await httpRequest(target, '/api/pause', { ...options, method: 'POST' });
  assert.equal(response.status, 302);
  assert.deepEqual(seen, [['POST', '/api/pause', '0']]);
});

test('size cap: a declared length above it, and a streamed body, cut before the end', async (t) => {
  let ended = false;
  const target = await listen(
    t,
    http.createServer((req, res) => {
      if (req.url === '/declared') {
        res.setHeader('content-length', '5000');
        res.write('x'.repeat(100));
        return;
      }
      // Streamed forever: the client must cut it.
      const timer = setInterval(() => res.write('x'.repeat(400)), 5);
      res.on('close', () => {
        clearInterval(timer);
        ended = true;
      });
    }),
  );
  await assert.rejects(httpRequest(target, '/declared', options), { code: CODES.TOO_LARGE });
  await assert.rejects(httpRequest(target, '/stream', options), { code: CODES.TOO_LARGE });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(ended, 'the connection is closed');
});

test('refused port: nothing sent', async (t) => {
  const server = net.createServer();
  const target = await listen(t, server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(httpRequest(target, '/api/status', options), {
    code: CODES.REFUSED,
    sent: false,
  });
});

test('accepted, no answer: timeout, may have been sent', async (t) => {
  const target = await listen(
    t,
    net.createServer(() => {}),
  );
  const started = Date.now();
  await assert.rejects(
    httpRequest(target, '/api/pause', { ...options, method: 'POST', timeout: 300 }),
    {
      code: CODES.TIMEOUT,
      sent: true,
    },
  );
  assert.ok(Date.now() - started < 1_000);
});

test('not HTTP: a bad answer, not a crash', async (t) => {
  const target = await listen(
    t,
    net.createServer((socket) => socket.end('SSH-2.0-OpenSSH\r\n')),
  );
  await assert.rejects(httpRequest(target, '/api/status', options), { code: CODES.BAD_ANSWER });
});

test('connection reset mid-answer: may have been sent', async (t) => {
  const target = await listen(
    t,
    net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{"st');
        setTimeout(() => socket.destroy(), 10);
      });
    }),
  );
  await assert.rejects(httpRequest(target, '/api/status', options), (err) => err.sent === true);
});

test('a path Node refuses: rejected, nothing sent, never thrown', async () => {
  await assert.rejects(httpRequest({ host: '127.0.0.1', port: 1 }, '/a\nb', options), {
    sent: false,
  });
});
