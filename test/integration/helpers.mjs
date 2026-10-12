import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';

const root = join(fileURLToPath(new URL('../..', import.meta.url)));

/** Walk package files that belong in the published tarball (not test/). */
export function packageFiles() {
  const files = [
    ['package.json', readFileSync(join(root, 'package.json'))],
    ['LICENSE', readFileSync(join(root, 'LICENSE'))],
    ['NOTICE', readFileSync(join(root, 'NOTICE'))],
    ['README.md', readFileSync(join(root, 'README.md'))],
  ];
  const dist = join(root, 'dist');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push([relative(root, path).replaceAll('\\', '/'), readFileSync(path)]);
    }
  };
  walk(dist);
  return files;
}

/**
 * Boot a Node-entry kernel with slicc-jsh installed on the memory root
 * (no OPFS). Returns { kernel, run, close }.
 *
 * @param {{ nodeTransport?: boolean }} [options]
 *   `nodeTransport: true` (default) matches the cert harness — WebSockets reach
 *   the host. Pass `false` for the kernel's default loopback transport (refused
 *   connects reject quickly; used to assert error-Event mapping).
 */
export async function withJsh(options = {}) {
  const useNodeTransport = options.nodeTransport !== false;
  const kernel = await createNodeKernel(
    useNodeTransport ? { network: { transport: nodeTransport() } } : {}
  );
  const base = '/node_modules/@ai-ecoverse/slicc-jsh';
  for (const [rel, data] of packageFiles()) {
    await kernel.writeFile(`${base}/${rel}`, data);
  }
  const run = (argv, opts = {}) => kernel.run(argv, { cwd: '/os', ...opts });
  return {
    kernel,
    run,
    close: () => kernel.terminate(),
  };
}

/**
 * Files of an installed devDependency (e.g. `@ai-ecoverse/wasm-bash`, which
 * gives the kernel `bash` and `/bin/sh`), as [kernel path, bytes] pairs under
 * /node_modules/<name>/ for kernel.writeFile.
 */
export function devPackageFiles(name) {
  const dir = join(root, 'node_modules', name);
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push([`/node_modules/${name}/${relative(dir, p).replaceAll('\\', '/')}`, readFileSync(p)]);
    }
  };
  walk(dir);
  return out;
}

/** withJsh plus /bin/sh (wasm-bash), for exec / execSync. */
export async function withJshAndSh(options = {}) {
  const env = await withJsh(options);
  for (const [path, data] of devPackageFiles('@ai-ecoverse/wasm-bash')) {
    await env.kernel.writeFile(path, data);
  }
  return env;
}
