/**
 * Minimal `child_process`: spawn / execFile / exec on top of ctx.spawn.
 * Sync forms and fork stay ERR_NOT_SUPPORTED.
 */
import { trackPromise } from '../async-handles.mjs';
import { createPath } from '../path.mjs';
import { EventEmitter } from './events.mjs';

/** Same symbol util.promisify reads (`nodejs.util.promisify.custom`). */
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

/**
 * Resolve spawn/exec cwd like Node: relative paths are against process.cwd(),
 * not `/` (cert fx/m9/relcwd.js).
 */
function resolveSpawnCwd(path, cwd) {
  if (cwd == null) return path.resolve();
  return path.resolve(String(cwd));
}

/**
 * Stat the resolved cwd before spawn (cert fx/m9/relcwd2.js).
 * Missing → ENOENT (async 'error', like a missing command). Not a directory →
 * ENOTDIR (Node throws synchronously from spawn/execFile).
 * @returns {'ENOENT' | 'ENOTDIR' | null}
 */
function checkSpawnCwd(ctx, cwdAbs) {
  try {
    const st = ctx.sync.fs.stat(cwdAbs);
    if (st && st.isDirectory) return null;
    return 'ENOTDIR';
  } catch (err) {
    if (err?.code === 'ENOTDIR') return 'ENOTDIR';
    return 'ENOENT';
  }
}

function enotdirSpawnError() {
  const err = new Error('spawn ENOTDIR');
  err.code = 'ENOTDIR';
  err.errno = -20;
  err.syscall = 'spawn';
  return err;
}

/**
 * Node's util.promisify(exec|execFile) resolves to `{ stdout, stderr }`, not
 * the multi-arg callback tuple. Attach via promisify.custom (seven comparison
 * case `child-process-async`).
 */
function customPromiseExecFunction(orig) {
  return function (...args) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.child = orig(...args, (err, stdout, stderr) => {
      if (err != null) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    return promise;
  };
}

const SIGNAL_NAMES = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  10: 'SIGUSR1',
  12: 'SIGUSR2',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  17: 'SIGCHLD',
  18: 'SIGCONT',
  19: 'SIGSTOP',
  20: 'SIGTSTP',
};

const SIGNAL_NUMBERS = Object.fromEntries(
  Object.entries(SIGNAL_NAMES).map(([n, name]) => [name, Number(n)])
);

function notSupported(name) {
  const err = new Error(`slicc-jsh: child_process.${name} is not supported yet`);
  err.code = 'ERR_NOT_SUPPORTED';
  throw err;
}

function isExitError(err) {
  return err?.name === 'NodeExitError';
}

function normalizeArgs(file, args, options, callback) {
  if (typeof args === 'function') {
    return { args: [], options: {}, callback: args };
  }
  if (typeof options === 'function') {
    return { args: Array.isArray(args) ? args : [], options: {}, callback: options };
  }
  if (args != null && !Array.isArray(args) && typeof args === 'object') {
    return { args: [], options: args, callback: typeof options === 'function' ? options : callback };
  }
  return {
    args: Array.isArray(args) ? args.map(String) : [],
    options: options && typeof options === 'object' ? options : {},
    callback: typeof callback === 'function' ? callback : undefined,
  };
}

function normalizeStdio(stdio) {
  if (stdio === undefined) return ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') return [stdio, stdio, stdio];
  if (Array.isArray(stdio)) {
    return [stdio[0] ?? 'pipe', stdio[1] ?? 'pipe', stdio[2] ?? 'pipe'];
  }
  return ['pipe', 'pipe', 'pipe'];
}

function toKernelStdio(mode) {
  if (mode === 'pipe' || mode === 'overlapped') return 'pipe';
  if (mode === 'ignore' || mode === null || mode === undefined || mode === 'null') return 'null';
  if (mode === 'inherit') return 'inherit';
  if (typeof mode === 'number') return mode;
  const err = new Error(`The argument 'stdio' is invalid. Received ${String(mode)}`);
  err.code = 'ERR_INVALID_ARG_VALUE';
  throw err;
}

function signalName(sig) {
  if (sig == null) return null;
  if (typeof sig === 'string') return sig.startsWith('SIG') ? sig : `SIG${sig}`;
  if (typeof sig === 'number') return SIGNAL_NAMES[sig] ?? String(sig);
  return null;
}

/** Decode encoding for exec/execFile callbacks (Node default: utf8). */
function decodeOutput(buf, encoding) {
  if (encoding === 'buffer' || encoding === null) return buf;
  const enc = encoding === undefined ? 'utf8' : encoding;
  return buf.toString(enc);
}

function spawnError(command, args, code, message) {
  const err = new Error(message ?? `spawn ${command} ${code}`);
  err.code = code;
  err.errno = code === 'ENOENT' ? -2 : code === 'ENOTDIR' ? -20 : undefined;
  err.syscall = `spawn ${command}`;
  err.path = command;
  err.spawnargs = args;
  return err;
}

/** Emit spawn ENOENT then close(-2), matching Node (missing command or cwd). */
function failSpawnEnoent(child, process, handles, file, argv) {
  const error = spawnError(file, argv, 'ENOENT', `spawn ${file} ENOENT`);
  try {
    child.stdout?.push?.(null);
  } catch {
    /* ignore */
  }
  try {
    child.stderr?.push?.(null);
  } catch {
    /* ignore */
  }
  process.nextTick(() => {
    try {
      child.emit('error', error);
    } catch {
      /* ignore */
    }
    child.exitCode = -2;
    child._markClosing?.();
    setTimeout(() => {
      try {
        child.emit('close', -2, null);
      } catch {
        /* ignore */
      }
      child._release?.();
      handles.notify?.();
    }, 20);
  });
}

/**
 * @param {{ ctx: object, process: object, Buffer: object, handles: object, getStream: () => object }} deps
 */
export function createChildProcess({ ctx, process, Buffer, handles, getStream }) {
  const path = createPath(() => process.cwd());

  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = null;
      this.stdout = null;
      this.stderr = null;
      this.pid = undefined;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.connected = false;
      this.spawnfile = '';
      this.spawnargs = [];
      this.#kernel = null;
      this.#handle = null;
      this.#closing = false;
      this.#exited = false;
    }

    #kernel;
    #handle;
    #closing;
    #exited;

    kill(signal = 'SIGTERM') {
      // Node: after the child has exited, kill() returns false and does not throw.
      if (this.#exited || this.#closing || !this.#kernel) return false;
      const name = signalName(signal) ?? 'SIGTERM';
      this.killed = true;
      try {
        const ret = this.#kernel.kill(name);
        // Kernel kill is async; swallow post-exit ESRCH races (Node returns false).
        if (ret != null && typeof ret.then === 'function') {
          ret.catch(() => {
            /* ignore */
          });
        }
        return ret !== false;
      } catch {
        return false;
      }
    }

    ref() {
      if (this.#handle) handles.add(this.#handle);
      return this;
    }

    unref() {
      if (this.#handle) handles.delete(this.#handle);
      return this;
    }

    /** @internal */
    _bindKernel(child) {
      this.#kernel = child;
      this.pid = child.pid;
      this.#handle = { kind: 'child', pid: child.pid };
      handles.add(this.#handle);
    }

    /** @internal */
    _release() {
      if (this.#handle) {
        handles.delete(this.#handle);
        this.#handle = null;
      }
    }

    /** @internal */
    _markClosing() {
      this.#closing = true;
      this.#exited = true;
    }

    get _closing() {
      return this.#closing;
    }
  }

  /** Create pipe Readable immediately (Node exposes .stdout before spawn finishes). */
  function createPipeReadable() {
    const { Readable } = getStream();
    const r = new Readable({ read() {} });
    r._sliccPump = async (webStream) => {
      if (!webStream) {
        r.push(null);
        return;
      }
      try {
        const reader = webStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk =
            value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
          r.push(chunk);
        }
        r.push(null);
      } catch (err) {
        r.destroy(err);
      }
    };
    return r;
  }

  /** Create pipe Writable that buffers until the kernel stdin writer is ready. */
  function createPipeWritable() {
    const { Writable } = getStream();
    let writer = null;
    const pending = [];
    let ended = false;
    const w = new Writable({
      write(chunk, _enc, cb) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        if (!writer) {
          pending.push({ bytes, cb });
          return;
        }
        writer.write(bytes).then(() => cb(), cb);
      },
      final(cb) {
        ended = true;
        if (!writer) {
          pending.push({ end: true, cb });
          return;
        }
        writer.close().then(() => cb(), cb);
      },
      destroy(err, cb) {
        if (writer) writer.abort(err).then(() => cb(err), () => cb(err));
        else cb(err);
      },
    });
    w._sliccAttach = (webStream) => {
      if (!webStream) {
        for (const p of pending) p.cb?.(new Error('stdin not available'));
        pending.length = 0;
        return;
      }
      writer = webStream.getWriter();
      for (const p of pending) {
        if (p.end) writer.close().then(() => p.cb(), p.cb);
        else writer.write(p.bytes).then(() => p.cb(), p.cb);
      }
      pending.length = 0;
      if (ended && pending.length === 0) {
        /* already drained via end entries */
      }
    };
    return w;
  }

  function prepareStdio(child, stdio) {
    const [inMode, outMode, errMode] = stdio;
    if (toKernelStdio(inMode) === 'pipe') child.stdin = createPipeWritable();
    if (toKernelStdio(outMode) === 'pipe') child.stdout = createPipeReadable();
    if (toKernelStdio(errMode) === 'pipe') child.stderr = createPipeReadable();
  }

  function connectStdio(child, kernelChild) {
    child.stdin?._sliccAttach?.(kernelChild.stdin);
    const pumps = [];
    if (child.stdout?._sliccPump) pumps.push(child.stdout._sliccPump(kernelChild.stdout));
    if (child.stderr?._sliccPump) pumps.push(child.stderr._sliccPump(kernelChild.stderr));
    child._stdioPumps = Promise.all(pumps);
  }

  function safeEmit(child, event, ...args) {
    try {
      child.emit(event, ...args);
    } catch (err) {
      // process.exit() in a ChildProcess handler throws NodeExitError — treat as
      // a clean exit (already recorded). Do not print or turn into rc 1.
      if (isExitError(err)) return err;
      throw err;
    }
    return null;
  }

  function finish(child, code, signal) {
    if (child._closing) return;
    child._markClosing();
    child.exitCode = code;
    child.signalCode = signal;
    const exitErr = safeEmit(child, 'exit', code, signal);
    if (exitErr) {
      child._release();
      handles.notify?.();
      return;
    }
    const after = child._stdioPumps ?? Promise.resolve();
    trackPromise(handles, after);
    after.finally(() => {
      const closeErr = safeEmit(child, 'close', code, signal);
      child._release();
      handles.notify?.();
      if (closeErr) return;
    });
  }

  function decodeWait(status) {
    const sigNum = status?.signal;
    if (sigNum != null && sigNum !== 0) {
      return { code: null, signal: SIGNAL_NAMES[sigNum] ?? String(sigNum) };
    }
    const code = typeof status?.status === 'number' ? status.status : 0;
    // Kernel may report 128+n without a signal field (WIFSIGNALED).
    if (code > 128 && code < 128 + 32 && SIGNAL_NAMES[code - 128]) {
      return { code: null, signal: SIGNAL_NAMES[code - 128] };
    }
    return { code, signal: null };
  }

  function startSpawn(child, file, args, options, stdio) {
    // spawn / exec / execFile / (future sync) all go through here.
    const cwd = resolveSpawnCwd(path, options.cwd);
    const env = options.env ? { ...options.env } : { ...process.env };
    const argv = [file, ...args];
    child.spawnfile = file;
    child.spawnargs = argv;

    // Re-check in startSpawn so a cwd that vanishes between spawn() and the
    // tick still fails; ENOTDIR already threw from spawn() when applicable.
    if (options.cwd != null) {
      const bad = checkSpawnCwd(ctx, cwd);
      if (bad === 'ENOENT') {
        failSpawnEnoent(child, process, handles, file, args);
        return;
      }
      if (bad === 'ENOTDIR') {
        // Should have thrown in spawn(); treat like ENOENT path if we get here.
        const error = enotdirSpawnError();
        process.nextTick(() => {
          safeEmit(child, 'error', error);
          finish(child, 1, null);
        });
        return;
      }
    }

    const spawnPromise = ctx.spawn({
      argv,
      cwd,
      env,
      stdin: toKernelStdio(stdio[0]),
      stdout: toKernelStdio(stdio[1]),
      stderr: toKernelStdio(stdio[2]),
    });
    trackPromise(handles, spawnPromise);

    spawnPromise.then(
      (kernelChild) => {
        child._bindKernel(kernelChild);
        connectStdio(child, kernelChild);
        const spawnErr = safeEmit(child, 'spawn');
        if (spawnErr) return;
        const waitP = kernelChild.wait();
        trackPromise(handles, waitP);
        waitP.then(
          (status) => {
            const { code, signal } = decodeWait(status);
            finish(child, code, signal);
          },
          (err) => {
            if (isExitError(err)) return;
            safeEmit(child, 'error', err);
            finish(child, 1, null);
          }
        );
      },
      (err) => {
        const code = err?.code === 'ENOENT' ? 'ENOENT' : err?.code ?? 'ERR_SPAWN_FAILED';
        const error =
          code === 'ENOENT'
            ? spawnError(file, args, 'ENOENT', `spawn ${file} ENOENT`)
            : spawnError(file, args, code, err?.message ?? String(err));
        // Soft-close deferred pipes (avoid stream 'error' races). Node: no
        // 'spawn' / 'exit' on ENOENT — 'error' then 'close' with -2.
        try {
          child.stdout?.push?.(null);
        } catch {
          /* ignore */
        }
        try {
          child.stderr?.push?.(null);
        } catch {
          /* ignore */
        }
        process.nextTick(() => {
          const emitErr = safeEmit(child, 'error', error);
          if (emitErr) {
            child._release();
            handles.notify?.();
            return;
          }
          if (code === 'ENOENT') {
            child.exitCode = -2;
            child._markClosing();
            // After error handlers (which may call execFile → async spawn) so
            // their 'error' logs before this 'close' (Node order on ENOENT).
            setTimeout(() => {
              safeEmit(child, 'close', -2, null);
              child._release();
              handles.notify?.();
            }, 20);
          } else {
            finish(child, 1, null);
          }
        });
      }
    );
  }

  function spawn(command, args, options) {
    let file = command;
    let argv = args;
    let opts = options;
    if (argv != null && !Array.isArray(argv) && typeof argv === 'object') {
      opts = argv;
      argv = [];
    }
    argv = Array.isArray(argv) ? argv.map(String) : [];
    opts = opts && typeof opts === 'object' ? opts : {};
    file = String(file);

    if (opts.shell) {
      const shell = typeof opts.shell === 'string' ? opts.shell : 'sh';
      const line = argv.length ? [file, ...argv].join(' ') : file;
      file = shell;
      argv = ['-c', line];
    }

    const stdio = normalizeStdio(opts.stdio);
    const child = new ChildProcess();

    // Node: missing cwd → async ENOENT on 'error'; file-as-cwd → throw ENOTDIR.
    if (opts.cwd != null) {
      const cwdAbs = resolveSpawnCwd(path, opts.cwd);
      const bad = checkSpawnCwd(ctx, cwdAbs);
      if (bad === 'ENOTDIR') throw enotdirSpawnError();
      if (bad === 'ENOENT') {
        try {
          prepareStdio(child, stdio);
        } catch {
          /* ignore pipe setup when we will fail spawn anyway */
        }
        child.spawnfile = file;
        child.spawnargs = [file, ...argv];
        failSpawnEnoent(child, process, handles, file, argv);
        return child;
      }
    }

    // prepareStdio may sync-load readable-stream; never let that throw out of
    // spawn() (seven: missing /node_modules/.../vendor → uncaught, no callback).
    try {
      prepareStdio(child, stdio);
    } catch (err) {
      const code = err?.code === 'ENOENT' || /\bENOENT\b/.test(err?.message ?? '') ? 'ENOENT' : err?.code ?? 'ERR_SPAWN_FAILED';
      const error =
        code === 'ENOENT'
          ? spawnError(file, argv, 'ENOENT', `spawn ${file} ENOENT`)
          : spawnError(file, argv, code, err?.message ?? String(err));
      process.nextTick(() => {
        safeEmit(child, 'error', error);
        if (code === 'ENOENT') {
          child.exitCode = -2;
          child._markClosing();
          safeEmit(child, 'close', -2, null);
        } else {
          finish(child, 1, null);
        }
      });
      return child;
    }
    process.nextTick(() => startSpawn(child, file, argv, opts, stdio));
    return child;
  }

  function execFile(file, args, options, callback) {
    const norm = normalizeArgs(file, args, options, callback);
    const opts = { ...norm.options };
    if (opts.stdio === undefined) opts.stdio = ['pipe', 'pipe', 'pipe'];
    const child = spawn(String(file), norm.args, opts);
    if (!norm.callback) return child;

    const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
    const encoding = opts.encoding;
    const killSignal = signalName(opts.killSignal) ?? 'SIGTERM';
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exited = false;
    let timedOut = false;
    let timer;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const done = (err) => {
      if (exited) return;
      exited = true;
      clearTimer();
      const out = decodeOutput(stdout, encoding);
      const errOut = decodeOutput(stderr, encoding);
      if (err) {
        err.stdout = out;
        err.stderr = errOut;
      }
      norm.callback(err, out, errOut);
    };

    if (opts.timeout != null && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill(killSignal);
      }, Number(opts.timeout));
      timer.unref?.();
    }

    const append = (kind, chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (kind === 'stdout') {
        stdout = Buffer.concat([stdout, buf]);
        if (stdout.length > maxBuffer) {
          // Node keeps exactly maxBuffer bytes in the callback argument.
          stdout = stdout.subarray(0, maxBuffer);
          child.kill();
          const err = new Error('stdout maxBuffer length exceeded');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          done(err);
          return false;
        }
      } else {
        stderr = Buffer.concat([stderr, buf]);
        if (stderr.length > maxBuffer) {
          stderr = stderr.subarray(0, maxBuffer);
          child.kill();
          const err = new Error('stderr maxBuffer length exceeded');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          done(err);
          return false;
        }
      }
      return true;
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        append('stdout', chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        append('stderr', chunk);
      });
    }

    child.on('error', (err) => done(err));
    child.on('close', (code, signal) => {
      if (exited) return;
      const cmd =
        opts._execCmd != null
          ? String(opts._execCmd)
          : `${file} ${norm.args.join(' ')}`.trim();
      if (timedOut) {
        const err = new Error(`Command failed: ${cmd}`);
        err.code = null;
        err.killed = true;
        err.signal = killSignal;
        err.cmd = cmd;
        done(err);
        return;
      }
      if (code === 0 && !signal) {
        done(null);
        return;
      }
      const err = new Error(`Command failed: ${cmd}`);
      err.code = code;
      err.killed = child.killed;
      err.signal = signal;
      err.cmd = cmd;
      done(err);
    });
    return child;
  }

  function exec(command, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof options === 'function') {
      cb = options;
      opts = {};
    }
    opts = opts && typeof opts === 'object' ? opts : {};
    const shell = typeof opts.shell === 'string' ? opts.shell : 'sh';
    const cmd = String(command);
    // Node's exec sets err.cmd to the original command, not `sh -c …`.
    return execFile(shell, ['-c', cmd], { ...opts, shell: false, _execCmd: cmd }, cb);
  }

  Object.defineProperty(exec, PROMISIFY_CUSTOM, {
    enumerable: false,
    value: customPromiseExecFunction(exec),
  });
  Object.defineProperty(execFile, PROMISIFY_CUSTOM, {
    enumerable: false,
    value: customPromiseExecFunction(execFile),
  });

  return {
    spawn,
    execFile,
    exec,
    spawnSync() {
      notSupported('spawnSync');
    },
    execSync() {
      notSupported('execSync');
    },
    execFileSync() {
      notSupported('execFileSync');
    },
    fork() {
      notSupported('fork');
    },
    ChildProcess,
    // Expose for tests / advanced callers
    _SIGNAL_NAMES: SIGNAL_NAMES,
    _SIGNAL_NUMBERS: SIGNAL_NUMBERS,
  };
}
