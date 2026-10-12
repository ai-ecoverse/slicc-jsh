import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { drainLoop } from '../../src/runtime/async-handles.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { createNextTick } from '../../src/runtime/next-tick.mjs';
import { withJsh } from './helpers.mjs';

describe('drainLoop with a pending entry', () => {
  it('runs nextTick while the entry is pending and ends once nothing is ref’d', async () => {
    const handles = createHandleTable();
    const nextTick = createNextTick();
    const order = [];
    let pending = true;
    nextTick.nextTick(() => order.push('tick'));
    await drainLoop(handles, nextTick, { weakPending: () => pending });
    assert.deepEqual(order, ['tick']);
    pending = false;
  });

  it('keeps waiting while the entry settles within the grace turns', async () => {
    const handles = createHandleTable();
    const nextTick = createNextTick();
    let pending = true;
    let beforeExit = 0;
    setTimeout(() => {
      pending = false;
    }, 0);
    await drainLoop(handles, nextTick, {
      weakPending: () => pending,
      onBeforeExit: () => beforeExit++,
    });
    assert.equal(pending, false);
    assert.equal(beforeExit, 1);
  });
});

describe('event loop and exit (kernel)', () => {
  let jsh;
  let server;
  let url;

  before(async () => {
    jsh = await withJsh();
    server = createServer((req, res) => {
      setTimeout(() => res.end(`slow ${req.url}`), 200);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    jsh?.close();
    server?.close();
  });

  const run = async (name, source, argv) => {
    await jsh.kernel.writeFile(`/os/${name}`, source);
    return jsh.run(argv ?? ['jsh', name], { env: { COMPARE_HTTP: url } });
  };

  it('a floating fetch keeps the program alive until its body is read', async () => {
    const r = await run(
      'floating-fetch.jsh',
      "fetch(process.env.COMPARE_HTTP + '/x').then((r) => r.text()).then((t) => console.log(t));\nconsole.log('body returned');\n"
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'body returned\nslow /x\n');
  });

  it('a floating main() awaiting fetch, then response.body, keeps the program alive', async () => {
    const r = await run(
      'floating-body.jsh',
      [
        'async function main() {',
        "  const res = await fetch(process.env.COMPARE_HTTP + '/y');",
        '  let text = "";',
        '  for await (const chunk of res.body) text += new TextDecoder().decode(chunk);',
        '  console.log(text);',
        '}',
        'main();',
        '',
      ].join('\n')
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'slow /y\n');
  });

  it('a pending WebCrypto digest keeps the program alive', async () => {
    const r = await run(
      'digest.jsh',
      "crypto.subtle.digest('SHA-256', new Uint8Array(1 << 20)).then((d) => console.log(d.byteLength));\n"
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '32\n');
  });

  it('process.exit() leaves no stray report on stderr', async () => {
    const r = await run(
      'stray.jsh',
      "async function main() { await null; process.exit(0); }\nmain().catch((e) => { console.error('error:', e.message); process.exit(1); });\n"
    );
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('an ES module whose top-level await never settles exits 13 with the warning', async () => {
    const r = await run('tla.mjs', "console.log('before');\nawait new Promise(() => {});\n", [
      'node',
      'tla.mjs',
    ]);
    assert.equal(r.status, 13);
    assert.equal(r.stdout, 'before\n');
    assert.match(r.stderr, /^Warning: Detected unsettled top-level await at file:\/\/\/os\/tla\.mjs/);
  });
});
