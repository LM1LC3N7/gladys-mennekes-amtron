// Copied from ~/code/ref/gladys-testkit (src/tcp.mjs, Apache-2.0, same author): reused as is.

// A fake TCP device on 127.0.0.1. Each connection is served like a firmware
// loop: read EVERYTHING waiting (pipelined requests arrive glued in one
// chunk), handle it, wait `latencyMs`, answer, read again.

import { createServer } from 'node:net';
import { HOST, closed, isAbort, listen, sleep, valueOf } from './util.mjs';

/**
 * Options (all may be changed later on the returned object):
 * - onConnect(conn): what to send at once (a greeting), or nothing;
 * - onData(chunk, conn): the answer (string | Buffer | nothing; may be a promise);
 * - latencyMs: a number or (chunk, conn) => number, before each answer;
 * - singleClient: a second client is closed at once while one is open;
 * - silentAfter: after this many answers (all connections), the device keeps
 *   reading but answers nothing (`device.silent = true` does the same);
 * - closeAfterBytes: a connection is destroyed once it has received this many bytes.
 */
export async function tcpServer(options = {}) {
  const abort = new AbortController();
  const sockets = new Set();
  const device = {
    onConnect: undefined,
    onData: undefined,
    latencyMs: 0,
    singleClient: false,
    silentAfter: undefined,
    closeAfterBytes: undefined,
    ...options,
    silent: false,
    host: HOST,
    port: 0,
    /** Connections accepted, refused (single client), open now, most open at once. */
    connections: 0,
    refused: 0,
    open: 0,
    peak: 0,
    answers: 0,
    /** Every chunk read: { at, conn, data: Buffer }. */
    received: [],
    /** The received bytes as text (latin1), all connections. */
    text: () => device.received.map((r) => r.data.toString('latin1')).join(''),
    /** Writes to every open connection (an unsolicited push). */
    push(data) {
      for (const socket of sockets) if (!socket.destroyed) socket.write(data);
    },
    async close() {
      abort.abort();
      for (const socket of sockets) socket.destroy();
      await closed(server);
    },
  };
  const quiet = () =>
    device.silent || (device.silentAfter !== undefined && device.answers >= device.silentAfter);

  const serve = async (socket, conn) => {
    const next = () =>
      new Promise((resolve) => {
        const done = () => {
          socket.off('readable', done);
          socket.off('close', done);
          resolve();
        };
        socket.on('readable', done);
        socket.on('close', done);
      });
    try {
      while (!socket.destroyed) {
        const chunk = socket.read();
        if (chunk === null) {
          if (socket.readableEnded) return;
          await next();
          continue;
        }
        conn.bytes += chunk.length;
        device.received.push({ at: performance.now(), conn: conn.id, data: chunk });
        if (device.closeAfterBytes !== undefined && conn.bytes >= device.closeAfterBytes) {
          socket.destroy();
          return;
        }
        const answer = await device.onData?.(chunk, conn);
        await sleep(valueOf(device.latencyMs, chunk, conn), abort.signal);
        if (answer != null && !quiet() && !socket.destroyed) {
          device.answers += 1;
          socket.write(answer);
        }
      }
    } catch (err) {
      if (!isAbort(err)) socket.destroy(err);
    }
  };

  const server = createServer((socket) => {
    socket.on('error', () => {});
    if (device.singleClient && device.open >= 1) {
      device.refused += 1;
      socket.destroy();
      return;
    }
    sockets.add(socket);
    device.connections += 1;
    device.open += 1;
    device.peak = Math.max(device.peak, device.open);
    const conn = {
      id: device.connections,
      socket,
      bytes: 0,
      write: (data) => !socket.destroyed && socket.write(data),
      end: () => socket.end(),
      destroy: () => socket.destroy(),
    };
    socket.on('close', () => {
      sockets.delete(socket);
      device.open -= 1;
    });
    const greeting = device.onConnect?.(conn);
    if (greeting != null) socket.write(greeting);
    serve(socket, conn);
  });
  device.port = await listen(server, options.port);
  return device;
}
