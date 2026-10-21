/**
 * The cluster primary (src/runtime/builtins/cluster.mjs) and a worker that
 * asks to leave while the primary is still setting up the server its
 * listen() asked for (#675). jsh's primary binds that server on a later turn
 * (the kernel's listen), where Node's binds at once, so it can ack the
 * worker's exitedAfterDisconnect before it answers the queryServer. The
 * worker leaves on the ack, and an answer written then goes to a closed
 * channel: an EPIPE, uncaught in the primary (golden
 * cluster-fork-races-node22's close-during-setup, seen under load).
 *
 * The worker's process is stood in for (the kernel and its IPC channel):
 * once it has had the ack it is gone, and a send to it is the channel's
 * EPIPE, as jsh's IPC channel reports one. The bind is held back so the ack
 * comes first, every time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { createCluster } from '../../src/runtime/builtins/cluster.mjs';

// node:net, its servers' listen() calling back a while after they listen;
// `called` settles once a held-back callback has run.
function slowNet(ms) {
  let called;
  const done = new Promise((resolve) => (called = resolve));
  return {
    done,
    net: {
      ...net,
      createServer(...args) {
        const server = net.createServer(...args);
        const listen = server.listen.bind(server);
        server.listen = (options, cb) =>
          listen(options, () =>
            setTimeout(() => {
              cb();
              called();
            }, ms)
          );
        return server;
      },
    },
  };
}

describe('cluster primary: a worker that leaves while its listen() is set up (src)', () => {
  it("gets no answer once it has asked to leave: nothing is written to its gone channel, and there's no EPIPE", async () => {
    const written = [];
    const errors = [];
    let gone = false;
    const worker = Object.assign(new EventEmitter(), {
      connected: true,
      kill() {},
      send(message) {
        if (gone) {
          written.push(message);
          // jsh's IPC channel: a write to a peer that closed its end.
          process.nextTick(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })));
          return true;
        }
        // The worker leaves on the ack to its exitedAfterDisconnect (seq 1).
        if (message.ack === 1) gone = true;
        return true;
      },
    });
    const slow = slowNet(50);
    const cluster = createCluster({
      process: { env: {}, argv: ['node', 'primary.js'], execArgv: [], nextTick: (fn, ...args) => process.nextTick(fn, ...args) },
      getChildProcess: () => ({ fork: () => worker }),
      getNet: () => slow.net,
      canFork: () => true,
    });
    const w = cluster.fork();
    w.on('error', (err) => errors.push(err.code));
    // listen() asks for its server; then the worker asks to leave.
    worker.emit('internalMessage', { cmd: 'NODE_CLUSTER', act: 'queryServer', seq: 0, address: '127.0.0.1', port: 0, addressType: 4, fd: -1, index: 0, proxy: { port: 1 } });
    worker.emit('internalMessage', { cmd: 'NODE_CLUSTER', act: 'exitedAfterDisconnect', seq: 1 });
    try {
      // Once the held-back bind has called back (its answer would be written
      // then), and a turn for an EPIPE to be reported.
      await slow.done;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(written, []);
      assert.deepEqual(errors, []);
    } finally {
      // Its going closes the primary's server.
      worker.connected = false;
      worker.emit('disconnect');
      worker.emit('exit', 0, null);
    }
  });
});
