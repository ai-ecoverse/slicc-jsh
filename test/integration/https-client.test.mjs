import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, withJsh, wrapCommandMain } from './helpers.mjs';

describe('https client (ctx.fetch)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile(
      '/node_modules/fakefetch/package.json',
      JSON.stringify({ name: 'fakefetch', version: '1.0.0', type: 'module', slicc: { commands: { fakefetch: { abi: 'js', module: 'index.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/fakefetch/index.mjs',
      wrapCommandMain(
        'node',
        `export default function fakefetch(ctx) {
  const fetch = (...args) => globalThis.__fetch(...args);
  return __main(new Proxy({}, { get: (_, key) => (key === 'fetch' ? fetch : ctx[key]), has: (_, key) => key in ctx }));
}
`
      )
    );
  });
  after(() => jsh?.close());

  async function run(script) {
    await jsh.kernel.writeFile('/os/https-client.js', `const https = require('https');\nconst done = (v) => console.log(JSON.stringify(v));\n${script}`);
    const r = await jsh.run(['fakefetch', 'https-client.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  }

  it('sends exactly once from get()/end()', async () => {
    const out = await run(`let fetches = 0;
globalThis.__fetch = async () => {
  fetches += 1;
  return new Response('ok', { status: 200, statusText: 'OK' });
};
https.get('https://example.test/', (res) => {
  res.on('data', () => {});
  res.on('end', () => setTimeout(() => done(fetches), 10));
});`);
    assert.equal(out, 1);
  });

  it('merges setHeader into the fetch headers', async () => {
    const out = await run(`let seen;
globalThis.__fetch = async (_url, init) => {
  seen = init.headers;
  return new Response('', { status: 200 });
};
const req = https.request('https://example.test/x', { method: 'POST' }, (res) => {
  res.on('data', () => {});
  res.on('end', () => done({ seen, auth, removed }));
});
req.setHeader('Authorization', 'Bearer tok');
req.setHeader('Content-Type', 'application/json');
const auth = req.getHeader('authorization');
req.removeHeader('content-type');
const removed = req.getHeader('content-type') === undefined;
req.setHeader('Content-Type', 'text/plain');
req.end('hi');`);
    assert.equal(out.auth, 'Bearer tok');
    assert.equal(out.removed, true);
    assert.equal(out.seen.authorization, 'Bearer tok');
    assert.equal(out.seen['content-type'], 'text/plain');
  });

  it('passes redirect: manual when supported', async () => {
    const out = await run(`let seen;
globalThis.__fetch = async (_url, init) => {
  seen = init.redirect;
  return new Response('', { status: 302, headers: { location: 'https://example.test/other' } });
};
https.get('https://example.test/', (res) => {
  res.resume();
  done({ redirect: seen, status: res.statusCode });
});`);
    assert.deepEqual(out, { redirect: 'manual', status: 302 });
  });

  it('falls back to redirect: follow on ENOTSUP (browser transport)', async () => {
    const out = await run(`const seen = [];
globalThis.__fetch = async (_url, init) => {
  seen.push(init.redirect);
  if (init.redirect === 'manual') {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('redirect: manual'), { code: 'ENOTSUP' });
    throw err;
  }
  return new Response('ok', { status: 200 });
};
const get = () =>
  new Promise((resolve, reject) => {
    const req = https.get('https://example.test/', (res) => {
      resolve(res.statusCode);
      res.resume();
    });
    req.on('error', reject);
  });
(async () => {
  const first = await get();
  const afterFirst = [...seen];
  const second = await get();
  done({ first, afterFirst, second, seen });
})();`);
    assert.deepEqual(out, { first: 200, afterFirst: ['manual', 'follow'], second: 200, seen: ['manual', 'follow', 'follow'] });
  });

  it('destroy()/abort() cancel via AbortSignal', async () => {
    const out = await run(`let aborted = false;
globalThis.__fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
const req = https.get('https://example.test/slow');
req.on('error', () => {});
req.on('close', () => done(aborted));
setTimeout(() => req.abort(), 5);`);
    assert.equal(out, true);
  });

  it('setTimeout emits timeout', async () => {
    const out = await run(`globalThis.__fetch = (_url, init) =>
  new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
const req = https.get('https://example.test/hang');
req.on('error', () => {});
req.setTimeout(20, () => {
  req.destroy();
  done('timeout');
});`);
    assert.equal(out, 'timeout');
  });

  it("sends Node's URL, method, headers and body", async () => {
    const out = await run(`const seen = [];
globalThis.__fetch = async (url, init) => {
  seen.push({
    url,
    method: init.method,
    headers: Object.entries(init.headers),
    body: init.body === undefined ? undefined : Buffer.from(init.body).toString(),
    redirect: init.redirect,
    signal: init.signal instanceof AbortSignal,
  });
  return new Response('ok');
};
const go = (make) =>
  new Promise((resolve, reject) => {
    const req = make((res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
  });
(async () => {
  await go((cb) => {
    const req = https.request(
      'https://example.test:8443/p?q=1',
      { method: 'post', headers: { 'X-A': ['1', '2'], 'X-Num': 5, 'X-Null': null, Host: 'other', 'Content-Length': '3' } },
      cb
    );
    req.setHeader('Authorization', 't');
    req.write('ab');
    req.end('c');
    return req;
  });
  await go((cb) => https.get('https://example.test/', { headers: new Headers({ 'X-H': 'v' }) }, cb));
  await go((cb) => https.request({ hostname: 'example.test', path: '/o', method: 'put' }, cb).end());
  await go((cb) => https.get({ host: '2001:db8::1', port: 443 }, cb));
  await go((cb) => https.get({ hostname: 'example.test', port: '444', path: '/x' }, cb));
  let undef;
  try {
    https.request('https://example.test/', { headers: { 'X-Undef': undefined } });
  } catch (err) {
    undef = [err.code, err.message];
  }
  done({ seen, undef });
})();`);
    assert.deepEqual(out.seen, [
      {
        url: 'https://example.test:8443/p?q=1',
        method: 'POST',
        headers: [
          ['x-a', '1, 2'],
          ['x-num', '5'],
          ['x-null', 'null'],
          ['authorization', 't'],
        ],
        body: 'abc',
        redirect: 'manual',
        signal: true,
      },
      { url: 'https://example.test/', method: 'GET', headers: [], redirect: 'manual', signal: true },
      { url: 'https://example.test/o', method: 'PUT', headers: [], redirect: 'manual', signal: true },
      { url: 'https://[2001:db8::1]/', method: 'GET', headers: [], redirect: 'manual', signal: true },
      { url: 'https://example.test:444/x', method: 'GET', headers: [], redirect: 'manual', signal: true },
    ]);
    assert.deepEqual(out.undef, ['ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid value "undefined" for header "X-Undef"']);
  });

  it('is an http.ClientRequest: finish, response, then close; an error, then close', async () => {
    const out = await run(`globalThis.__fetch = async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (url.includes('fail')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  return new Response('body', { status: 201 });
};
const events = [];
const req = https.get('https://example.test/', (res) => {
  events.push('response ' + res.statusCode + ' ' + (res.req === req));
  res.on('data', (d) => events.push('data ' + d));
  res.on('end', () => events.push('end'));
});
const other = https.request('https://example.test/');
other.on('error', () => {});
const shape = [Object.getPrototypeOf(req) === Object.getPrototypeOf(other), req.constructor.name, req.agent === https.globalAgent, typeof req.getHeaderNames];
other.destroy();
req.on('finish', () => events.push('finish'));
req.on('close', () => {
  events.push('close');
  const failed = [];
  const bad = https.get('https://example.test/fail');
  bad.on('error', (err) => failed.push('error ' + err.code));
  bad.on('close', () => {
    failed.push('close');
    done({ shape, events, failed });
  });
});`);
    assert.deepEqual(out, {
      shape: [true, 'ClientRequest', true, 'function'],
      events: ['finish', 'response 201 true', 'data body', 'end', 'close'],
      failed: ['error ECONNRESET', 'close'],
    });
  });

  it('throws ERR_NOT_SUPPORTED for client cert / ca options', async () => {
    const opts = kernelAtLeast('1.124.13') ? ['pfx'] : kernelAtLeast('1.124.0') ? ['cert', 'key', 'pfx'] : ['cert', 'key', 'pfx', 'ca'];
    const out = await run(`globalThis.__fetch = async () => new Response('');
const codes = [];
for (const opt of ${JSON.stringify(opts)}) {
  try {
    https.request({ hostname: 'x', [opt]: 'dummy' });
    codes.push(opt + ' ok');
  } catch (err) {
    codes.push(opt + ' ' + err.code);
  }
}
done(codes);`);
    assert.deepEqual(out, opts.map((opt) => `${opt} ERR_NOT_SUPPORTED`));
  });
});
