// Copied from ~/code/ref/gladys-testkit (src/util.mjs, Apache-2.0, same author): reused as is.

// Small shared pieces: listening on loopback, a sleep that `close()` cancels.

import { setTimeout as delay } from 'node:timers/promises';

export const HOST = '127.0.0.1';

/** Listens on 127.0.0.1 (a free port unless given) and resolves the port. */
export function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

/** Resolves once the server is closed (open sockets must be destroyed first). */
export const closed = (server) =>
  new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));

/** A sleep cancelled by `signal`: rejects with an AbortError. */
export const sleep = (ms, signal) =>
  ms > 0 ? delay(ms, undefined, { signal }) : Promise.resolve();

/** A number, or a function of the arguments giving one. */
export const valueOf = (v, ...args) => (typeof v === 'function' ? v(...args) : v) ?? 0;

export const isAbort = (err) => err?.name === 'AbortError';
