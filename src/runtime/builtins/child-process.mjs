/**
 * Minimal `child_process`: spawn / execFile / exec on top of ctx.spawn.
 * Sync forms and fork stay ERR_NOT_SUPPORTED.
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';

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

function spawnError(command, args, code, message) {
  const err = new Error(message ?? `spawn ${command} ${code}`);
  err.code = code;
  err.errno = code === 'ENOENT' ? -2 : undefined;
  err.syscall = 'spawn';
  err.path = command;
  err.spawnargs = args;
  return err;
}

/**
 * @param {{ ctx: object, process: object, Buffer: object, handles: object, getStream: () => object }} deps
 */
export function createChildProcess({ ctx, process, Buffer, handles, getStream }) {
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
    }

    #kernel;
    #handle;
    #closing;

    kill(signal = 'SIGTERM') {
      const name = signalName(signal) ?? 'SIGTERM';
      this.killed = true;
      if (!this.#kernel) return false;
      try {
        const ret = this.#kernel.kill(name);
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

  function finish(child, code, signal) {
    if (child._closing) return;
    child._markClosing();
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    const after = child._stdioPumps ?? Promise.resolve();
    trackPromise(handles, after);
    after.finally(() => {
      child.emit('close', code, signal);
      child._release();
      handles.notify?.();
    });
  }

  function startSpawn(child, file, args, options, stdio) {
    const cwd = options.cwd != null ? String(options.cwd) : process.cwd();
    const env = options.env ? { ...options.env } : { ...process.env };
    const argv = [file, ...args];
    child.spawnfile = file;
    child.spawnargs = argv;

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
        child.emit('spawn');
        const waitP = kernelChild.wait();
        trackPromise(handles, waitP);
        waitP.then(
          (status) => {
            const sigNum = status?.signal;
            if (sigNum != null && sigNum !== 0) {
              const name = SIGNAL_NAMES[sigNum] ?? String(sigNum);
              finish(child, null, name);
            } else {
              const code = typeof status?.status === 'number' ? status.status : 0;
              finish(child, code, null);
            }
          },
          (err) => {
            child.emit('error', err);
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
          child.emit('error', error);
          if (code === 'ENOENT') {
            child.exitCode = -2;
            child.emit('close', -2, null);
          } else {
            finish(child, 1, null);
          }
          child._release();
          handles.notify?.();
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
    prepareStdio(child, stdio);
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
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exited = false;

    const done = (err) => {
      if (exited) return;
      exited = true;
      const enc = opts.encoding;
      const out = enc ? stdout.toString(enc) : stdout;
      const errOut = enc ? stderr.toString(enc) : stderr;
      norm.callback(err, out, errOut);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (stdout.length > maxBuffer) {
          child.kill();
          const err = new Error('stdout maxBuffer exceeded');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          done(err);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = Buffer.concat([stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (stderr.length > maxBuffer) {
          child.kill();
          const err = new Error('stderr maxBuffer exceeded');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          done(err);
        }
      });
    }

    child.on('error', (err) => done(err));
    child.on('close', (code, signal) => {
      if (exited) return;
      if (code === 0 && !signal) {
        done(null);
        return;
      }
      const err = new Error(`Command failed: ${file} ${norm.args.join(' ')}`);
      err.code = code;
      err.killed = child.killed;
      err.signal = signal;
      err.cmd = `${file} ${norm.args.join(' ')}`.trim();
      err.stdout = opts.encoding ? stdout.toString(opts.encoding) : stdout;
      err.stderr = opts.encoding ? stderr.toString(opts.encoding) : stderr;
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
    return execFile(shell, ['-c', String(command)], { ...opts, shell: false }, cb);
  }

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
