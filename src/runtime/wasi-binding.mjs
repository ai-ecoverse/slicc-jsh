/**
 * internalBinding('wasi') for Node 22.22.0's own lib/wasi.js (src/node-lib),
 * on the kernel's WASI host: ctx.sync.wasi.create (slicc-kernel 1.133.0,
 * ai-ecoverse/slicc-kernel#1111), an in-process preview1 instance with its
 * own guest fd table, as Node's is uvwasi's in its process.
 *
 * lib/wasi.js asks of it what it asks of src/node_wasi.cc: `new WASI(args,
 * env, preopens, stdio)` with `args` strings, `env` "KEY=value" strings,
 * `preopens` [guest, host, guest, host, …] and `stdio` [in, out, err]; an
 * object whose own properties are the preview1 functions (lib/wasi.js binds
 * each, and replaces proc_exit when returnOnExit is on), and `_setMemory`.
 *
 * The stdio fds are the program's kernel fds, as Node's are its OS fds: 0 to
 * 2, and a device jsh's fs opened (its kernelFd). A file jsh's fs opened has
 * no kernel fd (fs reads and writes it by its path), so it can't be one.
 */
import { nodeError } from './node-errors.mjs';

export function wasiSupported(ctx) {
  return typeof ctx?.sync?.wasi?.create === 'function';
}

const STDIO = ['stdin', 'stdout', 'stderr'];

export function createWasiBinding({ ctx, process }) {
  function kernelFd(fd, i) {
    const open = fd > 2 ? process._builtin('fs')._sliccOpenFile?.(fd) : null;
    if (!open) return fd;
    if (open.kernelFd !== undefined) return open.kernelFd;
    throw nodeError(
      Error,
      'ERR_NOT_SUPPORTED',
      `slicc-jsh: options.${STDIO[i]} can't be fd ${fd}, a file fs opened (it has no kernel fd); use 0, 1, 2 or a device`
    );
  }

  function WASI(args, env, preopens, stdio) {
    // Null prototypes: a variable or a preopen may be named __proto__.
    const environment = { __proto__: null };
    for (const pair of env) {
      const eq = pair.indexOf('=');
      environment[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const dirs = { __proto__: null };
    for (let i = 0; i < preopens.length; i += 2) dirs[preopens[i]] = preopens[i + 1];
    // returnOnExit: lib/wasi.js does it (its own proc_exit); without it,
    // Node's proc_exit ends the process at once, with no 'exit' event.
    const fds = stdio.map(kernelFd);
    const host = ctx.sync.wasi.create({ args, env: environment, preopens: dirs, stdio: fds, returnOnExit: true });
    for (const [name, fn] of Object.entries(host.imports.wasi_snapshot_preview1)) this[name] = fn;
    this.proc_exit = (code) => process._reallyExit(code);
    this._setMemory = (memory) => {
      if (!(memory instanceof WebAssembly.Memory)) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', '"instance.exports.memory" property must be a WebAssembly.Memory object');
      }
      host.bind(memory);
    };
  }
  return { WASI };
}
