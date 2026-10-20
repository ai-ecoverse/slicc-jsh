/**
 * Ports between threads, as jsh's own ports, remote ports, mailbox and
 * serializer make them, over the platform's MessageChannel.
 *
 * A port between threads numbers its messages, and the mailbox
 * (src/runtime/web/mailbox.mjs) stores the number as 32 bits. Past 2^32
 * messages in one direction, the receiver must go on from 0 rather than
 * wait for a number the mailbox can't hold. Two linked jsh ports (jsh's
 * own ports, remote ports, mailbox and serializer, over the platform's
 * MessageChannel) whose counters start just below 2^32: every message is
 * there at once for receiveMessageOnPort, across the wrap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPorts } from '../../src/runtime/web/broadcast-channel.mjs';
import { createRemotePorts } from '../../src/runtime/web/remote-ports.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { createV8 } from '../../src/runtime/builtins/v8.mjs';

const v8 = createV8({ Buffer });
const serdes = () => ({
  serialize(value) {
    const ser = new v8.Serializer();
    ser.writeHeader();
    ser.writeValue(value);
    return ser.releaseBuffer();
  },
  deserialize(bytes) {
    const der = new v8.Deserializer(bytes);
    der.readHeader();
    return der.readValue();
  },
});

describe('remote ports', () => {
  it('message numbers wrap at 2^32: delivery goes on across the wrap', () => {
    const ports = createPorts({ handles: createHandleTable(), schedule: (fn) => setImmediate(fn) });
    const remote = createRemotePorts({ ports, NativeMessageChannel: MessageChannel, serdes });
    const a = ports.makePort();
    const b = ports.makePort();
    const channel = new MessageChannel();
    const [here, there] = remote.mailboxPair(1 << 16);
    const state = { nextSend: 0xfffffffe, expect: 0xfffffffe };
    remote.link(a, channel.port1, undefined, here, state);
    remote.link(b, channel.port2, undefined, there, state);
    try {
      const sent = ['before the wrap', 'the last number', 'number 0', 'number 1'];
      for (const m of sent) a.postMessage(m);
      for (const m of sent) assert.deepEqual(ports.receiveMessageOnPort(b), { message: m });
    } finally {
      a.close();
      b.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  // A port whose peer (in another thread) has closed: its link has closed
  // the native port under it. Passed on, it goes over a fresh one and
  // arrives closed, instead of the transfer failing on the closed one.
  it('a port whose peer closed can still be passed on, and arrives closed', async () => {
    const ports = createPorts({ handles: createHandleTable(), schedule: (fn) => setImmediate(fn) });
    const remote = createRemotePorts({ ports, NativeMessageChannel: MessageChannel, serdes });
    const a = ports.makePort();
    const b = ports.makePort();
    const channel = new MessageChannel();
    const [here, there] = remote.mailboxPair(1 << 16);
    remote.link(a, channel.port1, undefined, here);
    remote.link(b, channel.port2, undefined, there);
    a.postMessage('q1');
    a.postMessage('q2');
    a.close();
    // Each turn of the loop, until b has taken the close.
    while (!b._closeDue()) await new Promise((resolve) => setImmediate(resolve));
    const natives = [];
    const envelope = remote.exportPort(b, natives);
    assert.equal(envelope.open, false);
    const moved = remote.importPort(structuredClone(envelope, { transfer: natives }));
    assert.equal(ports.receiveMessageOnPort(moved), undefined);
    moved.close();
  });
});
