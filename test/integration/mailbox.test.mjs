/**
 * The shared-memory mailbox a port between threads uses
 * (src/runtime/web/mailbox.mjs). Its byte counts are 32-bit and wrap after
 * 4 GiB written in one direction; a long-running pool gets there. A ring
 * whose counts start just below 2^32 must take exactly what a fresh one
 * takes, and give every record back whole.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMailbox, mailboxReader, mailboxWriter } from '../../src/runtime/web/mailbox.mjs';

const SIZE = 1024;

// A ring (no overflow area) whose written and read counts are both `start`.
function ringAt(start) {
  const { ring } = createMailbox(SIZE);
  const header = new Int32Array(ring, 0, 8);
  header[0] = start | 0;
  header[1] = start | 0;
  return { writer: mailboxWriter({ ring, big: null }), reader: mailboxReader({ ring, big: null }) };
}

// Records of 100 bytes until the ring is full; how many went in (at most
// 100: a ring that never says it is full has overwritten what it held).
function fill(writer) {
  let n = 0;
  while (n < 100 && writer.write(n, new Uint8Array(100).fill(n & 0xff))) n += 1;
  return n;
}

describe('mailbox', () => {
  it('a ring whose counts wrap past 2^32 takes what a fresh one does, and gives it all back whole', () => {
    const fresh = ringAt(0);
    const capacity = fill(fresh.writer);
    assert.ok(capacity > 0 && capacity < SIZE / 100);
    // 64 bytes below the wrap: the records cross it.
    const wrapping = ringAt(0x100000000 - 64);
    assert.equal(fill(wrapping.writer), capacity);
    const records = wrapping.reader.take();
    assert.equal(records.length, capacity);
    for (const [seq, bytes] of records) assert.deepEqual([...bytes], new Array(100).fill(seq & 0xff));
    // Read, it takes as much again.
    assert.equal(fill(wrapping.writer), capacity);
  });
});
