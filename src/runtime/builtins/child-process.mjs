/**
 * Minimal `child_process`: spawn / execFile / exec on top of ctx.spawn, and
 * spawnSync / execSync / execFileSync on ctx.sync.run (slicc-kernel 1.65.0+).
 * fork, and 'ipc' in spawn's stdio, need a kernel that makes socketpairs and
 * gives a child more descriptors than its stdio (ctx.socketpair, spawn's
 * `fds`, ai-ecoverse/slicc-kernel#1093): the channel is one end of a pair,
 * the child's NODE_CHANNEL_FD the other (./ipc-channel.mjs). On older
 * kernels fork stays ERR_NOT_SUPPORTED and 'ipc' does nothing, as before.
 */
import { kernelAtLeast, kernelVersion } from '../kernel-version.mjs';
import { trackPromise } from '../async-handles.mjs';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_OUT_OF_RANGE,
  nodeError,
  validateBoolean,
  validateArray,
  validateObject,
  validateOneOf,
  validateString,
} from '../node-errors.mjs';
import { createPath } from '../path.mjs';
import { SIGNALS } from '../process.mjs';
import { EventEmitter } from './events.mjs';
import { channelOn, setupChannel } from './ipc-channel.mjs';

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

/** The kernel that first has ctx.sync.run (slicc-kernel #401, #403). */
export const SYNC_RUN_KERNEL = '1.65.0';

function syncNotSupported(name) {
  const err = new Error(
    `slicc-jsh: child_process.${name} needs slicc-kernel ${SYNC_RUN_KERNEL} or later (ctx.sync.run); this kernel has none`
  );
  err.code = 'ERR_NOT_SUPPORTED';
  throw err;
}

// --- sync forms: Node 22's lib/child_process.js on ctx.sync.run -------------

const MAX_BUFFER = 1024 * 1024;

/** Linux errnos (process.platform is 'linux') for what ctx.sync.run reports. */
const ERRNO = {
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  E2BIG: -7,
  ENOEXEC: -8,
  EBADF: -9,
  EAGAIN: -11,
  ENOMEM: -12,
  EACCES: -13,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EMFILE: -24,
  ENOSYS: -38,
  ELOOP: -40,
  ENOBUFS: -105,
  ETIMEDOUT: -110,
};

/** Signal number → name, first name wins (SIGABRT over SIGIOT, as libuv). */
const SIGNAL_BY_NUMBER = {};
for (const [name, num] of Object.entries(SIGNALS)) SIGNAL_BY_NUMBER[num] ??= name;

const ERR_UNKNOWN_ENCODING = (enc) => nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${enc}`);

const ERR_UNKNOWN_SIGNAL = (signal) => nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${signal}`);

/** internal/util convertToValidSignal. */
function convertToValidSignal(signal) {
  if (typeof signal === 'number' && SIGNAL_BY_NUMBER[signal]) return signal;
  if (typeof signal === 'string') {
    const num = SIGNALS[signal.toUpperCase()];
    if (num) return num;
  }
  throw ERR_UNKNOWN_SIGNAL(signal);
}

function validateArgumentNullCheck(arg, propName) {
  if (typeof arg === 'string' && arg.includes('\u0000')) {
    throw ERR_INVALID_ARG_VALUE(propName, arg, 'must be a string without null bytes');
  }
}

function validateArgumentsNullCheck(args, propName) {
  for (let i = 0; i < args.length; ++i) validateArgumentNullCheck(args[i], `${propName}[${i}]`);
}

function validateTimeout(timeout) {
  if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
    throw ERR_OUT_OF_RANGE('timeout', 'an unsigned integer', timeout);
  }
}

function validateMaxBuffer(maxBuffer) {
  if (maxBuffer != null && !(typeof maxBuffer === 'number' && maxBuffer >= 0)) {
    throw ERR_OUT_OF_RANGE('options.maxBuffer', 'a positive number', maxBuffer);
  }
}

function sanitizeKillSignal(killSignal) {
  if (typeof killSignal === 'string' || typeof killSignal === 'number') {
    return convertToValidSignal(killSignal);
  } else if (killSignal != null) {
    throw ERR_INVALID_ARG_TYPE('options.killSignal', ['string', 'number'], killSignal);
  }
  return undefined;
}

function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

/** internal/fs/utils getValidatedPath for options.cwd (string, Buffer, URL). */
function validatedCwd(cwd) {
  let path = cwd;
  if (path != null && typeof path === 'object' && typeof path.href === 'string' && path.protocol !== undefined) {
    if (path.protocol !== 'file:') {
      throw nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
    }
    if (path.hostname !== '' && path.hostname !== 'localhost') {
      throw nodeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux');
    }
    path = decodeURIComponent(path.pathname);
  } else if (isArrayBufferView(path)) {
    path = new TextDecoder().decode(path);
  } else if (typeof path !== 'string') {
    throw ERR_INVALID_ARG_TYPE('options.cwd', ['string', 'Buffer', 'URL'], cwd);
  }
  if (path.includes('\u0000')) {
    throw ERR_INVALID_ARG_VALUE('options.cwd', path, 'must be a string or Uint8Array without null bytes');
  }
  return path;
}

/** getValidatedPath(modulePath, 'modulePath'): a string, a Buffer or a file: URL. */
function validatedModulePath(value) {
  let path = value;
  if (path != null && typeof path === 'object' && typeof path.href === 'string' && path.protocol !== undefined) {
    if (path.protocol !== 'file:') throw nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
    if (path.hostname !== '' && path.hostname !== 'localhost') {
      throw nodeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux');
    }
    path = decodeURIComponent(path.pathname);
  } else if (isArrayBufferView(path)) {
    path = new TextDecoder().decode(path);
  } else if (typeof path !== 'string') {
    throw ERR_INVALID_ARG_TYPE('modulePath', ['string', 'Buffer', 'URL'], value);
  }
  if (path.includes('\u0000')) {
    throw ERR_INVALID_ARG_VALUE('modulePath', path, 'must be a string or Uint8Array without null bytes');
  }
  return path;
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
    // A stream with a descriptor (process.stdout, an fs stream) is that fd.
    const fdOf = (s) => (s != null && typeof s === 'object' && typeof s.fd === 'number' ? s.fd : s);
    return [fdOf(stdio[0] ?? 'pipe'), fdOf(stdio[1] ?? 'pipe'), fdOf(stdio[2] ?? 'pipe')];
  }
  return ['pipe', 'pipe', 'pipe'];
}

const STDIO_NAMES = ['stdin', 'stdout', 'stderr'];
const kIpc = Symbol('ipc');

/** Where 'ipc' is in a stdio array (Node: one at most), or -1. */
function ipcIndexOf(stdio) {
  if (!Array.isArray(stdio)) return -1;
  let index = -1;
  stdio.forEach((s, i) => {
    if (s !== 'ipc') return;
    if (index !== -1) throw nodeError(Error, 'ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe');
    index = i;
  });
  return index;
}

/** lib/internal/child_process.js stdioStringToArray. */
function stdioStringToArray(stdio, channel) {
  const options = [];
  switch (stdio) {
    case 'ignore':
    case 'overlapped':
    case 'pipe':
      options.push(stdio, stdio, stdio);
      break;
    case 'inherit':
      options.push(0, 1, 2);
      break;
    default:
      throw ERR_INVALID_ARG_VALUE('stdio', stdio);
  }
  if (channel) options.push(channel);
  return options;
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

/**
 * The spawn failures Node reports as an 'error' event and a 'close' with
 * the negative errno (no 'exit'): libuv's run-time errors.
 */
const RUNTIME_SPAWN_ERRNO = { ENOENT: -2, EACCES: -13, EAGAIN: -11, EMFILE: -24, ENFILE: -23 };

function spawnError(command, args, code, message) {
  const err = new Error(message ?? `spawn ${command} ${code}`);
  err.code = code;
  err.errno = RUNTIME_SPAWN_ERRNO[code] ?? (code === 'ENOTDIR' ? -20 : undefined);
  err.syscall = `spawn ${command}`;
  err.path = command;
  err.spawnargs = args;
  return err;
}

/** Emit spawn ENOENT then close(-2), matching Node (missing command or cwd). */
function failSpawnEnoent(child, process, handles, file, argv, closeLater) {
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
    closeLater(() => {
      try {
        child.emit('close', -2, null);
      } catch {
        /* ignore */
      }
      child._release?.();
      handles.notify?.();
    });
  });
}

/**
 * @param {{ ctx: object, process: object, Buffer: object, handles: object, getStream: () => object }} deps
 */
export function createChildProcess({ ctx, process, Buffer, handles, getStream, getFs }) {
  const path = createPath(() => process.cwd());

  // Spawns on a kernel without ctx.sync.spawn (before 1.87.0), until they settle.
  const inflightSpawns = new Set();

  // An IPC channel: a socketpair, one end passed to the child at fd >= 3
  // (ai-ecoverse/slicc-kernel#1093). Without it, as before: no fork, and
  // 'ipc' in stdio is passed over.
  const ipcSupported =
    typeof ctx?.socketpair === 'function' && typeof ctx?.sync?.socketpair === 'function' && typeof ctx?.sync?.spawn === 'function';

  /** The parent's end of a channel: Node's setupChannel on the kernel fd. */
  function setupIpc(child, fd, serializationMode) {
    const serialization = process._nodeLib().childProcessSerialization;
    const channel = channelOn({ ctx, handles, serialization, fd });
    let closed;
    let ended = false;
    // The channel's end of file, or the parent's own close of it.
    let gone;
    const endOrGone = new Promise((resolve) => {
      gone = resolve;
    });
    const closeChannel = channel.close;
    channel.close = function close() {
      gone();
      return Reflect.apply(closeChannel, this, arguments);
    };
    // Node's 'close' also waits for the channel's end (its _closesNeeded):
    // never, when the parent disconnected first.
    child._ipcClosed = new Promise((resolve) => {
      closed = () => {
        ended = true;
        gone();
        resolve();
      };
    });
    // Linux closes an exiting child's descriptors before its parent can
    // reap it, so Node sees the channel's end ('disconnect') before 'exit'.
    // The child is gone, so its end of the channel closes: 'exit' waits for
    // that end of file (or for the parent's own close).
    child._ipcSettle = () => (ended || !child.channel ? null : endOrGone);
    const deprecate = process._builtin?.('util')?.deprecate ?? ((fn) => fn);
    setupChannel({ target: child, channel, serializationMode, serialization, process, deprecate, maybeClose: () => closed() });
  }
  /**
   * The 'close' of a spawn that failed at run time (ENOENT, EACCES, …).
   * Node's comes after its stdio pipes' EOF, on the next loop turn (after
   * that turn's immediates), and its spawn() is synchronous: a spawn the
   * 'error' handler starts (execFile of a missing command) has reported its
   * own error by then. Here a spawn settles later on a kernel without
   * ctx.sync.spawn, so the close also waits for the spawns in flight; it
   * waited a fixed 20 ms, which a loaded kernel's spawns outlast.
   */
  function closeLater(fn) {
    setImmediate(function later() {
      if (inflightSpawns.size === 0) return fn();
      Promise.allSettled([...inflightSpawns]).then(() => setImmediate(later));
    });
  }

  /**
   * The open file behind a descriptor jsh's fs opened itself (fs.openSync),
   * or null. Such an fd has no kernel fd behind it, so the kernel can't hand
   * it to a child: it is fed and drained here, through fs, which keeps the
   * fd's position as Node's shared file offset does. Taken when spawn() is
   * called, so closing the fd right after doesn't take it from the child.
   * A device (/dev/null, /dev/zero, …) has a kernel descriptor behind it,
   * `kernelFd`: the child gets that instead (spawn() holds it open until
   * the child has it, so a closeSync() right after doesn't close it).
   */
  function jshOpenFile(fd) {
    if (typeof fd !== 'number' || fd < 3 || !getFs) return null;
    return getFs()._sliccOpenFile?.(fd) ?? null;
  }


  /**
   * Node's spawn finds a bare name as execvp does: the first entry of the
   * child's PATH holding an executable regular
   * file, empty entries meaning the cwd. The kernel's commands are files in
   * /usr/bin and /bin, so PATH order decides a clash, as bash in the kernel
   * does. Returns the path to run, or the name when nothing on PATH is
   * executable: then a path on it that isn't there, so the spawn is ENOENT
   * as Node's (the kernel would find its own command by name, whatever
   * PATH says), or, when only directories or files without x were found,
   * the first of those, which the spawn reports as EACCES, as execvp does. A name with a '/' is
   * never searched.
   */
  /**
   * Linux's execve of a directory is EACCES; the kernel says ENOENT
   * (ai-ecoverse/slicc-kernel#626). `target` is the path that was run.
   */
  // From slicc-kernel 1.93.0 (#630) the kernel says EACCES itself.
  const kernelDirEacces = kernelAtLeast(ctx, '1.93.0');
  function spawnCode(code, target, cwd) {
    if (kernelDirEacces || code !== 'ENOENT' || typeof target !== 'string' || !target.includes('/')) return code;
    try {
      return ctx.sync?.fs?.stat?.(path.resolve(cwd, target))?.isDirectory ? 'EACCES' : code;
    } catch {
      return code;
    }
  }

  function resolveOnPath(file, env, cwd) {
    if (!file || file.includes('/')) return file;
    // libuv's: the child's environment's PATH, else _PATH_DEFPATH.
    const pathVar = env && typeof env.PATH === 'string' ? env.PATH : '/usr/bin:/bin';
    if (pathVar === '') return file;
    const fs = ctx.sync?.fs;
    if (!fs?.stat) return file;
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : 0;
    const gid = typeof process.getegid === 'function' ? process.getegid() : 0;
    const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
    const executable = (st) => {
      const mode = st.mode ?? 0;
      if (uid === 0) return (mode & 0o111) !== 0;
      if (st.uid === uid) return (mode & 0o100) !== 0;
      if (st.gid === gid || groups.includes(st.gid)) return (mode & 0o010) !== 0;
      return (mode & 0o001) !== 0;
    };
    let denied = null;
    for (const dir of pathVar.split(':')) {
      const full = path.resolve(cwd, dir === '' ? '.' : dir, file);
      let st;
      try {
        st = fs.stat(full);
      } catch {
        continue;
      }
      // execvp passes a directory over too, but remembers it as EACCES.
      if (st.isDirectory) {
        denied ??= full;
        continue;
      }
      if (typeof st.mode === 'number' && (st.mode & 0o170000) !== 0o100000 && (st.mode & 0o170000) !== 0) continue;
      if (executable(st)) return full;
      denied ??= full;
    }
    if (denied) return denied;
    // Nothing on the child's PATH: Node's ENOENT. The kernel would find its
    // command by name whatever PATH says, so run a path that isn't there.
    const first = pathVar.split(':')[0];
    return path.resolve(cwd, first === '' ? '.' : first, file);
  }

  /** Kernel stdio for a slot: a jsh fd becomes a pipe that jsh serves. */
  function kernelStdio(mode, file) {
    if (file) return 'pipe';
    return toKernelStdio(mode);
  }

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
    let reader = null;
    let gone = false;
    const r = new Readable({
      read() {},
      // Node: destroying child.stdout closes the parent's read end, so the
      // child's next write fails with EPIPE. Cancelling the kernel stream
      // closes our end of the pipe.
      destroy(err, cb) {
        gone = true;
        reader?.cancel().catch(() => {});
        cb(err);
      },
    });
    r._sliccPump = async (webStream) => {
      if (!webStream) {
        if (!gone) r.push(null);
        return;
      }
      if (gone) {
        webStream.cancel().catch(() => {});
        return;
      }
      try {
        reader = webStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || gone) break;
          const chunk =
            value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
          r.push(chunk);
        }
        if (!gone) r.push(null);
      } catch (err) {
        if (!gone) r.destroy(err);
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

  function connectStdio(child, kernelChild, files) {
    child.stdin?._sliccAttach?.(kernelChild.stdin);
    const pumps = [];
    if (child.stdout?._sliccPump) pumps.push(child.stdout._sliccPump(kernelChild.stdout));
    if (child.stderr?._sliccPump) pumps.push(child.stderr._sliccPump(kernelChild.stderr));
    // jsh fds (fs.openSync): stdin gets the file from the fd's position on,
    // and output goes through fs.writeSync as it arrives.
    if (files[0] && kernelChild.stdin) {
      const feed = (async () => {
        const writer = kernelChild.stdin.getWriter();
        try {
          let data;
          try {
            data = files[0].readRest();
          } finally {
            files[0].release?.();
          }
          if (data.length) await writer.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          await writer.close();
        } catch {
          writer.abort().catch(() => {});
        }
      })();
      trackPromise(handles, feed);
    } else {
      files[0]?.release?.();
    }
    for (const [i, web] of [
      [1, kernelChild.stdout],
      [2, kernelChild.stderr],
    ]) {
      const file = files[i];
      if (!file || !web) continue;
      pumps.push(
        (async () => {
          const reader = web.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            file.write(value);
          }
        })().catch(() => {})
      );
    }
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
      if (child._ipcClosed) {
        // The channel holds the program while it's open (it is ref'd).
        child._release();
        handles.notify?.();
        child._ipcClosed.then(() => safeEmit(child, 'close', code, signal));
        return;
      }
      const closeErr = safeEmit(child, 'close', code, signal);
      child._release();
      handles.notify?.();
      if (closeErr) return;
    });
  }

  function decodeWait(status) {
    const sigNum = status?.signal;
    if (sigNum != null && sigNum !== 0) {
      return { code: null, signal: SIGNAL_BY_NUMBER[sigNum] ?? String(sigNum) };
    }
    // A plain 128+n is an exit status (`exit 143`), not a signal: Node
    // reports it as the code. The kernel sets `signal` when one ended it.
    const code = typeof status?.status === 'number' ? status.status : 0;
    return { code, signal: null };
  }

  function startSpawn(child, file, args, options, stdio, files, sync = false) {
    // spawn / exec / execFile / (future sync) all go through here.
    const cwd = resolveSpawnCwd(path, options.cwd);
    const env = options.env ? { ...options.env } : { ...process.env };
    // The file is found on the child's PATH; errors and spawnfile keep the name.
    const argv = [resolveOnPath(file, env, cwd), ...args];
    // Node's argv0: what the child sees as argv[0] (the file by default).
    const argv0 = typeof options.argv0 === 'string' ? options.argv0 : file;
    child.spawnfile = file;
    child.spawnargs = [argv0, ...args];

    // Re-check in startSpawn so a cwd that vanishes between spawn() and the
    // tick still fails; ENOTDIR already threw from spawn() when applicable.
    const releaseAll = () => files.forEach((f) => f?.release?.());
    if (options.cwd != null) {
      const bad = checkSpawnCwd(ctx, cwd);
      if (bad) releaseAll();
      if (bad === 'ENOENT') {
        failSpawnEnoent(child, process, handles, file, args, closeLater);
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

    // A device goes to the child as its kernel descriptor (it streams, as in
    // Node); spawn() held it open, and it is let go once the child has it.
    const direct = files.map((f) => (f?.release && f.kernelFd != null ? f.kernelFd : null));
    const served = files.map((f, i) => (direct[i] != null ? null : f));
    // A file served here (stdin fed from its kernel descriptor) is let go
    // once it has been read, in connectStdio; a device once the child has it.
    const releaseDirect = () => files.forEach((f, i) => direct[i] != null && f?.release?.());
    const releaseServedOutput = () => served.forEach((f, i) => i > 0 && f?.release?.());
    const request = {
      argv,
      cwd,
      env,
      stdin: direct[0] ?? kernelStdio(stdio[0], served[0]),
      stdout: direct[1] ?? kernelStdio(stdio[1], served[1]),
      stderr: direct[2] ?? kernelStdio(stdio[2], served[2]),
      // Node's detached on POSIX is setsid(): a new session and group, no
      // controlling terminal (slicc-kernel 1.74.0+; older kernels ignore it,
      // and the child stays in the program's group, as before).
      ...(options.detached ? { session: true } : {}),
      // slicc-kernel 1.76.0+ (ai-ecoverse/slicc-kernel#470); older kernels
      // ignore it and the child sees what the kernel resolved.
      argv0,
    };
    // The child's end of the IPC channel, at the 'ipc' index.
    const ipc = options[kIpc];
    let pair = null;
    if (ipc && sync) {
      try {
        pair = ctx.sync.socketpair();
      } catch (err) {
        releaseAll();
        process.nextTick(() => {
          safeEmit(child, 'error', err);
          finish(child, 1, null);
        });
        return;
      }
      if (ipc.index < 3) request[STDIO_NAMES[ipc.index]] = pair[1];
      else request.fds = { [ipc.index]: pair[1] };
    }
    const closePair = (both) => {
      if (!pair) return;
      for (const fd of both ? pair : [pair[1]]) {
        try {
          ctx.sync.close(fd);
        } catch {
          /* already closed */
        }
      }
    };

    const run = (kernelChild) => {
      connectStdio(child, kernelChild, served);
      const spawnErr = safeEmit(child, 'spawn');
      if (spawnErr) return;
      const waitP = kernelChild.wait();
      trackPromise(handles, waitP);
      waitP.then(
        (status) => {
          const { code, signal } = decodeWait(status);
          const settling = child._ipcSettle?.();
          if (!settling) return finish(child, code, signal);
          // After the channel's end of file and its 'disconnect' tick.
          trackPromise(handles, settling).then(() => setImmediate(() => finish(child, code, signal)));
        },
        (err) => {
          if (isExitError(err)) return;
          safeEmit(child, 'error', err);
          finish(child, 1, null);
        }
      );
    };

    const failed = (err) => {
      const code = spawnCode(err?.code ?? 'ERR_SPAWN_FAILED', argv[0], cwd);
      const errno = RUNTIME_SPAWN_ERRNO[code];
      const error =
        errno !== undefined
          ? spawnError(file, args, code, `spawn ${file} ${code}`)
          : spawnError(file, args, code, err?.message ?? String(err));
      // Soft-close deferred pipes (avoid stream 'error' races). Node: no
      // 'spawn' / 'exit' on ENOENT or EACCES — 'error' then 'close' with -errno.
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
        if (errno !== undefined) {
          child.exitCode = errno;
          child._markClosing();
          // After error handlers (which may call execFile → async spawn) so
          // their 'error' logs before this 'close' (Node order on ENOENT).
          closeLater(() => {
            safeEmit(child, 'close', errno, null);
            child._release();
            handles.notify?.();
          });
        } else {
          finish(child, 1, null);
        }
      });
    };

    // slicc-kernel 1.87.0 (ai-ecoverse/slicc-kernel#492): ctx.sync.spawn
    // starts the child now, so child.pid is set when spawn() returns and a
    // kill() right after reaches it, as in Node. 'spawn' and 'error' still
    // come on a later tick: a spawn error throws here, and Node reports it
    // as an event, never from spawn().
    if (sync) {
      let kernelChild;
      try {
        kernelChild = ctx.sync.spawn(request);
      } catch (err) {
        closePair(true);
        releaseAll();
        failed(err);
        return;
      }
      closePair(false);
      releaseDirect();
      releaseServedOutput();
      child._bindKernel(kernelChild);
      if (pair) setupIpc(child, pair[0], ipc.serialization);
      process.nextTick(() => run(kernelChild));
      return;
    }

    const spawnPromise = ctx.spawn(request);
    trackPromise(handles, spawnPromise);
    inflightSpawns.add(spawnPromise);
    const settled = () => inflightSpawns.delete(spawnPromise);
    spawnPromise.then(settled, settled);
    spawnPromise.then(() => {
      releaseDirect();
      releaseServedOutput();
    }, releaseAll);
    spawnPromise.then((kernelChild) => {
      child._bindKernel(kernelChild);
      run(kernelChild);
    }, failed);
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
    if (opts.detached != null) validateBoolean(opts.detached, 'options.detached');
    if (opts.argv0 != null) {
      validateString(opts.argv0, 'options.argv0');
      validateArgumentNullCheck(opts.argv0, 'options.argv0');
    }
    // Node takes the options (and the environment) in spawn() itself: a
    // change to them after it returns doesn't reach the child, which starts
    // a tick later here.
    opts = { ...opts, env: { ...(opts.env || process.env) } };

    // 'ipc' in stdio: the channel, and the child told where it is (Node's
    // envPairs come after the environment's).
    if (ipcSupported) {
      const index = ipcIndexOf(opts.stdio);
      validateOneOf(opts.serialization, 'options.serialization', [undefined, 'json', 'advanced']);
      if (index !== -1) {
        const serialization = opts.serialization || 'json';
        opts.env.NODE_CHANNEL_FD = String(index);
        opts.env.NODE_CHANNEL_SERIALIZATION_MODE = serialization;
        opts.stdio = opts.stdio.map((s) => (s === 'ipc' ? 'ignore' : s));
        opts[kIpc] = { index, serialization };
      }
    }

    if (opts.shell) {
      // Node on Unix defaults shell:true to /bin/sh (errors say `spawn /bin/sh`).
      const shell = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
      const line = argv.length ? [file, ...argv].join(' ') : file;
      file = shell;
      argv = ['-c', line];
    }

    const stdio = normalizeStdio(opts.stdio);
    const child = new ChildProcess();
    // Node's child.stdio: one entry per stdio slot (at least three), null
    // for those without a stream.
    const slots = Array.isArray(opts.stdio) ? Math.max(3, opts.stdio.length) : 3;
    const setStdio = () => {
      child.stdio = [child.stdin, child.stdout, child.stderr, ...new Array(slots - 3).fill(null)];
    };
    // Node sets these in spawn() itself, before the process starts.
    child.spawnfile = file;
    child.spawnargs = [typeof opts.argv0 === 'string' ? opts.argv0 : file, ...argv];

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
        setStdio();
        child.spawnfile = file;
        child.spawnargs = [typeof opts.argv0 === 'string' ? opts.argv0 : file, ...argv];
        failSpawnEnoent(child, process, handles, file, argv, closeLater);
        return child;
      }
    }

    // prepareStdio may sync-load readable-stream; never let that throw out of
    // spawn() (seven: missing /node_modules/.../vendor → uncaught, no callback).
    try {
      prepareStdio(child, stdio);
      setStdio();
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
    // jsh fds are taken now: a closeSync() right after spawn() must not
    // take them from the child (Node's child has them already).
    const files = stdio.map((mode) => {
      const file = jshOpenFile(mode);
      // Hold a device's kernel descriptor until the child has it.
      if (file?.hold) file.release = file.hold();
      return file;
    });
    // Older kernels: the child starts a tick later, and child.pid with it.
    if (typeof ctx.sync?.spawn === 'function') startSpawn(child, file, argv, opts, stdio, files, true);
    else process.nextTick(() => startSpawn(child, file, argv, opts, stdio, files));
    return child;
  }

  function execFile(file, args, options, callback) {
    const norm = normalizeArgs(file, args, options, callback);
    const opts = { ...norm.options };
    if (opts.stdio === undefined) opts.stdio = ['pipe', 'pipe', 'pipe'];
    // Node's execFile (and exec through it) validates argv0 but doesn't pass
    // it, or detached, on to spawn(): the child sees the file as argv[0].
    if (opts.argv0 != null) {
      validateString(opts.argv0, 'options.argv0');
      validateArgumentNullCheck(opts.argv0, 'options.argv0');
    }
    delete opts.argv0;
    delete opts.detached;
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

    const cmd =
      opts._execCmd != null
        ? String(opts._execCmd)
        : `${file} ${norm.args.join(' ')}`.trim();
    child.on('error', (err) => {
      // Node's errorhandler: the error gets the command line too.
      if (err && typeof err === 'object' && !('cmd' in err)) err.cmd = cmd;
      done(err);
    });
    child.on('close', (code, signal) => {
      if (exited) return;
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
    // Node's exec uses /bin/sh on Unix; ENOENT message/path/spawnargs carry that path.
    const shell = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
    const cmd = String(command);
    // Node's exec sets err.cmd to the original command, not `sh -c …`.
    return execFile(shell, ['-c', cmd], { ...opts, shell: false, _execCmd: cmd }, cb);
  }

  // --- sync forms -----------------------------------------------------------

  /** lib/child_process.js normalizeSpawnArguments (the Unix half). */
  function normalizeSpawnArguments(file, args, options) {
    validateString(file, 'file');
    validateArgumentNullCheck(file, 'file');
    if (file.length === 0) throw ERR_INVALID_ARG_VALUE('file', file, 'cannot be empty');

    if (Array.isArray(args)) {
      args = args.slice();
    } else if (args == null) {
      args = [];
    } else if (typeof args !== 'object') {
      throw ERR_INVALID_ARG_TYPE('args', 'object', args);
    } else {
      options = args;
      args = [];
    }
    validateArgumentsNullCheck(args, 'args');

    if (options === undefined) options = {};
    else validateObject(options, 'options');
    options = { __proto__: null, ...options };

    let cwd = options.cwd;
    if (cwd != null) cwd = validatedCwd(cwd);
    if (options.detached != null) validateBoolean(options.detached, 'options.detached');
    for (const id of ['uid', 'gid']) {
      const v = options[id];
      if (v != null && !(Number.isInteger(v) && v >= -2147483648 && v <= 2147483647)) {
        throw ERR_INVALID_ARG_TYPE(`options.${id}`, 'int32', v);
      }
    }
    if (options.shell != null && typeof options.shell !== 'boolean' && typeof options.shell !== 'string') {
      throw ERR_INVALID_ARG_TYPE('options.shell', ['boolean', 'string'], options.shell);
    }
    if (options.argv0 != null) {
      validateString(options.argv0, 'options.argv0');
      validateArgumentNullCheck(options.argv0, 'options.argv0');
    }
    if (options.windowsHide != null) validateBoolean(options.windowsHide, 'options.windowsHide');
    if (options.windowsVerbatimArguments != null) {
      validateBoolean(options.windowsVerbatimArguments, 'options.windowsVerbatimArguments');
    }

    if (options.shell) {
      validateArgumentNullCheck(options.shell, 'options.shell');
      const command = args.length > 0 ? `${file} ${args.join(' ')}` : file;
      file = typeof options.shell === 'string' ? options.shell : '/bin/sh';
      args = ['-c', command];
    }
    args.unshift(typeof options.argv0 === 'string' ? options.argv0 : file);

    // Node passes every key `for…in` sees (prototype included), skips
    // undefined values and stringifies the rest.
    const envSource = options.env || { ...process.env };
    const env = {};
    for (const key in envSource) {
      const value = envSource[key];
      if (value === undefined) continue;
      validateArgumentNullCheck(key, `options.env['${key}']`);
      validateArgumentNullCheck(value, `options.env['${key}']`);
      env[key] = `${value}`;
    }

    return { ...options, args, cwd, env, file };
  }

  /**
   * internal/child_process getValidStdio(stdio, sync=true), then mapped onto
   * ctx.sync.run's 'pipe' | 'ignore' | 'inherit'. An fd other than the slot's
   * own is emulated: output is captured and written to it after the run, and
   * an input fd is read to its end first.
   */
  function syncStdio(stdio) {
    if (typeof stdio === 'string') {
      if (stdio === 'ignore' || stdio === 'pipe' || stdio === 'inherit' || stdio === 'overlapped') {
        stdio = [stdio, stdio, stdio];
      } else {
        throw ERR_INVALID_ARG_VALUE('stdio', stdio);
      }
    } else if (!Array.isArray(stdio)) {
      throw ERR_INVALID_ARG_VALUE('stdio', stdio);
    } else {
      stdio = stdio.slice();
    }
    while (stdio.length < 3) stdio.push(undefined);

    const out = [];
    stdio.forEach((s, i) => {
      s ??= i < 3 ? 'pipe' : 'ignore';
      if (s === 'ignore') out.push({ type: 'ignore' });
      else if (s === 'pipe' || s === 'overlapped' || (typeof s === 'number' && s < 0)) out.push({ type: 'pipe' });
      else if (s === 'ipc') {
        throw nodeError(Error, 'ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks');
      } else if (s === 'inherit') out.push({ type: 'inherit', fd: i });
      else if (typeof s === 'number' || typeof s?.fd === 'number') {
        out.push({ type: 'fd', fd: typeof s === 'number' ? s : s.fd });
      } else if (isArrayBufferView(s) || typeof s === 'string') {
        // Node's sync path skips these without a slot.
      } else {
        throw ERR_INVALID_ARG_VALUE('stdio', s);
      }
    });
    return out;
  }

  /**
   * Whether ctx.sync.run takes program fd numbers and stderr: 'stdout'
   * (slicc-kernel 1.70.0+, ai-ecoverse/slicc-kernel#432). Unknown until the
   * first call that needs it: an older kernel refuses those with EINVAL
   * before it starts anything, and the call is then made the old way. A
   * kernel that says its version (1.88.0+, ctx.kernel) has them.
   */
  let syncRunTakesFds = kernelVersion(ctx) !== null ? true : undefined;

  /**
   * How each stdio slot goes to ctx.sync.run. `how` is the kernel's choice,
   * `capture[i]` an fd whose output (or input) jsh carries itself: a jsh fd
   * (fs.openSync) always, a kernel fd only where the kernel can't take its
   * number. With `merged`, stdout and stderr share one capture (in the
   * child's write order) that goes to slot 1's target.
   */
  function planSync(stdio, takesFds) {
    const how = [];
    const capture = [];
    for (const i of [0, 1, 2]) {
      const slot = stdio[i];
      if (!slot) how.push('ignore');
      else if (slot.type === 'pipe') how.push('pipe');
      else if (slot.type === 'ignore') how.push('ignore');
      else if (slot.fd === i) how.push('inherit');
      else {
        const file = jshOpenFile(slot.fd);
        if (!file && takesFds) {
          how.push(slot.fd);
        } else if (file?.kernelFd != null && takesFds) {
          // A device: its kernel descriptor, streamed as in Node.
          how.push(file.kernelFd);
        } else {
          how.push('pipe');
          capture[i] = { fd: slot.fd, file };
        }
      }
    }
    // stdout and stderr to one jsh fd: one capture keeps their order.
    let merged = false;
    if (takesFds && capture[1] && capture[2] && capture[1].fd === capture[2].fd) {
      how[2] = 'stdout';
      capture[2] = undefined;
      merged = true;
    }
    return { how, capture, merged };
  }

  /** Read a descriptor to its end (stdin redirected from another fd). */
  function readFdToEnd(fd) {
    const chunks = [];
    for (;;) {
      const c = ctx.sync.read(fd);
      if (!c || c.length === 0) break;
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }

  function syncErrno(code, file, args) {
    const err = new Error(`spawnSync ${file} ${code}`);
    err.errno = ERRNO[code];
    err.code = code;
    err.syscall = `spawnSync ${file}`;
    err.path = file;
    err.spawnargs = args.slice(1);
    return err;
  }

  /** internal/child_process spawnSync on ctx.sync.run. */
  function runSync(options) {
    const { file, args } = options;
    const stdio = options.stdio;

    let failed;
    let raw;
    let remapped = false;
    if (options.cwd === '') {
      // Node's sync path passes '' to uv_spawn, whose chdir('') is ENOENT.
      failed = 'ENOENT';
    } else if (options.cwd != null) {
      const bad = checkSpawnCwd(ctx, resolveSpawnCwd(path, options.cwd));
      if (bad) failed = bad;
    }
    let plan;
    if (!failed) {
      let fed;
      const request = (takesFds) => {
        plan = planSync(stdio, takesFds);
        const { how, capture } = plan;
        remapped = capture[1] !== undefined || capture[2] !== undefined;
        let input = stdio[0]?.input;
        if (capture[0]) {
          // Read once: a retry the old way must not read the fd again.
          fed ??= capture[0].file ? Buffer.from(capture[0].file.readRest()) : readFdToEnd(capture[0].fd);
          input = fed;
        }
        const req = {
          // Node's native layer stringifies each argument (null → 'null').
          argv: [resolveOnPath(file, options.env, resolveSpawnCwd(path, options.cwd)), ...args.slice(1).map((a) => `${a}`)],
          // What the child sees as argv[0]: options.argv0, else the file, as
          // Node (slicc-kernel 1.76.0+; ignored before).
          argv0: args[0],
          env: options.env,
          cwd: resolveSpawnCwd(path, options.cwd),
          stdin: how[0],
          stdout: how[1],
          stderr: how[2],
          // Output for another fd that jsh carries is written after the run;
          // Node writes it straight through with no maxBuffer, so lift the
          // kernel's limit (it keeps 64 MiB at most) and apply maxBuffer to
          // the real pipes below.
          maxBuffer: remapped ? Infinity : options.maxBuffer,
          killSignal: options.killSignal ?? SIGNALS.SIGTERM,
        };
        if (how[0] === 'pipe' && input != null) {
          req.input = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        }
        if (options.timeout > 0) req.timeout = options.timeout;
        // detached: setsid(), as in Node (slicc-kernel 1.74.0+; ignored before).
        if (options.detached) req.session = true;
        return req;
      };
      let req = request(syncRunTakesFds !== false);
      const usesFds = [req.stdin, req.stdout, req.stderr].some((h) => typeof h === 'number' || h === 'stdout');
      if (usesFds && syncRunTakesFds === undefined) {
        try {
          raw = ctx.sync.run(req);
          syncRunTakesFds = true;
        } catch (err) {
          if (err?.code !== 'EINVAL') throw err;
          syncRunTakesFds = false;
          req = request(false);
        }
      }
      raw ??= ctx.sync.run(req);
      if (raw.error && raw.pid === 0 && raw.status === null) failed = spawnCode(raw.error.code ?? 'ENOENT', req.argv[0], req.cwd);
    }

    if (failed && !raw?.pid) {
      return {
        error: syncErrno(failed, file, args),
        status: null,
        signal: null,
        output: null,
        pid: 0,
        stdout: undefined,
        stderr: undefined,
      };
    }

    const output = stdio.map(() => null);
    let overflow = false;
    for (const i of [1, 2]) {
      const slot = stdio[i];
      if (!slot) continue;
      let bytes = i === 1 ? raw.stdout : raw.stderr;
      const capture = plan.capture[i];
      if (capture) {
        // Carried by jsh: written now. Without the kernel's stderr: 'stdout'
        // (before 1.70.0), stdout and stderr for one fd come one after the
        // other rather than in the child's write order.
        if (bytes?.length) {
          if (capture.file) capture.file.write(bytes);
          else ctx.sync.write(capture.fd, bytes);
        }
      } else if (slot.type === 'pipe') {
        bytes ??= new Uint8Array(0);
        // With the kernel's limit lifted (remapped fds), keep maxBuffer here;
        // the child has run to its end, so this can only truncate.
        if (remapped && bytes.length > options.maxBuffer) {
          bytes = bytes.subarray(0, options.maxBuffer);
          overflow = true;
        }
        output[i] = Buffer.from(bytes);
      }
    }
    if (overflow && !raw.error) raw = { ...raw, error: { code: 'ENOBUFS' } };
    // Extra pipes (fd 3+) have no kernel counterpart: empty, as if unused.
    for (let i = 3; i < stdio.length; i++) if (stdio[i].type === 'pipe') output[i] = Buffer.alloc(0);

    if (options.encoding && options.encoding !== 'buffer') {
      for (let i = 0; i < output.length; i++) {
        if (!output[i]) continue;
        // Node's Buffer#toString: '' for no bytes, else an unknown encoding throws.
        if (output[i].length > 0 && !Buffer.isEncoding(options.encoding)) throw ERR_UNKNOWN_ENCODING(options.encoding);
        output[i] = output[i].toString(options.encoding);
      }
    }

    const signal = raw.signal != null ? (SIGNAL_BY_NUMBER[raw.signal] ?? String(raw.signal)) : null;
    const result = {};
    if (raw.error) result.error = syncErrno(raw.error.code, file, args);
    result.status = raw.status ?? null;
    result.signal = signal;
    result.output = output;
    result.pid = raw.pid;
    result.stdout = output[1];
    result.stderr = output[2];
    return result;
  }

  /** lib/child_process.js spawnSync. */
  function spawnSync(file, args, options) {
    if (typeof ctx.sync?.run !== 'function') syncNotSupported('spawnSync');
    return spawnSyncImpl(file, args, options);
  }

  function spawnSyncImpl(file, args, options) {
    options = {
      __proto__: null,
      maxBuffer: MAX_BUFFER,
      ...normalizeSpawnArguments(file, args, options),
    };
    validateTimeout(options.timeout);
    validateMaxBuffer(options.maxBuffer);
    options.killSignal = sanitizeKillSignal(options.killSignal);
    options.stdio = syncStdio(options.stdio || 'pipe');

    if (options.input) {
      const stdin = (options.stdio[0] = { ...options.stdio[0] });
      stdin.input = options.input;
    }
    for (let i = 0; i < options.stdio.length; i++) {
      const input = options.stdio[i]?.input;
      if (input != null) {
        const pipe = (options.stdio[i] = { ...options.stdio[i] });
        if (isArrayBufferView(input)) {
          pipe.input = input;
        } else if (typeof input === 'string') {
          const enc = options.encoding;
          if (typeof enc === 'string' && enc.length > 0 && !Buffer.isEncoding(enc)) throw ERR_UNKNOWN_ENCODING(enc);
          pipe.input = Buffer.from(input, enc);
        } else {
          throw ERR_INVALID_ARG_TYPE(`options.stdio[${i}]`, ['Buffer', 'TypedArray', 'DataView', 'string'], input);
        }
      }
    }
    return runSync(options);
  }

  function checkExecSyncError(ret, args, cmd) {
    let err;
    if (ret.error) {
      err = ret.error;
      Object.assign(err, ret);
    } else if (ret.status !== 0) {
      let msg = 'Command failed: ';
      msg += cmd || args.join(' ');
      if (ret.stderr && ret.stderr.length > 0) msg += `\n${ret.stderr.toString()}`;
      err = new Error(msg);
      Object.assign(err, ret);
    }
    return err;
  }

  /** lib/child_process.js normalizeExecFileArgs (no callback). */
  function normalizeExecFileArgs(file, args, options) {
    if (Array.isArray(args)) {
      args = args.slice();
    } else if (args != null && typeof args === 'object') {
      options = args;
      args = null;
    }
    args ??= [];
    if (options != null) validateObject(options, 'options');
    options ??= {};
    if (options.argv0 != null) {
      validateString(options.argv0, 'options.argv0');
      validateArgumentNullCheck(options.argv0, 'options.argv0');
    }
    return { file, args, options };
  }

  function execFileSync(file, args, options) {
    if (typeof ctx.sync?.run !== 'function') syncNotSupported('execFileSync');
    ({ file, args, options } = normalizeExecFileArgs(file, args, options));
    const inheritStderr = !options.stdio;
    const ret = spawnSyncImpl(file, args, options);
    if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);
    const errArgs = [options.argv0 || file, ...args];
    const err = checkExecSyncError(ret, errArgs);
    if (err) throw err;
    return ret.stdout;
  }

  function execSync(command, options) {
    if (typeof ctx.sync?.run !== 'function') syncNotSupported('execSync');
    validateString(command, 'command');
    validateArgumentNullCheck(command, 'command');
    const opts = { __proto__: null, ...options };
    opts.shell = typeof opts.shell === 'string' ? opts.shell : true;
    const inheritStderr = !opts.stdio;
    const ret = spawnSyncImpl(command, opts);
    if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);
    const err = checkExecSyncError(ret, undefined, command);
    if (err) throw err;
    return ret.stdout;
  }

  /** lib/child_process.js fork (Node 22.22.0): spawn of execPath with an IPC channel. */
  function fork(modulePath, args = [], options) {
    if (!ipcSupported) notSupported('fork');
    modulePath = validatedModulePath(modulePath);

    if (args == null) {
      args = [];
    } else if (typeof args === 'object' && !Array.isArray(args)) {
      options = args;
      args = [];
    } else {
      validateArray(args, 'args');
    }

    if (options != null) validateObject(options, 'options');
    options = { __proto__: null, ...options, shell: false };
    options.execPath ||= process.execPath;
    validateArgumentNullCheck(options.execPath, 'options.execPath');

    let execArgv = options.execArgv || process.execArgv;
    for (const [i, arg] of (execArgv ?? []).entries()) validateArgumentNullCheck(arg, `options.execArgv[${i}]`);
    const evalCode = process._evalCode ?? process._eval;
    if (execArgv === process.execArgv && evalCode != null) {
      const index = execArgv.lastIndexOf(evalCode);
      if (index > 0) {
        // Leave out -e and its code, or the child would fork itself again.
        execArgv = execArgv.slice();
        execArgv.splice(index - 1, 2);
      }
    }

    args = [...execArgv, modulePath, ...args];

    if (typeof options.stdio === 'string') {
      options.stdio = stdioStringToArray(options.stdio, 'ipc');
    } else if (!Array.isArray(options.stdio)) {
      // fd 3 is the channel; stdin, stdout and stderr are the parent's unless silent.
      options.stdio = stdioStringToArray(options.silent ? 'pipe' : 'inherit', 'ipc');
    } else if (!options.stdio.includes('ipc')) {
      throw nodeError(Error, 'ERR_CHILD_PROCESS_IPC_REQUIRED', "Forked processes must have an IPC channel, missing value 'ipc' in options.stdio");
    }

    return spawn(options.execPath, args, options);
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
    spawnSync,
    execSync,
    execFileSync,
    fork,
    ChildProcess,
    // Expose for tests / advanced callers
    _SIGNAL_NAMES: SIGNAL_NAMES,
    _SIGNAL_NUMBERS: SIGNAL_NUMBERS,
  };
}
