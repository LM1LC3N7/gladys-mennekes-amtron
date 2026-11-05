// -----------------------------------------------------------------------------
// PublicInfo over real HTTP (a local server of the kit, real clock): the
// serial number taken, a big answer cut, a wrong answer, a silent server.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parsePublicInfo, readPublicInfo } from '../src/publicinfo.js';

async function server(handler) {
  const srv = createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    port: srv.address().port,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => srv.close(resolve));
    },
  };
}

const read = (port, timeoutMs = 2000) => readPublicInfo({ host: '127.0.0.1', port, timeoutMs });

test('the serial number, the article and the firmware; only GET /api/v1/PublicInfo', async (t) => {
  const seen = [];
  const srv = await server((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.accept}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        serialNumber: '1234567890',
        articleName: 'AMTRON 4You 560',
        currentVersion: '1.5.21',
        other: 'x',
      }),
    );
  });
  t.after(() => srv.close());
  assert.deepEqual(await read(srv.port), {
    serial: '1234567890',
    article: 'AMTRON 4You 560',
    firmware: '1.5.21',
  });
  assert.deepEqual(seen, ['GET /api/v1/PublicInfo application/json']);
});

test('a big answer is cut before it is all read; wrong answers are refused', async (t) => {
  let sent = 0;
  const srv = await server((req, res) => {
    if (req.url !== '/api/v1/PublicInfo') return res.end();
    res.setHeader('Content-Type', 'application/json');
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => {
      while (sent < 10 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  t.after(() => srv.close());
  await assert.rejects(read(srv.port), { kind: 'too-big' });
  assert.ok(sent < 10 * 1024 * 1024, 'never read whole');
});

test('status, invalid JSON, no serial, silence: refused within the time given', async (t) => {
  let mode = 'status';
  const srv = await server((req, res) => {
    if (mode === 'status') {
      res.statusCode = 404;
      return res.end('{}');
    }
    if (mode === 'json') return res.end('{not json');
    if (mode === 'serial') return res.end(JSON.stringify({ serialNumber: '1 2' }));
    // silent: never answers
  });
  t.after(() => srv.close());
  await assert.rejects(read(srv.port), { kind: 'status' });
  mode = 'json';
  await assert.rejects(read(srv.port), { kind: 'invalid' });
  mode = 'serial';
  await assert.rejects(read(srv.port), { kind: 'invalid' });
  mode = 'silent';
  const started = Date.now();
  await assert.rejects(read(srv.port, 300), { kind: 'timeout' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(parsePublicInfo([]), undefined);
  assert.equal(
    parsePublicInfo({ serialNumber: 'abcd', currentVersion: 'v 1' }).firmware,
    undefined,
  );
});

test('nothing listening: unreachable', async () => {
  const srv = await server(() => {});
  const port = srv.port;
  await srv.close();
  await assert.rejects(read(port), { kind: 'unreachable' });
});
