import { EventEmitter } from './builtins/events.mjs';
import { SIGNALS } from './signals.mjs';
import { assignProcessExitCode, hardExitError, NodeExitError, numericExitCode } from './exit.mjs';
import { createStdio } from './stdio.mjs';
import { bufferBytes } from './buffer.mjs';
import { loadNodeLib } from './node-lib.mjs';
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, nodeError, validateUint32 } from './node-errors.mjs';

/** Node version reported by the shim (M1 target). */
export const NODE_SHIM_VERSION = '22.22.0';


function uvError(code, errno, syscall) {
  const err = new Error(`${syscall} ${code}`);
  Object.assign(err, { errno, code, syscall });
  return err;
}

export { SIGNALS } from './signals.mjs';

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

// Named `process` (V8's messages name an instance #<process>, as Node's),
// through a property key: a binding of that name would be renamed by the bundler.
const Process = { process: class extends EventEmitter {
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
    // Node's: a plain data property.
    this.title = 'node';
    // Node's: null until lib/domain.js makes it its accessor.
    this.domain = null;
    // Node's: [object process], its constructor named process.
    Object.defineProperty(this, Symbol.toStringTag, { value: 'process', writable: true, enumerable: false, configurable: false });
    this._ctx = ctx;
    this._onExit = onExit;

    this.argv = argv.slice();
    this.argv0 = argv[0] ?? 'node';
    this.env = createEnv(ctx.env);
    // Node 22.22.0's versions for what the runtime has or mirrors (zlib's
    // output is zlib 1.3.1's; the brotli and zstd decoders are 1.1.0's and
    // 1.5.7's, ported: with them, a client such as got asks for `br` and
    // `zstd`). No openssl, nghttp2, …: code that checks for them would then
    // try what isn't there.
    this.versions = {
      node: NODE_SHIM_VERSION,
      brotli: '1.1.0',
      cldr: '47.0',
      icu: '77.1',
      modules: '127',
      napi: '10',
      tz: '2025b',
      unicode: '16.0',
      uv: '1.51.0',
      v8: '12.4.254.21-node.33',
      zlib: '1.3.1-470d3a2',
      zstd: '1.5.7',
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
    const tickQueue = nextTick;
    this.nextTick = function nextTick(callback, ...args) {
      return tickQueue.nextTick(callback, ...args);
    };
    // Its own name whatever the bundler calls it.
    Object.defineProperty(this.nextTick, 'name', { value: 'nextTick' });
    // The kernel's umask, found when first asked for; process.umask(mask)
    // then changes jsh's own (the kernel's, which children inherit, stays).
    this._umask = undefined;
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

    this._nodeLib = () => loadNodeLib({ ctx, process: this });

    // process.stdin / stdout / stderr: Node's streams, made on first access.
    this._Buffer = Buffer;
    this._handles = handles;
    const io = createStdio({ ctx, process: this, Buffer, handles, info: stdio });
    this._stdio = io;
    for (const [name, get] of [
      ['stdin', io.stdin],
      ['stdout', io.stdout],
      ['stderr', io.stderr],
    ]) {
      Object.defineProperty(this, name, { configurable: true, enumerable: true, get });
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
    const has = (flag) => (this._options ?? this.execArgv).includes(flag);
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
        // process.report.reportOnSignal: the report first, as Node's handler.
        if (this._reportSignal === event) this._reportSignalWrite?.();
        if (this.listenerCount(event) > 0) this.emit(event, event, SIGNALS[event]);
      });
    };
    const ready = Promise.resolve(signals.on(event, deliver)).catch(() => this._signals.delete(event));
    (this._signalReady ??= new Map()).set(event, ready);
  }

  /** process.report's signal (null: none): watched while it is set. */
  _setReportSignal(name, write) {
    const old = this._reportSignal;
    this._reportSignal = name ?? undefined;
    this._reportSignalWrite = write;
    if (old && old !== name) this._unwatchSignal(old);
    if (name) this._watchSignal(name);
  }

  _unwatchSignal(event) {
    if (!this._signals.has(event) || this.listenerCount(event) > 0 || this._reportSignal === event) return;
    this._signals.delete(event);
    // The last listener gone, the signal's default action is back, as in
    // Node: SIGPIPE too (a write to a dead pipe then ends the program, 141),
    // though Node starts with it ignored. SIGUSR1 stays the inspector's (ignored).
    const back = event === 'SIGUSR1' ? this._ctx.signals?.ignore : this._ctx.signals?.reset;
    Promise.resolve(back?.call(this._ctx.signals, event)).catch(() => {});
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

  /**
   * Only what is measured; 0 where nothing here can measure a field (Node's
   * way with a figure the platform lacks, as os.loadavg() on Windows), never
   * an estimate. The kernel's ctx.memory(), where it has one, measures the
   * program's own isolate; without it a process worker has no heap figures
   * (Chromium's performance.memory is the window's only), and `arrayBuffers`
   * counts the Buffers jsh allocated, a lower bound `external` includes.
   */
  memoryUsage() {
    const measured = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    let k = {};
    try {
      k = (typeof this._ctx.memory === 'function' && this._ctx.memory()) || {};
    } catch {}
    const perf = globalThis.performance?.memory;
    const heapUsed = measured(k.heapUsed) ?? measured(perf?.usedJSHeapSize) ?? 0;
    const heapTotal = Math.max(measured(k.heapTotal) ?? measured(perf?.totalJSHeapSize) ?? 0, heapUsed);
    const arrayBuffers = measured(k.arrayBuffers) ?? bufferBytes(this._Buffer);
    const external = Math.max(measured(k.external) ?? 0, arrayBuffers);
    return { rss: measured(k.rss) ?? 0, heapTotal, heapUsed, external, arrayBuffers };
  }

  availableMemory() {
    return 8 * 1024 * 1024 * 1024;
  }

  /** No cgroup limit here (Node: 0 when unconstrained). */
  constrainedMemory() {
    return 0;
  }

  resourceUsage() {
    const { user, system } = this.cpuUsage();
    return {
      userCPUTime: user,
      systemCPUTime: system,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    };
  }

  threadCpuUsage(previousValue) {
    return this.cpuUsage(previousValue);
  }

  /** Node's: the kinds of what keeps the loop alive ('Timeout', 'FSReqCallback', …). */
  getActiveResourcesInfo() {
    // Node's order: requests, handles, then timers and immediates.
    const NAMES = { promise: 'FSReqCallback', stdin: 'TTYWrap', child: 'ProcessWrap', socket: 'TCPWrap', server: 'TCPServerWrap', StatWatcher: 'StatWatcher', FSEventWrap: 'FSEventWrap' };
    const out = [];
    const timers = [];
    for (const h of this._handles?.list?.() ?? []) {
      if (h.kind === 'Timeout' || h.kind === 'Immediate') timers.push(h.kind);
      else if (h.kind === 'stdin') out.push(this._stdio?.isatty?.(0) ? 'TTYWrap' : 'PipeWrap');
      else if (NAMES[h.kind]) out.push(NAMES[h.kind]);
    }
    return [...out, ...timers.filter((k) => k === 'Timeout'), ...timers.filter((k) => k === 'Immediate')];
  }

  _getActiveHandles() {
    return [];
  }

  _getActiveRequests() {
    return [];
  }

  /** process.getBuiltinModule(id) (Node 22.3+): a builtin by id, 'node:' or not; undefined if none. */
  getBuiltinModule(id) {
    if (typeof id !== 'string') throw ERR_INVALID_ARG_TYPE('id', 'string', id);
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    try {
      return this._builtin(bare);
    } catch {
      return undefined;
    }
  }

  hasUncaughtExceptionCaptureCallback() {
    return typeof this._uncaughtCapture === 'function';
  }

  setUncaughtExceptionCaptureCallback(fn) {
    if (fn === null) {
      this._uncaughtCapture = undefined;
      return;
    }
    if (typeof fn !== 'function') throw ERR_INVALID_ARG_TYPE('fn', ['Function', 'null'], fn);
    if (this._uncaughtCapture) {
      throw nodeError(
        Error,
        'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET',
        '`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active'
      );
    }
    this._uncaughtCapture = fn;
  }

  /** Node: ref()/unref() an object that has them (a timer, a server). */
  ref(maybeRefable) {
    if (typeof maybeRefable?.ref === 'function') maybeRefable.ref();
  }

  unref(maybeRefable) {
    if (typeof maybeRefable?.unref === 'function') maybeRefable.unref();
  }

  /** process.abort(): SIGABRT's default action, whatever listens for it (Node's abort()). */
  abort() {
    // A JS SIGABRT listener doesn't catch it: the kernel's handler goes first.
    try {
      Promise.resolve(this._ctx.signals?.reset?.('SIGABRT')).catch(() => {});
    } catch {
      /* no signals */
    }
    // slicc-kernel 1.72.0+: the kernel's own default action, at once (the
    // reset above takes effect synchronously from 1.69.0 on).
    if (typeof this._ctx?.sync?.kill === 'function') {
      try {
        this._ctx.sync.kill(this._ctx.pid ?? this.pid, 'SIGABRT');
      } catch {
        /* fall through */
      }
    }
    this._defaultSignalAction('SIGABRT', SIGNALS.SIGABRT);
  }

  /** process.loadEnvFile(path = './.env'): its variables, those not already set. */
  loadEnvFile(path = './.env') {
    const fs = this._builtin('fs');
    const parsed = this._builtin('util').parseEnv(fs.readFileSync(path, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (!(k in this.env)) this.env[k] = v;
  }

  _rawDebug(...args) {
    this._writeStderr(`${this._builtin('util').format(...args)}\n`);
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
    // slicc-kernel 1.92.0 (#564): the kernel's own umask, which children
    // inherit and the kernel applies to what the program creates.
    const sync = this._ctx?.sync;
    const kernel = typeof sync?.umask === 'function';
    if (mask === undefined) {
      if (kernel) return sync.umask();
      this._umask ??= this._kernelUmask();
      return this._umask;
    }
    // Node's parseFileMode: a uint32, or an octal string.
    let value = mask ?? undefined;
    if (typeof value === 'string') {
      if (!/^[0-7]+$/.test(value)) throw ERR_INVALID_ARG_VALUE('mask', value, 'must be a 32-bit unsigned integer or an octal string');
      value = Number.parseInt(value, 8);
    }
    validateUint32(value, 'mask');
    if (kernel) return sync.umask(value & 0o777);
    this._umask ??= this._kernelUmask();
    const prev = this._umask;
    this._umask = value & 0o777;
    return prev;
  }

  /**
   * The process's umask in the kernel: /proc/self/status's `Umask:` line
   * where JS programs have /proc (slicc-kernel 1.89.0+, #529); before that
   * the mode the kernel gives a directory made to find out, once, in /tmp
   * (022 if that fails too).
   */
  _kernelUmask() {
    if (typeof this._ctx?.sync?.umask === 'function') return this._ctx.sync.umask();
    if (this._kumask === undefined) {
      this._kumask = 0o022;
      const fs = this._ctx?.sync?.fs;
      try {
        const m = /^Umask:\s*([0-7]+)/m.exec(new TextDecoder().decode(fs.readFile('/proc/self/status')));
        if (m) {
          this._kumask = Number.parseInt(m[1], 8) & 0o777;
          return this._kumask;
        }
      } catch {
        /* no /proc for JS programs: probe */
      }
      const dir = `/tmp/.jsh-umask-${this.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        fs.mkdir(dir);
        try {
          const mode = fs.stat(dir).mode;
          if (typeof mode === 'number') this._kumask = ~mode & 0o777;
        } finally {
          fs.rm(dir);
        }
      } catch {
        /* the kernel's default */
      }
    }
    return this._kumask;
  }

  cwd() {
    return this._cwd;
  }

  /** The kernel's credentials (ctx.sync.cred, else /proc or /etc/passwd for USER). */
  _creds() {
    if (this._credCache) return this._credCache;
    // slicc-kernel's ctx.sync.cred() where it has it, else /proc.
    const cred = typeof this._ctx.sync?.cred === 'function' ? this._ctx.sync.cred() : undefined;
    this._credCache =
      cred && typeof cred === 'object'
        ? { uid: cred.ruid, euid: cred.euid, gid: cred.rgid, egid: cred.egid, groups: [...(cred.groups ?? [])] }
        : readProcessCreds(this._ctx);
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
    // Node's GetGroups: the supplementary groups, the effective gid added
    // when it isn't among them.
    const { groups, egid } = this._creds();
    return groups.includes(egid) ? groups.slice() : [...groups, egid];
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
    // slicc-kernel 1.72.0+ (ai-ecoverse/slicc-kernel#444): a synchronous kill.
    if (typeof this._ctx?.sync?.kill === 'function') return this._killSync(Number(pid), name, num);
    if (Number(pid) !== this.pid) throw uvError('ESRCH', -3, 'kill');
    if (num === 0) return true;
    // Node: a listener under any name of that number (SIGIO/SIGPOLL,
    // SIGABRT/SIGIOT) handles it, each emitted under its own name.
    // In the order the listeners' names were first added, as Node's wraps.
    const handled = this.eventNames().filter(
      (k) => typeof k === 'string' && SIGNALS[k] === num && this.listenerCount(k) > 0
    );
    if (handled.length > 0) {
      const dispatch = this._dispatchSignal ?? ((fn) => queueMicrotask(fn));
      dispatch(() => {
        for (const k of handled) if (this.listenerCount(k) > 0) this.emit(k, k, num);
      });
      return true;
    }
    // SIGUSR1 starts Node's inspector rather than ending it; there is none here.
    if (name === 'SIGWINCH' || name === 'SIGCHLD' || name === 'SIGURG' || name === 'SIGCONT' || name === 'SIGUSR1') return true;
    // Job-control stops: the kernel stops the process (on a turn of its own)
    // and SIGCONT resumes it where it was, as in Node: no exit.
    if (name === 'SIGSTOP' || name === 'SIGTSTP' || name === 'SIGTTIN' || name === 'SIGTTOU') {
      if (typeof this._ctx?.kill === 'function') {
        Promise.resolve(this._ctx.kill(this._ctx.pid ?? this.pid, name)).catch(() => {});
      }
      return true;
    }
    this._defaultSignalAction(name, num);
  }

  /**
   * process.kill on ctx.sync.kill. A signal that ends this process (itself,
   * `0` for its group, `-pgid` of its own group) ends it inside the call, as
   * Node's kill(2) does: its writes reach their descriptors, terminal modes
   * are put back and the parent sees the signal; no `finally`, microtask,
   * timer or 'exit' listener runs. A signal with a JS listener runs it
   * asynchronously, an ignored one does nothing, a stop signal stops it.
   */
  _killSync(pid, name, num) {
    if (pid === this.pid) {
      if (num === 0) return true;
      const handled = this.eventNames().filter(
        (k) => typeof k === 'string' && SIGNALS[k] === num && this.listenerCount(k) > 0
      );
      if (handled.length > 0) {
        const dispatch = this._dispatchSignal ?? ((fn) => queueMicrotask(fn));
        dispatch(() => {
          for (const k of handled) if (this.listenerCount(k) > 0) this.emit(k, k, num);
        });
        return true;
      }
      // SIGUSR1 starts Node's inspector rather than ending it; there is none.
      if (name === 'SIGUSR1') return true;
    }
    try {
      this._ctx.sync.kill(pid, num === 0 ? 0 : name);
    } catch (err) {
      const code = err?.code ?? 'ESRCH';
      throw uvError(code, { EPERM: -1, ESRCH: -3, EINVAL: -22 }[code] ?? -3, 'kill');
    }
    return true;
  }

  /**
   * A signal's default action on this process: it dies of it now, as Node's
   * does (its parent sees the signal, not a status); nothing more runs.
   */
  _defaultSignalAction(name, num) {
    const code = 128 + num;
    this._recordExit(code);
    this._silenced = true;
    try {
      this._onHardExit?.(code);
    } catch {
      /* ignore */
    }
    this._exitError = this._startSignalDeath(name) ? new NodeExitError(code) : hardExitError(this._ctx, code);
    throw this._exitError;
  }

  /**
   * Have the kernel deliver `name` to this process, so it dies of it as
   * Node's does (its parent sees the signal). A JS program's default action
   * happens on an event-loop turn, so the program unwinds (silenced, with
   * timers and ticks stopped) and run.mjs waits for it (`_signalDeath`).
   * False on a kernel that can't signal.
   */
  _startSignalDeath(name) {
    const ctx = this._ctx;
    if (typeof ctx?.kill !== 'function') return false;
    try {
      this._signalDeath = Promise.resolve(ctx.kill(ctx.pid ?? this.pid, name)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  chdir(directory) {
    if (typeof directory !== 'string') throw ERR_INVALID_ARG_TYPE('directory', 'string', directory);
    if (directory === '') {
      // uv_chdir('') is ENOENT.
      const err = new Error(`ENOENT: no such file or directory, chdir '${this._cwd}' -> ''`);
      Object.assign(err, { errno: -2, code: 'ENOENT', syscall: 'chdir', path: this._cwd, dest: '' });
      throw err;
    }
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
    this._flushAtExit();
    this._silenced = true;
    try {
      this._onHardExit?.(code);
    } catch {
      /* ignore */
    }
    this._exitError = hardExitError(this._ctx, code);
    throw this._exitError;
  }

  /**
   * process.reallyExit (the binding under process.exit): the program ends
   * now with `code`, no 'exit' event.
   */
  _reallyExit(code) {
    if (this._exitError) throw this._exitError;
    code = Number(code) | 0;
    this._exiting = true;
    this._recordExit(code);
    this._flushAtExit();
    this._silenced = true;
    try {
      this._onHardExit?.(code);
    } catch {
      /* ignore */
    }
    this._exitError = hardExitError(this._ctx, code);
    throw this._exitError;
  }

  /**
   * process.execve's call (the arguments checked): this program becomes
   * `execPath`. The kernel has no exec for a JS program, so the command runs
   * to its end on this process's stdio (ctx.sync.run) and the program ends
   * as it did, with no 'exit' event: its status, or the signal it died of.
   * One that can't start is Node's fatal error (SIGABRT).
   */
  _execve(execPath, args, env) {
    const run = this._ctx.sync?.run;
    if (typeof run !== 'function') {
      throw nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'The feature process.execve is unavailable on the current platform, which is being used to run Node.js');
    }
    const r = run.call(this._ctx.sync, {
      argv: [execPath, ...args.slice(1)],
      ...(args.length > 0 ? { argv0: args[0] } : {}),
      env,
      cwd: this.cwd(),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (r?.error) {
      const code = r.error.code ?? 'ENOENT';
      this._writeStderr(
        `node:internal/process/per_thread:330\n    _execve(execPath, args, envArray);\n    ^\n\nprocess.execve failed with error code ${code}\n`
      );
      return this._ctx.sync.kill(this.pid, 'SIGABRT');
    }
    if (r?.signal) return this._ctx.sync.kill(this.pid, r.signal);
    return this._reallyExit(r?.status ?? 0);
  }

  /** What must be written before the program ends (IPC channels' queued writes). */
  _flushAtExit() {
    for (const flush of this._exitFlush ?? []) {
      try {
        flush();
      } catch {
        /* best effort */
      }
    }
  }

  _recordExit(code) {
    this._didExit = true;
    this._forcedExitCode = code;
    this._assignedExitCode = code;
    this._onExit?.(code);
  }
} }.process;
Object.defineProperty(Process, 'name', { value: 'process' });
// Node's process.constructor is a plain function (its C++ template's), so
// it can be called without new: jest-util's createProcessObject calls each
// constructor up the prototype chain on its copy of process.
// (Named by its key, which the bundler keeps: V8's messages use that name.)
const processConstructor = { process: function () {} }.process;
// process instanceof process.constructor, as inspect asks of a constructor.
processConstructor.prototype = Process.prototype;
Object.defineProperty(Process.prototype, 'constructor', {
  value: processConstructor,
  writable: true,
  enumerable: false,
  configurable: true,
});

// Node's process methods are own properties that work from any receiver
// (yargs keeps `cwd: process.cwd` and calls it detached).
const OWN_INTERNALS = ['_getActiveHandles', '_getActiveRequests', '_rawDebug'];

/**
 * jsh's own state on process, set at start or later (the CJS loader, run.mjs):
 * none of Node's `process` keys, so they are kept out of `Object.keys(process)`
 * and `for … in`. Declared up front, so a later assignment stays hidden too.
 */
const JSH_INTERNALS = [
  '_assignedExitCode', '_broadcastChannel', '_ports', '_exitFlush', '_clusterWorker', '_Buffer', '_builtinLoader', '_cpuPrev', '_credCache', '_ctx', '_cwd', '_didExit',
  '_dispatchSignal', '_evalCode', '_exitError', '_forcedExitCode', '_handles', '_nodeLib', '_onExit',
  '_onHardExit', '_options', '_reportSignal', '_reportSignalWrite', '_signalDeath', '_signalReady', '_signals', '_silenced', '_startedAt', '_stderrWrite',
  '_stdio', '_stdoutWrite', '_umask', '_kumask', '_uncaughtCapture', '_writeStderr', '_writeStdout',
];

/**
 * Node's shape: its own state hidden (above), and what Node has as own
 * enumerable properties of process so: `exitCode` and `_exiting` as
 * accessors (`title` is a data property, stdin/stdout/stderr and the methods
 * are made own where they are defined).
 */
function nodeShape(process) {
  for (const name of JSH_INTERNALS) {
    const desc = Object.getOwnPropertyDescriptor(process, name);
    if (desc) Object.defineProperty(process, name, { ...desc, enumerable: false });
    else Object.defineProperty(process, name, { value: undefined, writable: true, enumerable: false, configurable: true });
  }
  const proto = Process.prototype;
  // Node's read-only members (an assignment throws in strict code).
  for (const [name, configurable] of [
    ['argv0', false],
    ['pid', true],
    ['version', true],
    ['versions', true],
    ['arch', true],
    ['platform', true],
    ['release', true],
    ['config', true],
    ['features', false],
  ]) {
    const desc = Object.getOwnPropertyDescriptor(process, name);
    if (desc && 'value' in desc) Object.defineProperty(process, name, { value: desc.value, writable: false, enumerable: true, configurable });
  }
  // Node's ppid: asked of the OS on each read (a parent that ends makes it
  // 1), and an assignment changes nothing. /proc says it on slicc-kernel
  // 1.89.0+; before that, the value at start.
  const startPpid = process.ppid;
  let procPpid = true;
  Object.defineProperty(process, 'ppid', {
    get() {
      if (procPpid) {
        try {
          const m = /^PPid:\s*(\d+)/m.exec(new TextDecoder().decode(process._ctx.sync.fs.readFile('/proc/self/status')));
          if (m) return Number(m[1]);
        } catch {
          /* no /proc for JS programs */
        }
        procPpid = false;
      }
      return startPpid;
    },
    set() {},
    enumerable: true,
    configurable: true,
  });
  // Each version is read-only too, as Node's.
  for (const key of Object.keys(process.versions ?? {})) {
    Object.defineProperty(process.versions, key, { value: process.versions[key], writable: false, enumerable: true, configurable: true });
  }
  const { get, set } = Object.getOwnPropertyDescriptor(proto, 'exitCode');
  Object.defineProperty(process, 'exitCode', { get, set, enumerable: true, configurable: false });
  let exiting = process._exiting === true;
  Object.defineProperty(process, '_exiting', {
    get: () => exiting,
    set: (value) => {
      exiting = value;
    },
    enumerable: true,
    configurable: true,
  });
}
const NODE_NAMES = { cwd: 'wrappedCwd', chdir: 'wrappedChdir', umask: 'wrappedUmask' };
const NODE_LENGTHS = { exit: 1, kill: 2 };

function bindOwnMethods(process) {
  for (const name of Object.getOwnPropertyNames(Process.prototype)) {
    if (name === 'constructor' || (name.startsWith('_') && !OWN_INTERNALS.includes(name))) continue;
    const desc = Object.getOwnPropertyDescriptor(Process.prototype, name);
    if (typeof desc.value !== 'function' || Object.prototype.hasOwnProperty.call(process, name)) continue;
    const method = desc.value;
    const bound = {
      [name](...args) {
        return Reflect.apply(method, process, args);
      },
    }[name];
    // Node's names and lengths (its cwd/chdir/umask are wrappers).
    if (NODE_NAMES[name]) Object.defineProperty(bound, 'name', { value: NODE_NAMES[name] });
    Object.defineProperty(bound, 'length', { value: NODE_LENGTHS[name] ?? method.length });
    Object.defineProperty(process, name, { value: bound, writable: true, enumerable: true, configurable: true });
  }
  // As Node's: process.memoryUsage.rss().
  process.memoryUsage.rss = () => process.memoryUsage().rss;
}

export function createProcess({ ctx, argv, nextTick, onExit, onHardExit, handles, Buffer, stdio, ppid }) {
  const process = new Process({ ctx, argv, nextTick, onExit, handles, Buffer, stdio, ppid });
  bindOwnMethods(process);
  process._onHardExit = onHardExit;
  nodeShape(process);
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
      process._flushAtExit();
      if (process._didExit) return numericExitCode(process._forcedExitCode);
      return numericExitCode(process._assignedExitCode ?? code);
    },
  };
}
