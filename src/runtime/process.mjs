import { EventEmitter } from './builtins/events.mjs';
import { assignProcessExitCode, hardExitError, numericExitCode } from './exit.mjs';
import { createStdio } from './stdio.mjs';
import { loadNodeLib } from './node-lib.mjs';
import { ERR_INVALID_ARG_TYPE, nodeError } from './node-errors.mjs';

/** Node version reported by the shim (M1 target). */
export const NODE_SHIM_VERSION = '22.22.0';


function uvError(code, errno, syscall) {
  const err = new Error(`${syscall} ${code}`);
  Object.assign(err, { errno, code, syscall });
  return err;
}

/** Linux signal numbers (Node's os.constants.signals). */
export const SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7,
  SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
  SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
  SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};

function toBytes(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value == null) return '';
  return String(value);
}

/**
 * process.env: like Node's, every value assigned is stored as a string
 * (`process.env.N = 42` reads back '42'), and a symbol value is a TypeError.
 */
function createEnv(initial) {
  const target = { ...initial };
  const coerce = (value) => {
    if (typeof value === 'symbol') {
      throw new TypeError('Cannot convert a Symbol value to a string');
    }
    return String(value);
  };
  return new Proxy(target, {
    set(t, key, value) {
      if (typeof key === 'symbol') {
        t[key] = value;
        return true;
      }
      t[key] = coerce(value);
      return true;
    },
    defineProperty(t, key, desc) {
      if (typeof key !== 'symbol' && 'value' in desc) {
        t[key] = coerce(desc.value);
        return true;
      }
      return Reflect.defineProperty(t, key, desc);
    },
  });
}

/**
 * Kernel credentials for this process. Prefer /proc/self/status (or
 * /proc/<pid>/status); fall back to /etc/passwd + /etc/group for USER.
 */
function readProcessCreds(ctx) {
  const fromProc = (text) => {
    let uid = 0;
    let euid = 0;
    let gid = 0;
    let egid = 0;
    let groups = [0];
    for (const line of text.split('\n')) {
      if (line.startsWith('Uid:')) {
        const parts = line.slice(4).trim().split(/\s+/).map(Number);
        uid = parts[0] ?? 0;
        euid = parts[1] ?? uid;
      } else if (line.startsWith('Gid:')) {
        const parts = line.slice(4).trim().split(/\s+/).map(Number);
        gid = parts[0] ?? 0;
        egid = parts[1] ?? gid;
      } else if (line.startsWith('Groups:')) {
        const parts = line
          .slice(7)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
        if (parts.length) groups = parts;
      }
    }
    return { uid, euid, gid, egid, groups };
  };

  const tryRead = (path) => {
    try {
      const bytes = ctx.sync?.fs?.readFile?.(path);
      if (!bytes) return null;
      return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  };

  for (const path of [`/proc/self/status`, `/proc/${ctx.pid}/status`]) {
    const text = tryRead(path);
    if (text) return fromProc(text);
  }

  const name = ctx.env?.USER || ctx.env?.LOGNAME || 'root';
  const passwd = tryRead('/etc/passwd');
  if (passwd) {
    for (const line of passwd.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [user, , uidStr, gidStr] = line.split(':');
      if (user !== name) continue;
      const uid = Number(uidStr) || 0;
      const gid = Number(gidStr) || 0;
      const groups = [gid];
      const group = tryRead('/etc/group');
      if (group) {
        for (const gline of group.split('\n')) {
          if (!gline || gline.startsWith('#')) continue;
          const [gname, , ggid, members] = gline.split(':');
          const g = Number(ggid);
          if (!Number.isFinite(g)) continue;
          if (gname === name || (members && members.split(',').includes(name))) {
            if (!groups.includes(g)) groups.push(g);
          }
        }
      }
      return { uid, euid: uid, gid, egid: gid, groups };
    }
  }

  return { uid: 0, euid: 0, gid: 0, egid: 0, groups: [0] };
}

/**
 * Absolute path of the kernel `node` command (what spawn(process.execPath)
 * must run). dist/node.mjs is the shim entry, not an executable — npm-run-all,
 * cross-spawn, and test runners re-spawn via execPath and need a real bin.
 */
function resolveNodeExecPath(ctx) {
  const fs = ctx?.sync?.fs;
  const pathEnv = ctx?.env?.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  for (const dir of String(pathEnv).split(':')) {
    if (!dir) continue;
    const candidate = dir.endsWith('/') ? `${dir}node` : `${dir}/node`;
    try {
      if (fs?.exists?.(candidate)) {
        try {
          return typeof fs.realpath === 'function' ? fs.realpath(candidate) : candidate;
        } catch {
          return candidate;
        }
      }
    } catch {
      /* next PATH entry */
    }
  }
  return '/usr/bin/node';
}

class Process extends EventEmitter {
  constructor({ ctx, argv, nextTick, onExit, handles, Buffer, stdio, ppid }) {
    super();
    this._signals = new Set();
    // As Node's bootstrap: a listener for a signal name installs a handler.
    this.on('newListener', (event) => this._watchSignal(event));
    this.on('removeListener', (event) => this._unwatchSignal(event));
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
    this.env = createEnv(ctx.env);
    // Node 22.22.0's versions for what the runtime has or mirrors (zlib's
    // output is zlib 1.3.1's). No brotli, zstd, openssl, nghttp2, …: code that
    // checks for them would then try what isn't there.
    this.versions = {
      node: NODE_SHIM_VERSION,
      cldr: '47.0',
      icu: '77.1',
      modules: '127',
      napi: '10',
      tz: '2025b',
      unicode: '16.0',
      uv: '1.51.0',
      v8: '12.4.254.21-node.33',
      zlib: '1.3.1-470d3a2',
    };
    this.version = `v${NODE_SHIM_VERSION}`;
    this.release = {
      name: 'node',
      lts: 'Jod',
      sourceUrl: `https://nodejs.org/download/release/v${NODE_SHIM_VERSION}/node-v${NODE_SHIM_VERSION}.tar.gz`,
      headersUrl: `https://nodejs.org/download/release/v${NODE_SHIM_VERSION}/node-v${NODE_SHIM_VERSION}-headers.tar.gz`,
    };
    this.platform = 'linux';
    this.arch = 'x64';
    this.pid = ctx.pid;
    // From the kernel at start (ctx.ppid is asynchronous).
    this.ppid = ppid ?? 1;
    this.execPath = resolveNodeExecPath(ctx);
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

    // After process.exit() nothing more reaches stdout or stderr.
    const writeStdout = (value) => {
      if (!this._silenced) ctx.sync.write(1, toBytes(value));
    };
    const writeStderr = (value) => {
      if (!this._silenced) ctx.sync.write(2, toBytes(value));
    };
    this._writeStdout = writeStdout;
    this._writeStderr = writeStderr;

    this._nodeLib = () => loadNodeLib({ ctx });

    // process.stdin / stdout / stderr: Node's streams, made on first access.
    const io = createStdio({ ctx, process: this, Buffer, handles, info: stdio });
    this._stdio = io;
    for (const [name, get] of [
      ['stdin', io.stdin],
      ['stdout', io.stdout],
      ['stderr', io.stderr],
    ]) {
      Object.defineProperty(this, name, { configurable: true, enumerable: false, get });
    }
    // console and the runtime: through the stream once a program has it (so a
    // replaced process.stdout.write sees console.log), else straight to the fd.
    this._stdoutWrite = (value) => {
      const stream = io.made(1);
      // Node's console ignores a stream that can no longer be written.
      if (stream && (stream.writableEnded || stream.destroyed)) return;
      if (stream) stream.write(typeof value === 'string' || value instanceof Uint8Array ? value : String(value));
      else writeStdout(value);
    };
    this._stderrWrite = (value) => {
      const stream = io.made(2);
      // Node's console ignores a stream that can no longer be written.
      if (stream && (stream.writableEnded || stream.destroyed)) return;
      if (stream) stream.write(typeof value === 'string' || value instanceof Uint8Array ? value : String(value));
      else writeStderr(value);
    };

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

  /** A builtin module by id (set by the CJS loader once it has them). */
  _builtin(id) {
    if (typeof this._builtinLoader !== 'function') throw new Error(`slicc-jsh: builtin ${id} not ready`);
    return this._builtinLoader(id);
  }

  /**
   * Node's warning options, from execArgv and NODE_NO_WARNINGS (bootstrap/
   * node.js): noDeprecation & co., and the default 'warning' listener that
   * prints `(node:PID) [CODE] Name: message`.
   */
  _setupWarnings() {
    const has = (flag) => this.execArgv.includes(flag);
    if (has('--no-deprecation')) this.noDeprecation = true;
    if (has('--throw-deprecation')) this.throwDeprecation = true;
    if (has('--trace-deprecation')) this.traceDeprecation = true;
    if (has('--trace-warnings')) this.traceProcessWarnings = true;
    if (!has('--no-warnings') && this.env.NODE_NO_WARNINGS !== '1') {
      const process = this;
      this.on('warning', function onWarning(warning) {
        return process._nodeLib().warning.onWarning(warning);
      });
    }
  }

  emitWarning(warning, type, code, ctor) {
    return this._nodeLib().warning.emitWarning(warning, type, code, ctor ?? this.emitWarning);
  }

  /** fs.readFileSync(0 | '/dev/stdin'): what fd 0 has left, read synchronously. */
  _readStdinSync() {
    const chunks = [];
    if (typeof this._ctx.sync?.read === 'function') {
      for (;;) {
        const c = this._ctx.sync.read(0);
        if (!c || c.byteLength === 0) break;
        chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
      }
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  // --- signals: a listener for 'SIGINT', 'SIGWINCH', … installs a kernel
  // handler (ctx.signals); the last one removed puts the default back.
  _watchSignal(event) {
    if (typeof event !== 'string' || !(event in SIGNALS) || this._signals.has(event)) return;
    if (event === 'SIGKILL' || event === 'SIGSTOP') {
      const err = nodeError(Error, 'EINVAL', 'uv_signal_start EINVAL');
      err.errno = -22;
      err.syscall = 'uv_signal_start';
      err.stack = `Error: uv_signal_start EINVAL${err.stack.slice(err.stack.indexOf('\n'))}`;
      throw err;
    }
    const signals = this._ctx.signals;
    if (typeof signals?.on !== 'function') return;
    this._signals.add(event);
    const deliver = () => {
      const dispatch = this._dispatchSignal ?? ((fn) => queueMicrotask(fn));
      dispatch(() => {
        if (this.listenerCount(event) > 0) this.emit(event, event, SIGNALS[event]);
      });
    };
    const ready = Promise.resolve(signals.on(event, deliver)).catch(() => this._signals.delete(event));
    (this._signalReady ??= new Map()).set(event, ready);
  }

  _unwatchSignal(event) {
    if (!this._signals.has(event) || this.listenerCount(event) > 0) return;
    this._signals.delete(event);
    Promise.resolve(this._ctx.signals?.reset?.(event)).catch(() => {});
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

  /** Real kernel credentials (from /proc or /etc/passwd for USER). */
  _creds() {
    if (this._credCache) return this._credCache;
    this._credCache = readProcessCreds(this._ctx);
    return this._credCache;
  }

  getuid() {
    return this._creds().uid;
  }

  geteuid() {
    return this._creds().euid;
  }

  getgid() {
    return this._creds().gid;
  }

  getegid() {
    return this._creds().egid;
  }

  getgroups() {
    return this._creds().groups.slice();
  }

  /**
   * process.kill (lib/internal/process/per_thread.js): validates as Node does.
   * To this process: a signal with listeners is delivered to them a moment
   * later (as the kernel would); without, its default action — ignored
   * (SIGWINCH, SIGCHLD, SIGURG, SIGCONT) or the end of the program at once,
   * status 128 + n, with no 'exit' event (a signal is not process.exit()).
   * Other pids: signal 0 and any signal answer ESRCH (no synchronous view of
   * the process table yet).
   */
  kill(pid, sig = 'SIGTERM') {
    if (pid != (pid | 0)) throw ERR_INVALID_ARG_TYPE('pid', 'number', pid); // eslint-disable-line eqeqeq
    let name;
    let num;
    if (sig === (sig | 0)) {
      num = sig;
      if (num !== 0) {
        name = Object.keys(SIGNALS).find((k) => SIGNALS[k] === num);
        if (!name) throw uvError('EINVAL', -22, 'kill');
      }
    } else {
      sig = sig || 'SIGTERM';
      if (typeof sig !== 'string' || !(sig in SIGNALS)) {
        throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${sig}`);
      }
      name = sig;
      num = SIGNALS[sig];
    }
    if (Number(pid) !== this.pid) throw uvError('ESRCH', -3, 'kill');
    if (num === 0) return true;
    if (this.listenerCount(name) > 0) {
      const dispatch = this._dispatchSignal ?? ((fn) => queueMicrotask(fn));
      dispatch(() => {
        if (this.listenerCount(name) > 0) this.emit(name, name, num);
      });
      return true;
    }
    if (name === 'SIGWINCH' || name === 'SIGCHLD' || name === 'SIGURG' || name === 'SIGCONT') return true;
    // Default action: the program ends now, killed (128 + n); nothing more runs.
    const code = 128 + num;
    this._recordExit(code);
    this._silenced = true;
    try {
      this._onHardExit?.(code);
    } catch {
      /* ignore */
    }
    this._exitError = hardExitError(this._ctx, code);
    throw this._exitError;
  }

  chdir(directory) {
    if (typeof directory !== 'string') throw ERR_INVALID_ARG_TYPE('directory', 'string', directory);
    const from = this._cwd;
    const target = directory.startsWith('/') ? directory : `${from.replace(/\/$/, '')}/${directory}`;
    const fail = (code, errno, text) => {
      const err = new Error(`${code}: ${text}, chdir '${from}' -> '${directory}'`);
      Object.assign(err, { errno, code, syscall: 'chdir', path: from, dest: directory });
      throw err;
    };
    let st;
    try {
      st = this._ctx.sync?.fs?.stat?.(target);
    } catch (err) {
      if (err?.code === 'ENOTDIR') fail('ENOTDIR', -20, 'not a directory');
      if (err?.code === 'EACCES') fail('EACCES', -13, 'permission denied');
      fail('ENOENT', -2, 'no such file or directory');
    }
    if (st && !(typeof st.isDirectory === 'function' ? st.isDirectory() : st.isDirectory)) {
      fail('ENOTDIR', -20, 'not a directory');
    }
    this._cwd = this._ctx.resolve(target);
  }

  /**
   * Node's process.exit: 'exit' listeners run, then the program ends. The
   * kernel is told the status at once (see hardExitError); what still runs
   * while the throw unwinds — a user `catch` or `finally` — is silenced:
   * its output is dropped, a second exit() keeps the first status, and
   * timers and ticks are stopped.
   */
  exit(...args) {
    if (this._exitError) throw this._exitError;
    if (args.length > 0) this._assignedExitCode = assignProcessExitCode(args[0]);
    let code = numericExitCode(this._assignedExitCode);
    // Node: 'exit' listeners run first and may change process.exitCode,
    // which is the status (process.exit() inside one ends at once).
    if (!this._exiting) {
      this._exiting = true;
      try {
        this.emit('exit', code);
      } catch {
        /* ignore */
      }
      if (this._exitError) throw this._exitError;
      code = numericExitCode(this._assignedExitCode);
    }
    this._recordExit(code);
    this._silenced = true;
    try {
      this._onHardExit?.(code);
    } catch {
      /* ignore */
    }
    this._exitError = hardExitError(this._ctx, code);
    throw this._exitError;
  }

  _recordExit(code) {
    this._didExit = true;
    this._forcedExitCode = code;
    this._assignedExitCode = code;
    this._onExit?.(code);
  }
}

export function createProcess({ ctx, argv, nextTick, onExit, onHardExit, handles, Buffer, stdio, ppid }) {
  const process = new Process({ ctx, argv, nextTick, onExit, handles, Buffer, stdio, ppid });
  process._onHardExit = onHardExit;
  return {
    process,
    writeStdout: process._stdoutWrite,
    writeStderr: process._stderrWrite,
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
    /**
     * The program ends with `code` (0, or 1 for an uncaught error): Node sets
     * process.exitCode to it, emits 'exit', and ends with process.exitCode as
     * the listeners left it.
     */
    finishExit: (code) => {
      if (!process._exiting && !process._didExit) {
        process._exiting = true;
        if (code !== numericExitCode(process._assignedExitCode)) process._assignedExitCode = code;
        try {
          process.emit('exit', code);
        } catch {
          /* ignore */
        }
      }
      if (process._didExit) return numericExitCode(process._forcedExitCode);
      return numericExitCode(process._assignedExitCode ?? code);
    },
  };
}
