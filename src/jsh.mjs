import { JSH_PARAMS, JSH_USAGE, JSH_VERSION, parseJshArgv, runJsh } from './jsh/run.mjs';
import { NodeExitError } from './runtime/exit.mjs';
import { runNode } from './runtime/run.mjs';

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

/**
 * `jsh` command entry for slicc-kernel (abi: "js"): `jsh <script.jsh> [args]`,
 * also what the `.jsh` binfmt rule and `#!/usr/bin/env jsh` run. The script
 * runs on the `node` runtime (process, timers, event loop, CJS and ESM) with
 * the shared `.jsh` layer.
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
  const nodeCtx = Object.create(ctx, {
    argv: { value: [argv0, filename, ...parsed.args], enumerable: true },
  });
  return runNode(nodeCtx, {
    main: async (rt) => {
      const { process, console } = rt;
      let stdoutIsTTY = false;
      try {
        stdoutIsTTY = !!(await ctx.isatty?.(1));
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
        spawn: kernelSpawn(ctx, process),
        shell: ['sh', '-c'],
        fetch: rt.fetch,
        isExit: (err) => err instanceof NodeExitError,
        exit: (code) => process.exit(code),
      };
      await runJsh({ filename, engine, process, console });
    },
  });
}
