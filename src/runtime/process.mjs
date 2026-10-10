import { EventEmitter } from './builtins/events.mjs';
import { assignProcessExitCode, NodeExitError, numericExitCode } from './exit.mjs';

/** Node version reported by the shim (M1 target). */
export const NODE_SHIM_VERSION = '22.22.0';

function toBytes(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value == null) return '';
  return String(value);
}

function writableStream(fd, writeSync, isTTY) {
  const ee = new EventEmitter();
  return {
    fd,
    isTTY,
    write(chunk, encoding, cb) {
      const callback = typeof encoding === 'function' ? encoding : cb;
      try {
        writeSync(toBytes(chunk));
        if (typeof callback === 'function') queueMicrotask(() => callback());
        return true;
      } catch (err) {
        if (typeof callback === 'function') queueMicrotask(() => callback(err));
        else throw err;
        return false;
      }
    },
    end(chunk, encoding, cb) {
      if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk, encoding);
      const callback = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') queueMicrotask(() => callback());
      return this;
    },
    on(event, fn) {
      ee.on(event, fn);
      return this;
    },
    once(event, fn) {
      ee.once(event, fn);
      return this;
    },
    emit(event, ...args) {
      return ee.emit(event, ...args);
    },
    off(event, fn) {
      ee.off(event, fn);
      return this;
    },
  };
}

function createStdin(ctx, handles, Buffer) {
  const ee = new EventEmitter();
  let encoding = null;
  let ended = false;
  let started = false;
  const decoder = new TextDecoder();

  const emitChunk = (bytes) => {
    if (bytes == null || bytes.byteLength === 0) return;
    const chunk = Buffer ? Buffer.from(bytes) : bytes;
    const data =
      encoding === 'utf8' || encoding === 'utf-8'
        ? decoder.decode(chunk)
        : encoding
          ? chunk.toString?.(encoding) ?? decoder.decode(chunk)
          : chunk;
    ee.emit('data', data);
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    ee.emit('end');
    ee.emit('close');
  };

  const pump = async () => {
    if (started) return;
    started = true;
    const handle = { kind: 'stdin' };
    handles.add(handle);
    try {
      if (ctx.stdin && typeof ctx.stdin.getReader === 'function') {
        const reader = ctx.stdin.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) emitChunk(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } else if (typeof ctx.read === 'function') {
        for (;;) {
          const chunk = await ctx.read(0);
          if (!chunk || chunk.byteLength === 0) break;
          emitChunk(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
      }
    } catch {
      /* EOF */
    } finally {
      handles.delete(handle);
      finish();
    }
  };

  return {
    fd: 0,
    isTTY: false,
    readable: true,
    setEncoding(enc) {
      encoding = enc;
      return this;
    },
    on(event, fn) {
      ee.on(event, fn);
      if (event === 'data' || event === 'end' || event === 'close' || event === 'readable') {
        queueMicrotask(() => pump());
      }
      return this;
    },
    once(event, fn) {
      ee.once(event, fn);
      if (event === 'data' || event === 'end' || event === 'close') queueMicrotask(() => pump());
      return this;
    },
    off(event, fn) {
      ee.off(event, fn);
      return this;
    },
    removeListener(event, fn) {
      return this.off(event, fn);
    },
    resume() {
      queueMicrotask(() => pump());
      return this;
    },
    pause() {
      return this;
    },
    read() {
      return null;
    },
    async *[Symbol.asyncIterator]() {
      const queue = [];
      let wait = null;
      let done = false;
      this.on('data', (c) => {
        if (wait) {
          const r = wait;
          wait = null;
          r({ value: c, done: false });
        } else queue.push(c);
      });
      this.on('end', () => {
        done = true;
        if (wait) {
          const r = wait;
          wait = null;
          r({ value: undefined, done: true });
        }
      });
      for (;;) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (done) return;
        const next = await new Promise((resolve) => {
          wait = resolve;
        });
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

class Process extends EventEmitter {
  constructor({ ctx, argv, nextTick, onExit, handles, Buffer }) {
    super();
    this._startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._cwd = ctx.cwd;
    this._assignedExitCode = undefined;
    this._forcedExitCode = undefined;
    this._didExit = false;
    this._title = 'node';
    this._ctx = ctx;
    this._onExit = onExit;

    this.argv = argv.slice();
    this.argv0 = argv[0] ?? 'node';
    this.env = { ...ctx.env };
    this.versions = { node: NODE_SHIM_VERSION };
    this.version = `v${NODE_SHIM_VERSION}`;
    this.platform = 'linux';
    this.arch = 'x64';
    this.pid = ctx.pid;
    this.ppid = undefined;
    this.execPath = '/node_modules/@ai-ecoverse/slicc-jsh/dist/node.mjs';
    this.nextTick = nextTick.nextTick.bind(nextTick);

    const writeStdout = (value) => ctx.sync.write(1, toBytes(value));
    const writeStderr = (value) => ctx.sync.write(2, toBytes(value));
    this._writeStdout = writeStdout;
    this._writeStderr = writeStderr;

    this.stdout = writableStream(1, writeStdout, false);
    this.stderr = writableStream(2, writeStderr, false);
    this.stdin = createStdin(ctx, handles, Buffer);

    const hrtime = (prev) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const totalNs = BigInt(Math.floor(now * 1e6));
      if (prev) {
        const prevNs = BigInt(prev[0]) * 1_000_000_000n + BigInt(prev[1]);
        const delta = totalNs - prevNs;
        return [Number(delta / 1_000_000_000n), Number(delta % 1_000_000_000n)];
      }
      return [Number(totalNs / 1_000_000_000n), Number(totalNs % 1_000_000_000n)];
    };
    hrtime.bigint = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return BigInt(Math.floor(now * 1e6));
    };
    this.hrtime = hrtime;
  }

  get title() {
    return this._title;
  }
  set title(v) {
    this._title = String(v);
  }

  get exitCode() {
    return this._assignedExitCode;
  }
  set exitCode(value) {
    if (this._didExit && this._forcedExitCode !== undefined) return;
    this._assignedExitCode = assignProcessExitCode(value);
  }

  uptime() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return (now - this._startedAt) / 1000;
  }

  memoryUsage() {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }

  cwd() {
    return this._cwd;
  }

  chdir(path) {
    if (typeof path !== 'string') {
      const err = new TypeError(
        `The "directory" argument must be of type string. Received type ${typeof path}`
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    this._cwd = this._ctx.resolve(path);
  }

  exit(...args) {
    if (args.length === 0) {
      const code = numericExitCode(this._assignedExitCode);
      this._recordExit(code);
      try {
        this.emit('exit', code);
      } catch {
        /* ignore */
      }
      throw new NodeExitError(code);
    }
    this._assignedExitCode = assignProcessExitCode(args[0]);
    const code = numericExitCode(this._assignedExitCode);
    this._recordExit(code);
    try {
      this.emit('exit', code);
    } catch {
      /* ignore */
    }
    throw new NodeExitError(code);
  }

  _recordExit(code) {
    this._didExit = true;
    this._forcedExitCode = code;
    this._assignedExitCode = code;
    this._onExit?.(code);
  }
}

export function createProcess({ ctx, argv, nextTick, onExit, handles, Buffer }) {
  const process = new Process({ ctx, argv, nextTick, onExit, handles, Buffer });
  return {
    process,
    writeStdout: process._writeStdout,
    writeStderr: process._writeStderr,
    getExitCode: () =>
      numericExitCode(process._didExit ? process._forcedExitCode : process._assignedExitCode),
    getDidExit: () => process._didExit,
    recordExit: (code) => process._recordExit(code),
    emitBeforeExit: () => {
      process.emit('beforeExit', numericExitCode(process._assignedExitCode));
    },
    emitExit: (code) => {
      process.emit('exit', code);
    },
  };
}
