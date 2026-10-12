/**
 * The kernel side of `jsh`: the `.jsh` layer's engine over slicc-kernel's
 * `ctx` and the `node` runtime (`rt`, what `runNode` hands to `main`).
 *
 * Used by the `jsh` command (src/jsh.mjs) and by the handoff the `node`
 * runtime advertises to the host CLI (dist/host/jsh.mjs), so `jsh` run
 * through pnpm's global bin inside the kernel is still the kernel jsh.
 */
import { realMainPath } from '../runtime/realpath.mjs';
import { JSH_PARAMS, JSH_USAGE, JSH_VERSION, parseJshArgv, runJsh } from './run.mjs';

/** The global the `node` runtime sets for the host CLI to hand off to. */
export const JSH_HANDOFF = Symbol.for('slicc-jsh.kernel');

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

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

function kernelSpawn(ctx, process, track) {
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
    // A command in flight keeps the program alive, as a child process does.
    return {
      kill: async (sig = 'SIGTERM') => (child ? child.kill(sig) : false),
      done: track(done),
    };
  };
}

/**
 * Compile a `.jsh` body as an async function. `new AsyncFunction` adds two
 * header lines, which the runtime's stack formatting already takes off for
 * sourceURL frames. `import()` goes to the runtime's ESM loader, relative to
 * the script.
 */
function compiler(rt) {
  return (body, filename) => {
    const head = '(async function () {';
    const { code, changed, binding = '__import' } = rt.rewriteDynamicImports(
      `${head}${body}\n})`
    );
    const text = changed ? code.slice(head.length, -3) : body;
    const params = changed ? [...JSH_PARAMS, binding] : [...JSH_PARAMS];
    const fn = new AsyncFunction(...params, `${text}\n//# sourceURL=${filename}`);
    if (!changed) return fn;
    const importFrom = (specifier) => rt.importModule(specifier, filename);
    return (...args) => fn(...args.slice(0, JSH_PARAMS.length), importFrom);
  };
}

/** Run one `.jsh` file on the kernel engine. */
export async function runKernelJsh(ctx, rt, givenFilename) {
  const { process, console } = rt;
  // As Node runs a main module: __filename is the real path (links resolved),
  // process.argv[1] the path as given.
  const filename = realMainPath(ctx, givenFilename);
  let stdoutIsTTY = false;
  try {
    stdoutIsTTY = !!(await rt.track(Promise.resolve(ctx.isatty?.(1))));
  } catch {
    stdoutIsTTY = false;
  }
  const engine = {
    readSource: (path) => decoder.decode(ctx.sync.fs.readFile(path)),
    compile: compiler(rt),
    createRequire: (path) => rt.createRequire(path),
    selfRequire: rt.createRequire('/node_modules/@ai-ecoverse/slicc-jsh/package.json'),
    writeStdout: (s) => process.stdout.write(String(s)),
    writeStderr: (s) => process.stderr.write(String(s)),
    stdoutIsTTY,
    spawn: kernelSpawn(ctx, process, rt.track),
    shell: ['sh', '-c'],
    fetch: rt.fetch,
    exit: (code) => process.exit(code),
    started: (body) => rt.setEntry(body, 'jsh'),
  };
  await runJsh({ filename, engine, process, console });
}

/**
 * Advertise the kernel jsh to the host CLI. When pnpm (or npm) installs the
 * package globally inside the kernel, its `bin` (the host CLI) shadows the
 * kernel's `jsh` command on PATH; the host CLI then runs under this `node`
 * runtime, finds this global and hands its arguments here. Only this runtime
 * sets it, so the check cannot misfire on a real host. Returns a remover.
 */
export function installJshHandoff(ctx, rt) {
  const handoff = Object.freeze({
    version: JSH_VERSION,
    async runJsh(args) {
      const { process } = rt;
      const parsed = parseJshArgv([...args]);
      if (parsed.action === 'version') return void process.stdout.write(`${JSH_VERSION}\n`);
      if (parsed.action === 'help') return void process.stdout.write(JSH_USAGE);
      if (parsed.action === 'usage') {
        process.stderr.write(JSH_USAGE);
        return process.exit(2);
      }
      if (parsed.action === 'error') {
        process.stderr.write(`${parsed.message}\n${JSH_USAGE}`);
        return process.exit(parsed.status);
      }
      const filename = ctx.resolve(parsed.script);
      process.argv = ['jsh', filename, ...parsed.args];
      return runKernelJsh(ctx, rt, filename);
    },
  });
  try {
    Object.defineProperty(globalThis, JSH_HANDOFF, {
      value: handoff,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      delete globalThis[JSH_HANDOFF];
    } catch {
      /* ignore */
    }
  };
}
