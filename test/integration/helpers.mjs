import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';

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
 */
export async function withJsh() {
  const kernel = await createNodeKernel();
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
