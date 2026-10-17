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
 * @param {{ nodeTransport?: boolean, hostLoopback?: boolean | number[], transport?: object }} [options]
 *   `nodeTransport: true` (default) matches the cert harness — WebSockets reach
 *   the host. Pass `false` for the kernel's default loopback transport (refused
 *   connects reject quickly; used to assert error-Event mapping).
 *   `hostLoopback` is nodeTransport's opt-in (slicc-kernel 1.84.0+) for a test
 *   that talks to a server on the host's own loopback; without it the
 *   transport refuses such destinations (403, EACCES for a WebSocket).
 */
export async function withJsh(options = {}) {
  const useNodeTransport = options.nodeTransport !== false;
  const transportOptions = options.hostLoopback != null ? { hostLoopback: options.hostLoopback } : {};
  // `transport`: an embedder's own (a RealmTransport), for tests that need to
  // see what the kernel's transport is asked.
  const kernel = await createNodeKernel(
    options.transport
      ? { network: { transport: options.transport } }
      : useNodeTransport
        ? { network: { transport: nodeTransport(transportOptions) } }
        : {}
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

/**
 * An installed devDependency and every package it depends on (its
 * `dependencies` and installed `optionalDependencies`, found as Node finds
 * them, nested `node_modules` included), as [kernel path, bytes] pairs under
 * /node_modules/, laid out as npm installed them: a real package and its tree
 * for a kernel program to require.
 */
export function devPackageTree(name) {
  const modules = join(root, 'node_modules');
  const dirs = new Set();
  const locate = (pkg, from) => {
    for (let dir = from; dir.startsWith(modules); dir = join(dir, '..')) {
      const candidate = join(dir, 'node_modules', pkg);
      try {
        if (statSync(join(candidate, 'package.json')).isFile()) return candidate;
      } catch {
        /* not here */
      }
      if (dir === modules) break;
    }
    try {
      if (statSync(join(modules, pkg, 'package.json')).isFile()) return join(modules, pkg);
    } catch {
      /* not installed */
    }
    return undefined;
  };
  const visit = (dir) => {
    if (dirs.has(dir)) return;
    dirs.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const found = locate(dep, dir);
      if (found) visit(found);
      else if (!manifest.optionalDependencies?.[dep]) throw new Error(`${dep} (needed by ${dir}) is not installed`);
    }
  };
  const top = join(modules, name);
  visit(top);
  const out = [];
  const walk = (d, skipNested) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      // A nested node_modules holds packages of their own (visited on their own).
      if (n === 'node_modules' && skipNested) continue;
      if (statSync(p).isDirectory()) walk(p, skipNested);
      else out.push([`/node_modules/${relative(modules, p).replaceAll('\\', '/')}`, readFileSync(p)]);
    }
  };
  for (const dir of dirs) walk(dir, true);
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

/** The installed @ai-ecoverse/slicc-kernel's version. */
export const kernelVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
).version;

/** Whether the installed kernel is `min` (x.y.z) or newer. */
export function kernelAtLeast(min) {
  const a = kernelVersion.split(/[.-]/).map(Number);
  const b = min.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
