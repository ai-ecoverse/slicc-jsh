import { JSH_USAGE, JSH_VERSION, parseJshArgv, runJsh } from './jsh/run.mjs';
import { NodeExitError } from './runtime/exit.mjs';
import { runNode } from './runtime/run.mjs';

const BOOT = Symbol.for('slicc-jsh.boot');
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/*
 * The kernel `jsh` rides on the `node` runtime's eval entry, so a `.jsh`
 * script gets exactly the shim `node` scripts get (process, timers and the
 * event loop, CJS require, builtins). The eval code hands those to `boot`,
 * which runs the shared `.jsh` layer.
 */
const BOOT_CODE = `globalThis[Symbol.for('slicc-jsh.boot')]({ process, console, Buffer, require, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate })`;

async function readAll(stream) {
  if (!stream) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    size += bytes.length;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function writeAll(stream, data) {
  const writer = stream.getWriter();
  try {
    await writer.write(typeof data === 'string' ? encoder.encode(data) : data);
    await writer.close();
  } catch {
    /* the child closed its stdin */
  }
}

function kernelSpawn(ctx, process) {
  return (argv, { stdin } = {}) => {
    let child = null;
    const done = (async () => {
      try {
        child = await ctx.spawn({
          argv,
          cwd: process.cwd(),
          env: { ...process.env },
          stdin: stdin === undefined ? 'null' : 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return { stdout: '', stderr: `${argv[0]}: command not found\n`, exitCode: 127 };
        }
        return { stdout: '', stderr: `${argv[0]}: ${err?.message ?? err}\n`, exitCode: 126 };
      }
      const [out, err, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.wait(),
        stdin === undefined ? undefined : writeAll(child.stdin, stdin),
      ]);
      return { stdout: decoder.decode(out), stderr: decoder.decode(err), exitCode: status.status };
    })();
    return {
      kill: async (sig = 'SIGTERM') => (child ? child.kill(sig) : false),
      done,
    };
  };
}

/** Make the runtime's bindings globals for the script's lifetime, as Node's are. */
function installGlobals(g) {
  for (const name of [
    'process',
    'Buffer',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        value: g[name],
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      /* a frozen name keeps the worker's own */
    }
  }
  try {
    globalThis.global ??= globalThis;
  } catch {
    /* ignore */
  }
}

async function boot(ctx, g, filename) {
  // Taken before the first await: the eval entry returns as soon as this
  // yields, and the runtime ends the program once no handle is left. The
  // body may also await kernel calls the runtime does not count as handles
  // yet, so this stays until the body settles.
  const keepAlive = g.setInterval(() => {}, 1 << 30);
  try {
    await bootRun(ctx, g, filename);
  } finally {
    g.clearInterval(keepAlive);
  }
}

async function bootRun(ctx, g, filename) {
  const { process, console, require } = g;
  installGlobals(g);
  const fetch = typeof ctx.fetch === 'function' ? (input, init) => ctx.fetch(input, init) : undefined;
  if (fetch) {
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: fetch,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      /* ignore */
    }
  }
  let stdoutIsTTY = false;
  try {
    stdoutIsTTY = !!(await ctx.isatty?.(1));
  } catch {
    stdoutIsTTY = false;
  }
  const { createRequire } = require('module');
  const engine = {
    readSource: (path) => decoder.decode(ctx.sync.fs.readFile(path)),
    // Indirect eval: the code runs in the worker's global scope, sloppy.
    compile: (code, path) => (0, eval)(`${code}\n//# sourceURL=${path}`),
    createRequire: (path) => createRequire(path),
    selfRequire: createRequire('/node_modules/@ai-ecoverse/slicc-jsh/package.json'),
    writeStdout: (s) => process.stdout.write(String(s)),
    writeStderr: (s) => process.stderr.write(String(s)),
    stdoutIsTTY,
    spawn: kernelSpawn(ctx, process),
    shell: ['sh', '-c'],
    fetch,
    isExit: (err) => err instanceof NodeExitError,
    exit: (code) => ctx.exit(code),
  };
  await runJsh({ filename, engine, process, console });
}

/**
 * `jsh` command entry for slicc-kernel (abi: "js"): `jsh <script.jsh> [args]`,
 * also what the `.jsh` binfmt rule and `#!/usr/bin/env jsh` run.
 * @param {object} ctx JsProgramContext from slicc-kernel
 */
export default async function main(ctx) {
  const parsed = parseJshArgv([...ctx.argv].slice(1));
  if (parsed.action === 'version') {
    await ctx.write(1, `${JSH_VERSION}\n`);
    return 0;
  }
  if (parsed.action === 'help') {
    await ctx.write(1, JSH_USAGE);
    return 0;
  }
  if (parsed.action === 'usage') {
    await ctx.write(2, JSH_USAGE);
    return 2;
  }
  if (parsed.action === 'error') {
    await ctx.write(2, `${parsed.message}\n${JSH_USAGE}`);
    return parsed.status;
  }
  const filename = ctx.resolve(parsed.script);
  const argv0 = ctx.argv[0] ?? 'jsh';
  globalThis[BOOT] = (g) => {
    delete globalThis[BOOT];
    boot(ctx, g, filename).catch(async (err) => {
      // ctx.exit() unwinds with the kernel's JsExit; the exit already happened.
      if (err?.name === 'JsExit' || err?.constructor?.name === 'JsExit') return;
      await ctx.write(2, `${err?.stack ?? err}\n`);
      ctx.exit(1);
    });
  };
  const nodeCtx = Object.create(ctx, {
    argv: { value: [argv0, '-e', BOOT_CODE, filename, ...parsed.args], enumerable: true },
  });
  return runNode(nodeCtx);
}
