import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesRoot = join(fileURLToPath(new URL('../fixtures/npm', import.meta.url)));

/** Copy a vendored npm fixture tree into the kernel at `/os/node_modules/<name>/`. */
export async function installNpmFixture(kernel, name) {
  const root = join(fixturesRoot, name);
  const base = `/os/node_modules/${name}`;
  const walk = async (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (statSync(path).isDirectory()) await walk(path);
      else await kernel.writeFile(`${base}/${rel}`, readFileSync(path));
    }
  };
  await walk(root);
  return base;
}
