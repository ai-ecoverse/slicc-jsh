import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeStream from 'node:stream';
import { Readable } from 'node:stream';
import { createHttps } from '../../src/runtime/builtins/https.mjs';

function makeHttpStub() {
  return {
    IncomingMessage(_socket, body) {
      const r = Readable.from([body ?? Buffer.alloc(0)]);
      r.statusCode = 0;
      r.statusMessage = '';
      r.headers = Object.create(null);
      r.rawHeaders = [];
      return r;
    },
  };
}

describe('https client (ctx.fetch)', () => {
  it('sends exactly once from get()/end()', async () => {
    let fetches = 0;
    const ctx = {
      fetch: async () => {
        fetches += 1;
        return new Response('ok', { status: 200, statusText: 'OK' });
      },
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    await new Promise((resolve, reject) => {
      const req = https.get('https://example.test/', (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    assert.equal(fetches, 1);
  });

  it('merges setHeader into the fetch headers', async () => {
    let seen;
    const ctx = {
      fetch: async (_url, init) => {
        seen = init.headers;
        return new Response('', { status: 200 });
      },
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    await new Promise((resolve, reject) => {
      const req = https.request('https://example.test/x', { method: 'POST' }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.setHeader('Authorization', 'Bearer tok');
      req.setHeader('Content-Type', 'application/json');
      assert.equal(req.getHeader('authorization'), 'Bearer tok');
      req.removeHeader('content-type');
      assert.equal(req.getHeader('content-type'), undefined);
      req.setHeader('Content-Type', 'text/plain');
      req.end('hi');
    });
    assert.equal(seen.authorization, 'Bearer tok');
    assert.equal(seen['content-type'], 'text/plain');
  });

  it('passes redirect: manual when supported', async () => {
    let seen;
    const ctx = {
      fetch: async (_url, init) => {
        seen = init;
        return new Response('', {
          status: 302,
          headers: { location: 'https://example.test/other' },
        });
      },
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    const status = await new Promise((resolve, reject) => {
      const req = https.get('https://example.test/', (res) => {
        resolve(res.statusCode);
        res.resume();
      });
      req.on('error', reject);
    });
    assert.equal(seen.redirect, 'manual');
    assert.equal(status, 302);
  });

  it('falls back to redirect: follow on ENOTSUP (browser transport)', async () => {
    const seen = [];
    const ctx = {
      fetch: async (_url, init) => {
        seen.push(init.redirect);
        if (init.redirect === 'manual') {
          const err = new TypeError('fetch failed');
          err.cause = Object.assign(new Error('redirect: manual'), { code: 'ENOTSUP' });
          throw err;
        }
        return new Response('ok', { status: 200 });
      },
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    const get = () =>
      new Promise((resolve, reject) => {
        const req = https.get('https://example.test/', (res) => {
          resolve(res.statusCode);
          res.resume();
        });
        req.on('error', reject);
      });
    assert.equal(await get(), 200);
    assert.deepEqual(seen, ['manual', 'follow']);
    // Remembered per process — second request must not probe manual again.
    assert.equal(await get(), 200);
    assert.deepEqual(seen, ['manual', 'follow', 'follow']);
  });

  it('destroy()/abort() cancel via AbortSignal', async () => {
    let aborted = false;
    const ctx = {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    await new Promise((resolve) => {
      const req = https.get('https://example.test/slow');
      req.on('error', () => {});
      req.on('close', resolve);
      setTimeout(() => req.abort(), 5);
    });
    assert.equal(aborted, true);
  });

  it('setTimeout emits timeout', async () => {
    const ctx = {
      fetch: () => new Promise(() => {}),
    };
    const https = createHttps({ ctx, Buffer, http: makeHttpStub(), getStream: () => nodeStream });
    await new Promise((resolve, reject) => {
      const req = https.get('https://example.test/hang');
      req.on('error', () => {});
      req.setTimeout(20, () => {
        req.destroy();
        resolve();
      });
      setTimeout(() => reject(new Error('no timeout')), 200);
    });
  });

  it('throws ERR_NOT_SUPPORTED for client cert / ca options', () => {
    const https = createHttps({
      ctx: { fetch: async () => new Response('') },
      Buffer,
      http: makeHttpStub(),
    });
    for (const opt of ['cert', 'key', 'pfx', 'ca']) {
      assert.throws(
        () => https.request({ hostname: 'x', [opt]: 'dummy' }),
        (err) => err.code === 'ERR_NOT_SUPPORTED'
      );
    }
  });
});
