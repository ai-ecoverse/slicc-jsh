import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeStream from 'node:stream';
import { createHttp } from '../../src/runtime/builtins/http.mjs';
import { createHttps as createHttpsWith } from '../../src/runtime/builtins/https.mjs';
import { createNet } from '../../src/runtime/builtins/net.mjs';
import { createTls } from '../../src/runtime/builtins/tls.mjs';

// https over jsh's own http, net and tls, with ctx's fetch.
function createHttps({ ctx, Buffer }) {
  const handles = new Set();
  handles.notify = () => {};
  const getStream = () => nodeStream;
  const net = createNet({ ctx, process, Buffer, handles, getStream });
  const http = createHttp({ ctx, process, Buffer, handles, getStream, net });
  const tls = createTls({ ctx, process, Buffer, net, getCrypto: () => ({}) });
  return createHttpsWith({ ctx, Buffer, http, handles, getTls: () => tls });
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
    const https = createHttps({ ctx, Buffer });
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
    const https = createHttps({ ctx, Buffer });
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
    const https = createHttps({ ctx, Buffer });
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
    const https = createHttps({ ctx, Buffer });
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
    const https = createHttps({ ctx, Buffer });
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
    const https = createHttps({ ctx, Buffer });
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

  it('sends what it sent before it was an http.ClientRequest: URL, method, headers and body', async () => {
    const seen = [];
    const ctx = {
      fetch: async (url, init) => {
        seen.push({
          url,
          method: init.method,
          headers: Object.entries(init.headers),
          body: init.body === undefined ? undefined : Buffer.from(init.body).toString(),
          redirect: init.redirect,
          signal: init.signal instanceof AbortSignal,
        });
        return new Response('ok');
      },
    };
    const https = createHttps({ ctx, Buffer });
    const run = (make) =>
      new Promise((resolve, reject) => {
        const req = make((res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
      });
    await run((cb) => {
      const req = https.request(
        'https://example.test:8443/p?q=1',
        { method: 'post', headers: { 'X-A': ['1', '2'], 'X-Num': 5, 'X-Null': null, 'X-Undef': undefined, Host: 'other', 'Content-Length': '3' } },
        cb
      );
      req.setHeader('Authorization', 't');
      req.write('ab');
      req.end('c');
      return req;
    });
    await run((cb) => https.get('https://example.test/', { headers: new Headers({ 'X-H': 'v' }) }, cb));
    await run((cb) => https.request({ hostname: 'example.test', path: '/o', method: 'put' }, cb).end());
    await run((cb) => https.get({ host: '2001:db8::1', port: 443 }, cb));
    await run((cb) => https.get({ hostname: 'example.test', port: '444', path: '/x' }, cb));
    assert.deepEqual(seen, [
      {
        url: 'https://example.test:8443/p?q=1',
        method: 'POST',
        headers: [
          ['x-a', '1, 2'],
          ['x-num', '5'],
          ['authorization', 't'],
        ],
        body: 'abc',
        redirect: 'manual',
        signal: true,
      },
      { url: 'https://example.test/', method: 'GET', headers: [['x-h', 'v']], body: undefined, redirect: 'manual', signal: true },
      { url: 'https://example.test/o', method: 'PUT', headers: [], body: undefined, redirect: 'manual', signal: true },
      { url: 'https://[2001:db8::1]/', method: 'GET', headers: [], body: undefined, redirect: 'manual', signal: true },
      { url: 'https://example.test:444/x', method: 'GET', headers: [], body: undefined, redirect: 'manual', signal: true },
    ]);
  });

  it('is an http.ClientRequest: finish, response, then close; an error, then close', async () => {
    const https = createHttps({
      ctx: {
        fetch: async (url) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (url.includes('fail')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
          return new Response('body', { status: 201 });
        },
      },
      Buffer,
    });
    const events = [];
    const req = https.get('https://example.test/', (res) => {
      events.push(`response ${res.statusCode} ${res.req === req}`);
      res.on('data', (d) => events.push(`data ${d}`));
      res.on('end', () => events.push('end'));
    });
    assert.equal(Object.getPrototypeOf(req), Object.getPrototypeOf(https.request('https://example.test/')));
    assert.equal(req.constructor.name, 'ClientRequest');
    assert.equal(req.agent, https.globalAgent);
    assert.equal(typeof req.getHeaderNames, 'function');
    req.on('finish', () => events.push('finish'));
    await new Promise((resolve) => req.on('close', resolve));
    events.push('close');
    assert.deepEqual(events, ['finish', 'response 201 true', 'data body', 'end', 'close']);
    const failed = [];
    const bad = https.get('https://example.test/fail');
    bad.on('error', (err) => failed.push(`error ${err.code}`));
    await new Promise((resolve) => bad.on('close', resolve));
    failed.push('close');
    assert.deepEqual(failed, ['error ECONNRESET', 'close']);
  });

  it('throws ERR_NOT_SUPPORTED for client cert / ca options', () => {
    const https = createHttps({ ctx: { fetch: async () => new Response('') }, Buffer });
    for (const opt of ['cert', 'key', 'pfx', 'ca']) {
      assert.throws(
        () => https.request({ hostname: 'x', [opt]: 'dummy' }),
        (err) => err.code === 'ERR_NOT_SUPPORTED'
      );
    }
  });
});
