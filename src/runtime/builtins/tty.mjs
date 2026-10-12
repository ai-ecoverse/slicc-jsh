/**
 * tty: isatty, ReadStream, WriteStream (lib/tty.js) over the runtime's stdio
 * streams (src/runtime/stdio.mjs). A descriptor's kind comes from the kernel
 * at start (fds 0–2); other descriptors aren't known to be terminals.
 */

export function createTty({ process }) {
  const io = process._stdio;
  return {
    isatty(fd) {
      return io.isatty(fd);
    },
    get ReadStream() {
      return io.classes().TtyReadStream;
    },
    get WriteStream() {
      return io.classes().WriteStream;
    },
  };
}

