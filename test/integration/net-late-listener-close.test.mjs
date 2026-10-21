/**
 * A listener a net server drops (src/runtime/builtins/net.mjs) and whose
 * close fails (#686): one that comes for a server already closed, or a
 * cluster worker's own when the primary's answer is cancelled or an error.
 * Its close failing is no error of the program's: no unhandled rejection,
 * as Node closes a listening fd inside close().
 *
 * The kernel's net (ctx.net) is stood in for: its listeners' close rejects
 * (EBADF), and a listen() can be held back until the test lets it answer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as stream from 'node:stream';
import { createNet } from '../../src/runtime/builtins/net.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';

function standInKernel() {
  const held = [];
  const listener = (port) => ({
    port,
    host: '127.0.0.1',
    fd: 3,
    close: () => Promise.reject(Object.assign(new Error('close EBADF'), { code: 'EBADF' })),
    accept: () => new Promise(() => {}),
  });
  return {
    held,
    ctx: {
      net: {
        // Each listen() answers once the test lets it (held[i]()).
        listen: ({ port }) => new Promise((resolve) => held.push(() => resolve(listener(port)))),
      },
    },
  };
}

// The unhandled rejections while `fn` runs (and a few turns after).
async function unhandledDuring(fn) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason?.code ?? String(reason));
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

const makeNet = (ctx, extra = {}) =>
  createNet({ ctx, process: { nextTick: (fn, ...args) => process.nextTick(fn, ...args), ...extra }, Buffer, handles: createHandleTable(), getStream: () => stream });

describe('net: a dropped listener whose close fails (src)', () => {
  it("one that comes for a closed server (a listen() after close()): no unhandled rejection", async () => {
    const kernel = standInKernel();
    const net = makeNet(kernel.ctx);
    const seen = await unhandledDuring(async () => {
      const server = net.createServer();
      server.close();
      server.listen(4500, '127.0.0.1');
      kernel.held[0]();
    });
    assert.deepEqual(seen, []);
  });

  it("a cluster worker's own, when the primary's answer is cancelled or an error: no unhandled rejection", async () => {
    for (const reply of [{ cancelled: true }, { errno: 'EADDRINUSE', message: 'address already in use' }]) {
      const kernel = standInKernel();
      const net = makeNet(kernel.ctx, { _clusterWorker: { _getServer: async () => reply, _closeServer() {} } });
      const errors = [];
      const seen = await unhandledDuring(async () => {
        const server = net.createServer();
        server.on('error', (err) => errors.push(err.code));
        server.listen(4501, '127.0.0.1');
        kernel.held[0]();
      });
      assert.deepEqual(seen, [], JSON.stringify(reply));
      assert.deepEqual(errors, reply.errno ? ['EADDRINUSE'] : []);
    }
  });
});
