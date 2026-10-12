import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStdio } from '../../src/runtime/stdio.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { createBuffer } from '../../src/runtime/buffer.mjs';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
// dist/vendor/*.cjs (the source tree's vendor-embedded.mjs is a placeholder).
const vendorFs = {
  readFile(path) {
    const at = path.indexOf('/dist/vendor/');
    if (at === -1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return readFileSync(new URL(path.slice(at + 1), root));
  },
};

// A context that exposes stdin only as a web ReadableStream (no ctx.read),
// as compatible embedders may: process.stdin still reads it.
describe('process.stdin over a context without ctx.read', () => {
  it('reads ctx.stdin through its reader', async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode('one\n'), enc.encode('two\n')];
    const ctx = {
      stdin: new ReadableStream({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }),
      sync: { write() {}, fs: vendorFs },
    };
    const process = Object.assign(new (await import('node:events')).EventEmitter(), {
      env: {},
      nextTick: globalThis.process.nextTick,
      _writeStdout() {},
      _writeStderr() {},
    });
    const io = createStdio({ ctx, process, Buffer: createBuffer(), handles: createHandleTable(), info: { 0: { type: 'pipe' } } });
    const stdin = io.stdin();
    stdin.setEncoding('utf8');
    let got = '';
    for await (const c of stdin) got += c;
    assert.equal(got, 'one\ntwo\n');
  });
});
