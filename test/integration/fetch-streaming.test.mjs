import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// A loopback fetch streams (the kernel's sockets, jsh's http client): it
// resolves at the response's head and reads the body as it comes, so a
// never-ending SSE stream (mcpcat's MCP over SSE) can be read and aborted.
// The golden http-streaming-node22 pins the output against Node.
describe('loopback fetch streams (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("lets a followed redirect's own never-ending body go (the server sees it close)", async () => {
    // Node's undici keeps reading such a body, so the program never ends;
    // jsh closes it once it follows the redirect.
    const source = [
      "const http = require('http');",
      'const srv = http.createServer((req, res) => {',
      "  if (req.url === '/final') return res.end('final');",
      "  res.writeHead(302, { location: '/final' });",
      "  const tick = setInterval(() => res.write('.'), 10);",
      "  res.on('close', () => { clearInterval(tick); console.log('server: redirect body closed'); });",
      '});',
      "srv.listen(0, '127.0.0.1', async () => {",
      '  const r = await fetch(`http://127.0.0.1:${srv.address().port}/redirect`);',
      "  console.log('followed', new URL(r.url).pathname, await r.text());",
      '  setTimeout(() => srv.close(), 100);',
      '});',
    ].join('\n');
    await jsh.kernel.writeFile('/os/redirect.js', source);
    const r = await jsh.run(['node', 'redirect.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /followed \/final final\n/);
    assert.match(r.stdout, /server: redirect body closed\n/);
  });

  it('an abort still reaches the body after a garbage collection (the Request is held, as Node holds it)', async () => {
    // The body listened on the Request's signal, which follows the
    // program's through a WeakRef to the Request's own controller (undici).
    // Nothing held the Request once the response came, so after a GC the
    // abort no longer reached the body: the read after it got the next event
    // (the golden http-streaming-node22 flaked so on CI). The garbage here
    // forces the GC: before the fix, 'read resolved' every time.
    const source = [
      "const http = require('http');",
      'const srv = http.createServer((req, res) => {',
      "  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();",
      '  let n = 0; const t = setInterval(() => res.write(`data: ${++n}\\n\\n`), 20);',
      "  res.on('close', () => { clearInterval(t); console.log('server: went away'); });",
      '});',
      "srv.listen(0, '127.0.0.1', async () => {",
      '  const ac = new AbortController();',
      '  const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: ac.signal });',
      '  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();',
      '  await reader.read();',
      // About 240 MB held, then let go: a full collection, not only a scavenge.
      '  let junk = []; for (let i = 0; i < 300; i++) junk.push(new Array(100000).fill(i)); junk = null;',
      '  for (let i = 0; i < 300; i++) new Array(100000).fill(i);',
      '  ac.abort();',
      "  try { const v = await reader.read(); console.log('read resolved', JSON.stringify(v)); } catch (e) { console.log('read after abort', e.name); }",
      // Before the fix nothing ended the stream: close it from the server.
      '  srv.close(); srv.closeAllConnections();',
      '});',
    ].join('\n');
    await jsh.kernel.writeFile('/os/abort-gc.js', source);
    const r = await jsh.run(['node', 'abort-gc.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'read after abort AbortError\nserver: went away\n');
  });

  it('a chunk that arrived before the abort is not read after it: the read rejects, as Node gives it', async () => {
    // The 4th event arrives while the program waits, before ac.abort(). Node
    // errors the body on abort, which clears what it had queued, so the next
    // read rejects. jsh's tracked body read one chunk ahead into a stream of
    // its own, so that read got event 4 (#241).
    const source = [
      "const http = require('http');",
      'const srv = http.createServer((req, res) => {',
      "  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();",
      "  for (let n = 1; n <= 4; n++) setTimeout(() => res.write(`data: ${n}\\n\\n`), n < 4 ? 20 * n : 75);",
      "  res.on('close', () => console.log('server: went away'));",
      '});',
      "srv.listen(0, '127.0.0.1', async () => {",
      '  const ac = new AbortController();',
      '  const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: ac.signal });',
      '  const reader = r.body.getReader();',
      '  const td = new TextDecoder();',
      "  let got = '';",
      "  while ((got.match(/\\n\\n/g) || []).length < 3) got += td.decode((await reader.read()).value);",
      '  await new Promise((r) => setTimeout(r, 300));',
      '  ac.abort();',
      "  try { const v = await reader.read(); console.log('read resolved', JSON.stringify(td.decode(v.value))); } catch (e) { console.log('read after abort', e.name); }",
      '  srv.close(); srv.closeAllConnections();',
      '});',
    ].join('\n');
    await jsh.kernel.writeFile('/os/abort-queued.js', source);
    const r = await jsh.run(['node', 'abort-queued.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'read after abort AbortError\nserver: went away\n');
  });

  it('reads 3 events of a never-ending SSE stream, aborts, and the server sees the client go', async () => {
    const source = [
      "const http = require('http');",
      'const srv = http.createServer((req, res) => {',
      "  res.writeHead(200, { 'content-type': 'text/event-stream' });",
      '  res.flushHeaders();',
      '  let n = 0;',
      '  const tick = setInterval(() => res.write(`data: ${++n}\\n\\n`), 10);',
      "  res.on('close', () => { clearInterval(tick); console.log('server: closed'); srv.close(); });",
      '});',
      "srv.listen(0, '127.0.0.1', async () => {",
      '  const ac = new AbortController();',
      // Guard: a fetch that waited for the end of the body would never resolve.
      "  const guard = setTimeout(() => { console.log('fetch never resolved'); process.exit(3); }, 5000);",
      '  const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: ac.signal });',
      '  clearTimeout(guard);',
      '  const reader = r.body.getReader();',
      '  const dec = new TextDecoder();',
      "  let buf = '';",
      '  const events = [];',
      '  while (events.length < 3) {',
      '    const { value, done } = await reader.read();',
      '    if (done) break;',
      '    buf += dec.decode(value, { stream: true });',
      "    let i; while ((i = buf.indexOf('\\n\\n')) >= 0 && events.length < 3) { events.push(buf.slice(0, i)); buf = buf.slice(i + 2); }",
      '  }',
      "  console.log('events', events.join(','));",
      '  ac.abort();',
      "  await reader.read().catch((e) => console.log('after abort', e.name));",
      '});',
    ].join('\n');
    await jsh.kernel.writeFile('/os/sse.js', source);
    const r = await jsh.run(['node', 'sse.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'events data: 1,data: 2,data: 3\nafter abort AbortError\nserver: closed\n');
  });
});
