/**
 * Host `jsh`: runs a `.jsh` file on the host's own Node (22+), outside SLICC.
 * Bundled to dist/host/main.mjs; dist/host/jsh.mjs (the package's `bin`,
 * src/host/launcher.mjs) imports it on a real host. See
 * docs/design/run-outside-slicc.md.
 */
import { spawn as spawnChild } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, realpathSync, writeSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { constants as osConstants } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  JSH_USAGE,
  JSH_VERSION,
  parseJshArgv,
  runJsh,
  WRAPPER_LINE_OFFSET,
  wrapSource,
} from '../jsh/run.mjs';
import { sliccyExportNames } from '../jsh/sliccy/index.mjs';

const writeFd = (fd, text) => {
  const bytes = Buffer.from(String(text));
  let off = 0;
  while (off < bytes.length) {
    try {
      off += writeSync(fd, bytes, off);
    } catch (err) {
      if (err?.code === 'EAGAIN') continue;
      throw err;
    }
  }
};

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Node 22 warns that USE_MAIN_CONTEXT_DEFAULT_LOADER is experimental; drop just that. */
function silenceLoaderWarning() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && text.includes('USE_MAIN_CONTEXT_DEFAULT_LOADER')) return;
    return emitWarning.call(this, warning, ...rest);
  };
}

function spawn(argv, { stdin } = {}) {
  let child;
  const done = new Promise((resolveDone) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolveDone(result);
      }
    };
    const out = [];
    const err = [];
    child = spawnChild(argv[0], argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      if (e?.code === 'ENOENT') {
        finish({ stdout: '', stderr: `${argv[0]}: command not found\n`, exitCode: 127 });
      } else {
        finish({ stdout: '', stderr: `${argv[0]}: ${e?.message ?? e}\n`, exitCode: 126 });
      }
    });
    child.on('close', (code, signal) => {
      finish({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? 128 + (osConstants.signals[signal] ?? 0),
      });
    });
    if (stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
  return { kill: (sig = 'SIGTERM') => child.kill(sig), done };
}

let selfRequire = null;
try {
  selfRequire = nodeModule.createRequire(fileURLToPath(import.meta.url));
} catch {
  selfRequire = null;
}

/**
 * `import('sliccy:x')` in a `.jsh` body, as the kernel engine has it: Node's
 * in-thread module hooks (module.registerHooks, Node 22.15+) resolve a
 * sliccy: specifier imported by a body (only there, as `require('sliccy:x')`)
 * to a module whose exports are its value's (see sliccyExportNames). On an
 * older Node, Node's own ERR_UNSUPPORTED_ESM_URL_SCHEME stays.
 */
const SLICCY_REGISTRY = Symbol.for('slicc-jsh.host-sliccy');
const sliccyBodies = new Map(); // body file URL -> requireSliccy
globalThis[SLICCY_REGISTRY] = (bodyUrl, id) => sliccyBodies.get(bodyUrl)(id);
let sliccyHooks = false;
function installSliccyHooks() {
  if (sliccyHooks || typeof nodeModule.registerHooks !== 'function') return;
  sliccyHooks = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('sliccy:') && sliccyBodies.has(context.parentURL)) {
        // One module per body and name: the body's own requireSliccy.
        const url = `${specifier}?jsh=${encodeURIComponent(context.parentURL)}`;
        return { url, format: 'module', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('sliccy:')) return nextLoad(url, context);
      const q = url.indexOf('?jsh=');
      const id = url.slice(0, q);
      const bodyUrl = decodeURIComponent(url.slice(q + 5));
      const value = sliccyBodies.get(bodyUrl)(id);
      const get = `globalThis[Symbol.for('slicc-jsh.host-sliccy')](${JSON.stringify(bodyUrl)}, ${JSON.stringify(id)})`;
      const lines = [`const m = ${get};`];
      sliccyExportNames(value).forEach((name, i) => {
        lines.push(name === 'default' ? 'export default m;' : `const v${i} = m[${JSON.stringify(name)}];\nexport { v${i} as ${JSON.stringify(name)} };`);
      });
      return { format: 'module', source: lines.join('\n'), shortCircuit: true };
    },
  });
}

const engine = {
  readSource: (filename) => readFileSync(filename, 'utf8'),
  compile: (body, filename, { requireSliccy } = {}) => {
    if (requireSliccy) {
      installSliccyHooks();
      sliccyBodies.set(pathToFileURL(filename).href, requireSliccy);
    }
    return vm.runInThisContext(wrapSource(body), {
      filename,
      lineOffset: WRAPPER_LINE_OFFSET,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
  },
  createRequire: (filename) => nodeModule.createRequire(filename),
  selfRequire,
  writeStdout: (s) => writeFd(1, s),
  writeStderr: (s) => writeFd(2, s),
  get stdoutIsTTY() {
    return !!process.stdout.isTTY;
  },
  spawn,
  shell: [findOnPath('bash') ?? 'sh', '-c'],
  fetch: globalThis.fetch,
  exit: (code) => process.exit(code),
};

async function main() {
  const parsed = parseJshArgv(process.argv.slice(2));
  if (parsed.action === 'version') {
    writeFd(1, `${JSH_VERSION}\n`);
    return;
  }
  if (parsed.action === 'help') {
    writeFd(1, JSH_USAGE);
    return;
  }
  if (parsed.action === 'usage') {
    writeFd(2, JSH_USAGE);
    process.exit(2);
  }
  if (parsed.action === 'error') {
    writeFd(2, `${parsed.message}\n${JSH_USAGE}`);
    process.exit(parsed.status);
  }
  const given = resolve(parsed.script);
  process.argv = [process.execPath, given, ...parsed.args];
  silenceLoaderWarning();
  // Node's main module: __filename is the real path, argv[1] as given.
  let filename = given;
  try {
    filename = realpathSync(given);
  } catch {
    /* runJsh reports a missing file */
  }
  await runJsh({ filename, engine, process, console });
}

// Not a top-level await: a script whose promise never settles must end the
// way a Node program does when its loop is empty, not with Node's exit 13.
main().catch((err) => {
  writeFd(2, `${err?.stack ?? err}\n`);
  process.exit(1);
});
