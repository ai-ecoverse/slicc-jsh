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
  /** Accumulated stdin bytes for fs.readFileSync(0). */
  const collected = [];
  let collectDone = false;

  const emitChunk = (bytes) => {
    if (bytes == null || bytes.byteLength === 0) return;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    collected.push(u8);
    const chunk = Buffer ? Buffer.from(u8) : u8;
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
    collectDone = true;
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
    /** Sync drain for fs.readFileSync(0|/dev/stdin); consumes like a real fd read. */
    _readAllSync() {
      if (!collectDone && typeof ctx.sync?.read === 'function') {
        try {
          for (;;) {
            const c = ctx.sync.read(0);
            if (!c || c.byteLength === 0) break;
            emitChunk(c);
          }
          collectDone = true;
        } catch {
          collectDone = true;
        }
      }
      let total = 0;
      for (const c of collected) total += c.byteLength;
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of collected) {
        out.set(c, at);
        at += c.byteLength;
      }
      // Node: a second readFileSync(0) after draining stdin sees EOF (empty).
      collected.length = 0;
      return out;
    },
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
    this.execArgv = [];
    this.nextTick = nextTick.nextTick.bind(nextTick);
    this._umask = 0o022;
    this._cpuPrev = { user: 0, system: 0 };
    // Node exposes process.config (build-time variables). Minimal M1 shape.
    this.config = {
      target_defaults: {},
      variables: {
        host_arch: 'x64',
        target_arch: 'x64',
        node_use_openssl: false,
        node_shared_openssl: false,
        asio_no_deprecated: true,
        icu_gyp_path: 'tools/icu/icu-generic.gyp',
        v8_enable_i18n_support: 0,
        v8_no_strict_aliasing: 1,
        force_dynamic_crt: 0,
      },
    };
    // test/common and Node APIs read process.features.*
    this.features = {
      inspector: false,
      debug: false,
      uv: true,
      ipv6: true,
      tls_alpn: false,
      tls_sni: false,
      tls_ocsp: false,
      tls: false,
      cached_builtins: true,
    };

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

  cpuUsage(previousValue) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const user = Math.floor(now * 1000);
    const system = Math.floor(now * 100);
    const cur = { user, system };
    if (previousValue && typeof previousValue === 'object') {
      return {
        user: Math.max(0, cur.user - (previousValue.user || 0)),
        system: Math.max(0, cur.system - (previousValue.system || 0)),
      };
    }
    return cur;
  }

  umask(mask) {
    if (mask === undefined) return this._umask;
    const prev = this._umask;
    this._umask = Number(mask) & 0o777;
    return prev;
  }

  cwd() {
    return this._cwd;
  }

  /** Root (0) until credential plumbing is exposed on process. */
  getuid() {
    return 0;
  }

  geteuid() {
    return 0;
  }

  getgid() {
    return 0;
  }

  getegid() {
    return 0;
  }

  getgroups() {
    return [0];
  }

  /**
   * Minimal process.kill: only this process (pid === this.pid). Used by pnpm
   * cmd shims to re-raise a child's terminating signal. Unknown pids → ESRCH.
   */
  kill(pid, signal = 'SIGTERM') {
    const target = Number(pid);
    if (target !== this.pid) {
      const err = new Error(`kill ESRCH`);
      err.code = 'ESRCH';
      err.errno = -3;
      err.syscall = 'kill';
      throw err;
    }
    const name =
      typeof signal === 'string' ? (signal.startsWith('SIG') ? signal : `SIG${signal}`) : 'SIGTERM';
    // Terminating signals end the process; others are ignored for now.
    if (name === 'SIGTERM' || name === 'SIGINT' || name === 'SIGHUP' || name === 'SIGKILL') {
      const codes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGKILL: 137 };
      this.exit(codes[name] ?? 1);
    }
    return true;
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
