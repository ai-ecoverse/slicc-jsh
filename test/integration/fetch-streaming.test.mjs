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
