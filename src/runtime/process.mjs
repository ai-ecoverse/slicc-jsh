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
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  };
}

export function createProcess({ ctx, argv, nextTick, onExit }) {
  let cwd = ctx.cwd;
  let assignedExitCode;
  let forcedExitCode;
  let didExit = false;

  const writeStdout = (value) => ctx.sync.write(1, toBytes(value));
  const writeStderr = (value) => ctx.sync.write(2, toBytes(value));

  const recordExit = (code) => {
    didExit = true;
    forcedExitCode = code;
    assignedExitCode = code;
    onExit?.(code);
  };

  const hrtime = (prev) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Fake ns clock from ms: enough for shape/monotonic goldens, not absolute parity.
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

  const env = { ...ctx.env };

  const process = {
    argv: argv.slice(),
    argv0: argv[0] ?? 'node',
    env,
    versions: { node: NODE_SHIM_VERSION },
    version: `v${NODE_SHIM_VERSION}`,
    platform: 'linux',
    arch: 'x64',
    pid: ctx.pid,
    ppid: undefined,
    nextTick: nextTick.nextTick.bind(nextTick),
    hrtime,
    cwd: () => cwd,
    chdir: (path) => {
      if (typeof path !== 'string') {
        const err = new TypeError(
          `The "directory" argument must be of type string. Received type ${typeof path}`
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      cwd = ctx.resolve(path);
    },
    get exitCode() {
      return assignedExitCode;
    },
    set exitCode(value) {
      if (didExit && forcedExitCode !== undefined) return;
      assignedExitCode = assignProcessExitCode(value);
    },
    exit(...args) {
      if (args.length === 0) {
        const code = numericExitCode(assignedExitCode);
        recordExit(code);
        throw new NodeExitError(code);
      }
      assignedExitCode = assignProcessExitCode(args[0]);
      const code = numericExitCode(assignedExitCode);
      recordExit(code);
      throw new NodeExitError(code);
    },
    stdout: writableStream(1, writeStdout, false),
    stderr: writableStream(2, writeStderr, false),
    stdin: {
      fd: 0,
      isTTY: false,
      read: () => null,
      on() {
        return this;
      },
      resume() {
        return this;
      },
      pause() {
        return this;
      },
    },
  };

  return {
    process,
    writeStdout,
    writeStderr,
    getExitCode: () => numericExitCode(didExit ? forcedExitCode : assignedExitCode),
    getDidExit: () => didExit,
    recordExit,
  };
}
