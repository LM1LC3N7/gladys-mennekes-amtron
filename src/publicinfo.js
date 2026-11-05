// -----------------------------------------------------------------------------
// The serial number of the charger: `GET http://<host>:<port>/api/v1/PublicInfo`,
// the page of its web interface that needs no login (mennekes-amtron-ha reads
// `serialNumber`, `articleName` and `currentVersion` there). The Modbus map has
// no serial number: this is where the identity of the device comes from.
//
// One request, plain HTTP on the local network, no redirect followed, no
// cookie, no credential. Every wait is bounded (the whole exchange), the
// answer is read up to LIMITS.publicInfoBytes and cut beyond (never kept
// whole in memory), parsed only when complete, and only three short fields
// are kept. Nothing received is ever logged.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from './constants.js';
import { modelOf, serialOf } from './model.js';

export const PUBLIC_INFO_PATH = '/api/v1/PublicInfo';

export class PublicInfoError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** A short version text (firmware), else undefined. */
const versionOf = (value) =>
  typeof value === 'string' && /^[0-9A-Za-z._+-]{1,32}$/.test(value) ? value : undefined;

/** The identity of a PublicInfo answer, or undefined when it has no usable serial number. */
export function parsePublicInfo(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const serial = serialOf(json.serialNumber);
  if (!serial) return undefined;
  return {
    serial,
    article: modelOf(typeof json.articleName === 'string' ? json.articleName : undefined),
    firmware: versionOf(json.currentVersion),
  };
}

/**
 * Reads PublicInfo; resolves `{ serial, article, firmware }`, rejects a
 * PublicInfoError (`unreachable`, `timeout`, `status`, `too-big`, `invalid`).
 * `request` is injectable for the tests (node:http's by default).
 */
export function readPublicInfo({ host, port, timeoutMs, request = httpRequest }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (kind) => {
      done(reject, new PublicInfoError(kind, kind));
      req?.destroy();
    };
    // Once settled, nothing more is read (a late chunk of a destroyed answer is dropped).
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    try {
      req = request(
        {
          host,
          port,
          path: PUBLIC_INFO_PATH,
          method: 'GET',
          headers: { Accept: 'application/json', Connection: 'close' },
          agent: false,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            fail('status');
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > LIMITS.publicInfoBytes) {
            fail('too-big');
            res.destroy();
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > LIMITS.publicInfoBytes) {
              fail('too-big');
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            let json;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              fail('invalid');
              return;
            }
            const info = parsePublicInfo(json);
            if (!info) {
              fail('invalid');
              return;
            }
            done(resolve, info);
          });
          res.on('error', () => fail('unreachable'));
          res.on('aborted', () => fail('unreachable'));
        },
      );
    } catch {
      fail('unreachable');
      return;
    }
    req.on('error', () => fail('unreachable'));
    req.end();
  });
}
