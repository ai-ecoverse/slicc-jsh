/**
 * process.stdin / stdout / stderr as Node's streams: a stream.Readable and
 * stream.Writables (readable-stream), so pipe(), async iteration, 'data' /
 * 'end', setEncoding, pause / resume and stream.pipeline work. On a terminal
 * they are tty.ReadStream / tty.WriteStream (isTTY, setRawMode, columns /
 * rows, 'resize', getColorDepth, cursorTo, …); otherwise, as in Node, they
 * have no isTTY.
 *
 * Each is made on first access: until a program touches process.stdout,
 * console and the runtime write to the descriptor directly (the same bytes,
 * without loading the stream module).
 *
 * What a descriptor is (terminal, file or pipe) and a terminal's size are
 * asked of the kernel before the program starts (probeStdio), since Node
 * knows them synchronously.
 */
import { trackPromise } from './async-handles.mjs';
import { createStream } from './builtins/stream.mjs';
import { loadNodeLib } from './node-lib.mjs';
import { createOs } from './builtins/os.mjs';
import { nodeError } from './node-errors.mjs';

/** fd → { type: 'tty' | 'file' | 'pipe', columns, rows }, from the kernel. */
export async function probeStdio(ctx) {
  const one = async (fd) => {
    let type = 'pipe';
    try {
      if (typeof ctx.fdStatus === 'function') {
        const st = await ctx.fdStatus(fd);
        type = st?.tty ? 'tty' : st?.type === 'file' ? 'file' : 'pipe';
      } else if (typeof ctx.isatty === 'function') {
        type = (await ctx.isatty(fd)) ? 'tty' : 'pipe';
      }
    } catch {
      type = 'pipe';
    }
    const info = { type };
    if (type === 'tty' && fd !== 0) {
      try {
        const size = await ctx.tty.size(fd);
        info.columns = size.columns;
        info.rows = size.rows;
      } catch {
        info.columns = 80;
        info.rows = 24;
      }
    }
    return info;
  };
  const [i0, i1, i2] = await Promise.all([one(0), one(1), one(2)]);
  return { 0: i0, 1: i1, 2: i2 };
}

export function createStdio({ ctx, process, Buffer, handles, info = {} }) {
  const kindOf = (fd) => info[fd]?.type ?? 'pipe';
  let classes;
  let nodeLib;
  const lib = () => {
    nodeLib ??= loadNodeLib({ ctx, process, Buffer, os: () => createOs(process.env) });
    return nodeLib;
  };

  function makeClasses() {
    const { Readable, Writable, Duplex } = createStream({ ctx, process, Buffer, handles });

    // --- writable side: SyncWriteStream (file), Socket (pipe), WriteStream (tty)
    const writers = { 1: (b) => process._writeStdout(b), 2: (b) => process._writeStderr(b) };
    // Node's pipe and terminal stdio are net.Sockets: Duplex, one side unused.
    function initWritable(stream, fd, type, Base = Writable) {
      Base.call(stream, { decodeStrings: true, allowHalfOpen: false });
      if (Base === Duplex) stream.readable = false;
      stream.fd = fd;
      stream._type = type;
      stream._isStdio = true;
      // Node's stdio never closes its descriptor (dummyDestroy).
      stream.destroySoon = stream.destroy;
    }
    const writableMethods = {
      _write(chunk, encoding, callback) {
        try {
          (writers[this.fd] ?? ((b) => ctx.sync.write(this.fd, b)))(chunk);
        } catch (err) {
          callback(err);
          return;
        }
        callback();
      },
      _destroy(err, callback) {
        callback(err);
      },
    };

    function SyncWriteStream(fd) {
      initWritable(this, fd, 'fs');
      this.readable = false;
    }
    Object.setPrototypeOf(SyncWriteStream.prototype, Writable.prototype);
    Object.setPrototypeOf(SyncWriteStream, Writable);
    Object.assign(SyncWriteStream.prototype, writableMethods);

    function Socket(fd) {
      initWritable(this, fd, 'pipe', Duplex);
    }
    Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
    Object.setPrototypeOf(Socket, Duplex);
    Object.assign(Socket.prototype, writableMethods, { _read() {} });

    const ttyInit = (fd, wantTTY) => {
      if (!Number.isInteger(fd) || fd < 0 || (info[fd] ? info[fd].type !== 'tty' : true)) {
        const code = !Number.isInteger(fd) || fd < 0 ? 'EBADF' : 'EINVAL';
        const err = nodeError(Error, 'ERR_TTY_INIT_FAILED', `TTY initialization failed: uv_tty_init returned ${code} (${code === 'EBADF' ? 'bad file descriptor' : 'invalid argument'})`);
        err.errno = code === 'EBADF' ? -9 : -22;
        err.syscall = 'uv_tty_init';
        throw err;
      }
      void wantTTY;
    };

    // tty.WriteStream (lib/tty.js)
    function WriteStream(fd) {
      if (!(this instanceof WriteStream)) return new WriteStream(fd);
      ttyInit(fd, true);
      initWritable(this, fd, 'tty', Duplex);
      this.columns = info[fd].columns ?? 80;
      this.rows = info[fd].rows ?? 24;
    }
    Object.setPrototypeOf(WriteStream.prototype, Duplex.prototype);
    Object.setPrototypeOf(WriteStream, Duplex);
    Object.assign(WriteStream.prototype, writableMethods, { _read() {} });
    WriteStream.prototype.isTTY = true;
    WriteStream.prototype.getColorDepth = function getColorDepth(env) {
      return lib().tty.getColorDepth.call(this, env);
    };
    WriteStream.prototype.hasColors = function hasColors(count, env) {
      return lib().tty.hasColors.call(this, count, env);
    };
    WriteStream.prototype._refreshSize = function _refreshSize() {
      const oldCols = this.columns;
      const oldRows = this.rows;
      trackPromise(handles, Promise.resolve(ctx.tty.size(this.fd))).then(
        ({ columns, rows }) => {
          if (oldCols !== columns || oldRows !== rows) {
            this.columns = columns;
            this.rows = rows;
            this.emit('resize');
          }
        },
        (err) => this.emit('error', err)
      );
    };
    WriteStream.prototype.cursorTo = function cursorTo(x, y, cb) {
      return lib().readlineCallbacks.cursorTo(this, x, y, cb);
    };
    WriteStream.prototype.moveCursor = function moveCursor(dx, dy, cb) {
      return lib().readlineCallbacks.moveCursor(this, dx, dy, cb);
    };
    WriteStream.prototype.clearLine = function clearLine(dir, cb) {
      return lib().readlineCallbacks.clearLine(this, dir, cb);
    };
    WriteStream.prototype.clearScreenDown = function clearScreenDown(cb) {
      return lib().readlineCallbacks.clearScreenDown(this, cb);
    };
    WriteStream.prototype.getWindowSize = function getWindowSize() {
      return [this.columns, this.rows];
    };

    // --- readable side: one reader of fd 0 (or a tty fd), through ctx.read.
    function initReadable(stream, fd, type, Base = Readable) {
      Base.call(stream, { highWaterMark: 64 * 1024, allowHalfOpen: false });
      if (Base === Duplex) stream.writable = false;
      stream.fd = fd;
      const handle = { kind: 'stdin' };
      let inFlight = false;
      let held = false;
      // Reading keeps the program alive while someone consumes: flowing, or a
      // 'readable' listener. pause() lets it end, as Node's readStop does.
      const update = () => {
        const state = stream._readableState;
        const want = inFlight && !stream.destroyed && (stream.readableFlowing !== false || state.readableListening);
        if (want && !held) {
          handles.add(handle);
          held = true;
        } else if (!want && held) {
          handles.delete(handle);
          held = false;
          handles.notify?.();
        }
      };
      stream.on('pause', update);
      stream.on('resume', update);
      stream.on('close', update);
      stream._read = function _read() {
        if (inFlight) return;
        inFlight = true;
        update();
        Promise.resolve(ctx.read(fd)).then(
          (chunk) => {
            inFlight = false;
            if (!chunk || chunk.byteLength === 0) {
              stream.push(null);
              // A socket ends at once even when paused (Node's onStreamRead).
              if (type !== 'fs') stream.read(0);
            } else stream.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            update();
            // The ticks this queued ('end', 'data' after resume) run at the
            // loop's next checkpoint: wake it, held handle or not.
            handles.notify?.();
          },
          (err) => {
            inFlight = false;
            update();
            // A descriptor that's gone reads as end of file.
            if (err?.code === 'EBADF' || err?.code === 'EIO') stream.push(null);
            else stream.destroy(err);
          }
        );
      };
    }
    const readableDestroy = function _destroy(err, callback) {
      callback(err);
    };
    // The stdin socket isn't opened for writing (Node: writable: false).
    const notWritable = function _write(chunk, encoding, callback) {
      const err = new Error('write EPIPE');
      err.code = 'EPIPE';
      err.errno = -32;
      err.syscall = 'write';
      callback(err);
    };

    // fs.ReadStream for a file on fd 0, net.Socket for a pipe.
    function ReadStream(fd) {
      initReadable(this, fd, 'fs');
    }
    Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
    Object.setPrototypeOf(ReadStream, Readable);
    ReadStream.prototype._destroy = readableDestroy;

    function ReadSocket(fd) {
      initReadable(this, fd, 'pipe', Duplex);
    }
    Object.defineProperty(ReadSocket, 'name', { value: 'Socket' });
    Object.setPrototypeOf(ReadSocket.prototype, Duplex.prototype);
    Object.setPrototypeOf(ReadSocket, Duplex);
    ReadSocket.prototype._destroy = readableDestroy;
    ReadSocket.prototype._write = notWritable;

    // tty.ReadStream (lib/tty.js)
    function TtyReadStream(fd, options) {
      if (!(this instanceof TtyReadStream)) return new TtyReadStream(fd, options);
      ttyInit(fd, true);
      initReadable(this, fd, 'tty', Duplex);
      this.isRaw = false;
      this.isTTY = true;
    }
    Object.defineProperty(TtyReadStream, 'name', { value: 'ReadStream' });
    Object.setPrototypeOf(TtyReadStream.prototype, Duplex.prototype);
    Object.setPrototypeOf(TtyReadStream, Duplex);
    TtyReadStream.prototype._destroy = readableDestroy;
    TtyReadStream.prototype._write = notWritable;
    TtyReadStream.prototype.setRawMode = function setRawMode(flag) {
      flag = !!flag;
      trackPromise(handles, Promise.resolve(ctx.tty.setRaw(this.fd, flag))).catch((err) => this.emit('error', err));
      this.isRaw = flag;
      return this;
    };

    return { SyncWriteStream, Socket, WriteStream, ReadStream, ReadSocket, TtyReadStream };
  }
  const getClasses = () => {
    classes ??= makeClasses();
    return classes;
  };

  const made = {};
  function stdout(fd) {
    if (made[fd]) return made[fd];
    const c = getClasses();
    const kind = kindOf(fd);
    const stream = kind === 'tty' ? new c.WriteStream(fd) : kind === 'file' ? new c.SyncWriteStream(fd) : new c.Socket(fd);
    made[fd] = stream;
    // Node's getStdout: a terminal's size follows SIGWINCH.
    if (kind === 'tty') {
      process.on('SIGWINCH', () => stream._refreshSize());
      // The kernel handler comes a moment later than Node's: a resize in
      // between is caught by asking for the size once it's in place.
      process._signalReady?.get('SIGWINCH')?.then(() => stream._refreshSize());
    }
    return stream;
  }
  function stdin() {
    if (made[0]) return made[0];
    const c = getClasses();
    const kind = kindOf(0);
    const stream = kind === 'tty' ? new c.TtyReadStream(0) : kind === 'file' ? new c.ReadStream(0) : new c.ReadSocket(0);
    made[0] = stream;
    return stream;
  }

  return {
    stdin,
    stdout: () => stdout(1),
    stderr: () => stdout(2),
    /** The stream for fd 1 or 2 if a program has touched it, else undefined. */
    made: (fd) => made[fd],
    isatty: (fd) => Number.isInteger(fd) && fd >= 0 && fd <= 2147483647 && kindOf(fd) === 'tty' && fd in info,
    classes: getClasses,
  };
}
