/**
 * One direction of a port between threads, in shared memory: so that
 * receiveMessageOnPort() has a message the moment it was posted, as Node's
 * does, even in a thread that is blocked in Atomics.wait and never returns
 * to its event loop (piscina's and tinypool's workers sleep on their
 * request counter, then drain their port synchronously).
 *
 * A ring of records, [seq, length, bytes…] each (32-bit aligned): one
 * writer (the sending port's thread) and one reader (the receiving port's).
 * A message bigger than the ring's room goes to an overflow area, a
 * growable SharedArrayBuffer, the ring then holding [seq, OVERFLOW | length,
 * offset]: a post never has to wait. The overflow area starts again from
 * its beginning once the reader has taken all of it.
 *
 * The ring's header, as Int32s: the bytes written and read so far (both
 * only grow; positions are those modulo the ring's size), how many records
 * were written (what the reader waits on), and the overflow area's bytes
 * written and taken.
 */
const W = 0; // ring bytes written
const R = 1; // ring bytes read
const COUNT = 2; // records written
const OW = 3; // overflow bytes written (since its last start)
const OR = 4; // overflow bytes taken
const HEADER = 8 * 4;
const OVERFLOW = 0x80000000;
export const MAILBOX_BYTES = 1 << 20;
const OVERFLOW_MAX = 1 << 30;

/** `size`: a power of two (positions are the byte counts modulo it, and those wrap at 2^32). */
export function createMailbox(size = MAILBOX_BYTES) {
  const ring = new SharedArrayBuffer(HEADER + size);
  // Growable where the engine has it; else the overflow area is as big as it gets.
  let big;
  try {
    big = new SharedArrayBuffer(0, { maxByteLength: OVERFLOW_MAX });
    if (typeof big.grow !== 'function') big = null;
  } catch {
    big = null;
  }
  return { ring, big };
}

const align = (n) => (n + 3) & ~3;

export function mailboxWriter({ ring: sab, big }) {
  const header = new Int32Array(sab, 0, 8);
  const size = sab.byteLength - HEADER;
  const ring = new Uint8Array(sab, HEADER, size);
  const at = new DataView(sab, HEADER, size);
  const put = (offset, bytes) => {
    const pos = offset % size;
    const first = Math.min(bytes.length, size - pos);
    ring.set(bytes.subarray(0, first), pos);
    if (first < bytes.length) ring.set(bytes.subarray(first), 0);
  };
  const put32 = (offset, value) => {
    const pos = offset % size;
    if (pos + 4 <= size) at.setUint32(pos, value >>> 0, true);
    else put(offset, new Uint8Array(new Uint32Array([value >>> 0]).buffer));
  };
  // What is unread is W - R modulo 2^32: both wrap after 4 GiB (the ring's
  // size divides 2^32, so positions go on across it).
  const room = () => size - ((Atomics.load(header, W) - Atomics.load(header, R)) >>> 0);
  const publish = (written, need) => {
    Atomics.store(header, W, (written + need) | 0);
    Atomics.add(header, COUNT, 1);
    Atomics.notify(header, COUNT);
  };
  return {
    /** Whether a record of `length` bytes would go in now (the writer's alone, so it still will). */
    fits(length) {
      const need = 8 + align(length);
      if (need <= room()) return true;
      if (!big || 12 > room() || length >= OVERFLOW) return false;
      let start = Atomics.load(header, OW);
      if (start !== 0 && Atomics.load(header, OR) === start) start = 0;
      return start + align(length) <= OVERFLOW_MAX;
    },
    /** Whether the record went in (false: neither ring nor overflow could take it). */
    write(seq, bytes) {
      const written = Atomics.load(header, W) >>> 0;
      const need = 8 + align(bytes.length);
      if (need <= room()) {
        put32(written, seq);
        put32(written + 4, bytes.length);
        put(written + 8, bytes);
        publish(written, need);
        return true;
      }
      // Too big for the ring's room: the overflow area, and a pointer in the ring.
      if (!big || 12 > room() || bytes.length >= OVERFLOW) return false;
      let start = Atomics.load(header, OW);
      // The reader has taken all of it: it starts again from the beginning.
      if (start !== 0 && Atomics.load(header, OR) === start) {
        Atomics.store(header, OR, 0);
        start = 0;
      }
      const end = start + align(bytes.length);
      if (end > big.byteLength) {
        if (end > OVERFLOW_MAX) return false;
        big.grow(Math.min(OVERFLOW_MAX, Math.max(end, big.byteLength * 2)));
      }
      new Uint8Array(big, start, bytes.length).set(bytes);
      Atomics.store(header, OW, end);
      put32(written, seq);
      put32(written + 4, OVERFLOW | bytes.length);
      put32(written + 8, start);
      publish(written, 12);
      return true;
    },
  };
}

export function mailboxReader({ ring: sab, big }) {
  const header = new Int32Array(sab, 0, 8);
  const size = sab.byteLength - HEADER;
  const ring = new Uint8Array(sab, HEADER, size);
  const at = new DataView(sab, HEADER, size);
  const get = (offset, length) => {
    const pos = offset % size;
    const out = new Uint8Array(length);
    const first = Math.min(length, size - pos);
    out.set(ring.subarray(pos, pos + first));
    if (first < length) out.set(ring.subarray(0, length - first), first);
    return out;
  };
  const get32 = (offset) => {
    const pos = offset % size;
    if (pos + 4 <= size) return at.getUint32(pos, true);
    return new Uint32Array(get(offset, 4).buffer)[0];
  };
  return {
    /** Every record written and not yet read, as [seq, bytes]. */
    take() {
      const out = [];
      let read = Atomics.load(header, R) >>> 0;
      const written = Atomics.load(header, W) >>> 0;
      while (read !== written) {
        const seq = get32(read);
        const word = get32(read + 4);
        if (word & OVERFLOW) {
          const length = word & ~OVERFLOW;
          const start = get32(read + 8);
          out.push([seq, new Uint8Array(big, start, length).slice()]);
          Atomics.store(header, OR, start + align(length));
          read = (read + 12) >>> 0;
        } else {
          out.push([seq, get(read + 8, word)]);
          read = (read + 8 + align(word)) >>> 0;
        }
      }
      Atomics.store(header, R, read | 0);
      return out;
    },
    /** Resolves when a record is written after `seen` were (Atomics.waitAsync), or null without it. */
    waitAfter(seen) {
      if (typeof Atomics.waitAsync !== 'function') return null;
      const result = Atomics.waitAsync(header, COUNT, seen);
      return result.async ? result.value : Promise.resolve(result.value);
    },
    count: () => Atomics.load(header, COUNT),
  };
}
