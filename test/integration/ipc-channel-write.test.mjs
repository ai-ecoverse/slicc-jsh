/**
 * The IPC channel's writes on a kernel with non-blocking writes and select
 * (slicc-kernel 1.126.0). The race here can't be set up from a program: the
 * socket takes part of a write, then the rest at once when the drain tries
 * again. So the kernel is a stand-in: its non-blocking write takes what the
 * test says. Everything above it is jsh's own channel.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelHandle } from '../../src/runtime/builtins/ipc-channel.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';

const constants = { kReadBytesOrError: 0, kArrayBufferOffset: 1, kLastWriteWasAsync: 2 };

function channelOver(takes) {
  const written = [];
  const ctx = {
    sync: {
      write(fd, bytes, options) {
        assert.equal(options?.nonblock, true, 'every write is non-blocking');
        const n = Math.min(takes.shift() ?? bytes.length, bytes.length);
        written.push(n);
        return n;
      },
    },
    select: () => Promise.resolve({ read: [], write: [3] }),
    read: () => new Promise(() => {}),
    close: () => Promise.resolve(),
  };
  const streamBaseState = new Int32Array(3);
  const exitFlush = new Set();
  const channel = createChannelHandle({ ctx, handles: createHandleTable(), streamBaseState, constants, fd: 3, exitFlush });
  return { channel, streamBaseState, written, flushAtExit: () => [...exitFlush].forEach((flush) => flush()) };
}

describe('IPC channel writes (try-write)', () => {
  it('a write the drain finishes at once still completes after its request has its oncomplete', async () => {
    // The socket takes 10 bytes, then, when the drain tries again, the rest.
    const { channel, streamBaseState, written } = channelOver([10]);
    const req = {};
    assert.equal(channel.writeBuffer(req, new Uint8Array(100)), 0);
    assert.equal(streamBaseState[constants.kLastWriteWasAsync], 1);
    // As setupChannel's _send: the oncomplete comes once writeBuffer returns.
    const done = [];
    req.oncomplete = (status) => done.push(status);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [10, 90]);
    assert.deepEqual(done, [0]);
    assert.equal(channel.writeQueueSize, 0);
  });

  it('a write the socket takes whole is done before writeBuffer returns, with no oncomplete', async () => {
    const { channel, streamBaseState, written } = channelOver([]);
    const req = {};
    assert.equal(channel.writeBuffer(req, new Uint8Array(100)), 0);
    assert.equal(streamBaseState[constants.kLastWriteWasAsync], 0);
    assert.deepEqual(written, [100]);
  });

  it("the exit flush writes what is queued, but runs no send's callback, as Node runs none once the program ends", () => {
    // The socket takes 10 bytes now; at exit, the rest.
    const { channel, written, flushAtExit } = channelOver([10]);
    const req = {};
    channel.writeBuffer(req, new Uint8Array(100));
    const done = [];
    req.oncomplete = (status) => done.push(status);
    flushAtExit();
    assert.deepEqual(written, [10, 90]);
    assert.deepEqual(done, []);
  });
});
