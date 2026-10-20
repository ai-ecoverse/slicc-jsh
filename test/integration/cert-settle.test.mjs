import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { settle } from '../../scripts/cert-review/settle.mjs';

describe('settle: the release verify waits on the registry, not a fixed lag', () => {
  let server;
  let base;
  const hits = {};
  before(async () => {
    server = createServer((req, res) => {
      hits[req.url] = (hits[req.url] ?? 0) + 1;
      if (req.url === '/lag') return res.writeHead(200).end(JSON.stringify({ latest: hits[req.url] < 4 ? '1.2.2' : '1.2.3' }));
      if (req.url === '/newer') return res.writeHead(200).end(JSON.stringify({ latest: '1.3.0' }));
      if (req.url === '/never') return res.writeHead(404).end();
      if (req.url === '/silent') return undefined;
      res.writeHead(500).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const latest = async (res) => {
    const tag = (await res.json()).latest;
    if (tag === '1.2.3') return { done: true, value: tag };
    if (tag === '1.3.0') return { fail: `npm latest is ${tag}, newer than 1.2.3` };
    return { seen: `npm latest is ${tag}, not 1.2.3` };
  };
  const opts = (ms) => ({ deadline: Date.now() + ms, pollMs: 10, quietMs: 2000 });

  it('a latest that lags behind the publish is waited for until it moves', async () => {
    assert.equal(await settle('latest', `${base}/lag`, latest, opts(30_000)), '1.2.3');
    assert.equal(hits['/lag'], 4);
  });

  it('a newer latest fails at once: waiting cannot fix it', async () => {
    const t0 = Date.now();
    await assert.rejects(settle('latest', `${base}/newer`, latest, opts(30_000)), /^Error: latest: npm latest is 1\.3\.0, newer than 1\.2\.3$/);
    assert.equal(hits['/newer'], 1);
    assert.ok(Date.now() - t0 < 5000);
  });

  it('a version that never appears fails at the outer bound and says what the registry last said', async () => {
    const seen = async (res) => ({ seen: `${res.status}` });
    await assert.rejects(settle('pkg@1.2.3', `${base}/never`, seen, opts(300)), /^Error: pkg@1\.2\.3: not there after \d+ s: 404 \(http:\/\/127\.0\.0\.1:\d+\/never\)$/);
    assert.ok(hits['/never'] > 1);
  });

  it('a registry that stops answering fails on the quiet window, before the outer bound', async () => {
    const t0 = Date.now();
    await assert.rejects(
      settle('pkg@1.2.3', `${base}/silent`, latest, { deadline: Date.now() + 60_000, pollMs: 10, quietMs: 500 }),
      /^Error: pkg@1\.2\.3: the registry has not answered for \d+ s: no answer \(.*\) \(http:\/\/127\.0\.0\.1:\d+\/silent\)$/
    );
    assert.ok(Date.now() - t0 < 10_000);
  });
});
