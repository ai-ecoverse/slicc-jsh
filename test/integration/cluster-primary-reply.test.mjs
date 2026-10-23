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
// `done` settles once a held-back bind has called back. With `failFirst`,
// the first server's bind fails instead (EADDRINUSE).
function slowNet(ms, { failFirst = false } = {}) {
  let called;
  let servers = 0;
  const done = new Promise((resolve) => (called = resolve));
  return {
    done,
    net: {
      ...net,
      createServer(...args) {
        const server = net.createServer(...args);
        const listen = server.listen.bind(server);
        const fail = failFirst && servers++ === 0;
        server.listen = (options, cb) => {
          if (fail) {
            setTimeout(() => {
              server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
              called();
            }, ms);
            return server;
          }
          return listen(options, () =>
            setTimeout(() => {
              cb();
              called();
            }, ms)
          );
        };
        return server;
      },
    },
  };
}

// A worker's process: what it is sent (`written`), and once it has had the
// ack to its exitedAfterDisconnect (seq 1) it is gone: a send to it then is
// the channel's EPIPE (and is written down too).
function standInWorker() {
  const written = [];
  let gone = false;
  return Object.assign(new EventEmitter(), {
    connected: true,
    written,
    kill() {},
    crash() {
      gone = true;
    },
    send(message, handle, options) {
      written.push(message);
      if (gone) {
        if (!options?.swallowErrors) process.nextTick(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })));
        return true;
      }
      if (message.ack === 1) gone = true;
      return true;
    },
  });
}

const primaryProcess = { env: {}, argv: ['node', 'primary.js'], execArgv: [], nextTick: (fn, ...args) => process.nextTick(fn, ...args) };
const internal = (worker, message) => worker.emit('internalMessage', { cmd: 'NODE_CLUSTER', ...message });
const queryServer = { act: 'queryServer', seq: 0, address: '127.0.0.1', port: 0, addressType: 4, fd: -1, index: 0, proxy: { port: 1 } };
const leave = (worker) => {
  worker.connected = false;
  worker.emit('disconnect');
  worker.emit('exit', 0, null);
};

describe('cluster primary: a worker that leaves while its listen() is set up (src)', () => {
  it("gets no answer once it has asked to leave: nothing is written to its gone channel, and there's no EPIPE", async () => {
    const worker = standInWorker();
    const slow = slowNet(50);
    const cluster = createCluster({ process: primaryProcess, getChildProcess: () => ({ fork: () => worker }), getNet: () => slow.net, canFork: () => true });
    const errors = [];
    const w = cluster.fork();
    w.on('error', (err) => errors.push(err.code));
    // listen() asks for its server; then the worker asks to leave.
    internal(worker, queryServer);
    internal(worker, { act: 'exitedAfterDisconnect', seq: 1 });
    try {
      // Once the held-back bind has called back (its answer would be written
      // then), and a turn for an EPIPE to be reported.
      await slow.done;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        worker.written.map((m) => m.ack),
        [1]
      );
      assert.deepEqual(errors, []);
    } finally {
      // Its going closes the primary's server.
      leave(worker);
    }
  });

  it('answers a worker whose channel is gone without an EPIPE: the answer to a worker that exited first is dropped', async () => {
    const worker = standInWorker();
    const slow = slowNet(50);
    const cluster = createCluster({ process: primaryProcess, getChildProcess: () => ({ fork: () => worker }), getNet: () => slow.net, canFork: () => true });
    const errors = [];
    const w = cluster.fork();
    w.on('error', (err) => errors.push(err.code));
    internal(worker, queryServer);
    worker.crash();
    try {
      await slow.done;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        worker.written.map((m) => m.ack),
        [0]
      );
      assert.deepEqual(errors, []);
    } finally {
      leave(worker);
    }
  });

  it("doesn't keep a bind that failed meanwhile: the next worker asking for the address gets a bind of its own", async () => {
    const first = standInWorker();
    const second = standInWorker();
    const forks = [first, second];
    const slow = slowNet(50, { failFirst: true });
    const cluster = createCluster({ process: primaryProcess, getChildProcess: () => ({ fork: () => forks.shift() }), getNet: () => slow.net, canFork: () => true });
    cluster.fork();
    internal(first, queryServer);
    internal(first, { act: 'exitedAfterDisconnect', seq: 1 });
    await slow.done;
    leave(first);
    cluster.fork();
    // The second worker's answer, once it comes.
    const answered = new Promise((resolve) => {
      const send = second.send;
      second.send = function (message) {
        const sent = Reflect.apply(send, this, [message]);
        if (message.ack === 0) resolve(message);
        return sent;
      };
    });
    internal(second, queryServer);
    try {
      assert.equal((await answered).errno, 0);
    } finally {
      leave(second);
    }
  });
});
