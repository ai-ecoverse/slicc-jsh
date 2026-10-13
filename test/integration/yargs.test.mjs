import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withJsh } from './helpers.mjs';

// yargs 17 keeps `cwd: process.cwd` in its shim and calls it detached: Node's
// process methods work from any receiver, and so must jsh's (0.12.1's cert
// regression). The real package, with its dependencies, from node_modules.
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** yargs and its dependency tree, at their node_modules paths under /os. */
function packageTree(name) {
  const files = [];
  const seen = new Set();
  const visit = (pkg, fromDir) => {
    // Node's lookup: node_modules/<pkg> in fromDir or an ancestor.
    let dir;
    for (let d = fromDir; ; d = dirname(d)) {
      const candidate = join(d, 'node_modules', pkg);
      if (existsSync(join(candidate, 'package.json'))) {
        dir = candidate;
        break;
      }
      if (dirname(d) === d) throw new Error(`no ${pkg} from ${fromDir}`);
    }
    if (seen.has(dir)) return;
    seen.add(dir);
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (n !== 'node_modules') walk(p);
        } else files.push([`/os/${relative(root, p).replaceAll('\\', '/')}`, readFileSync(p)]);
      }
    };
    walk(dir);
    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {};
    for (const dep of Object.keys(deps)) visit(dep, dir);
  };
  visit(name, root);
  return files;
}

describe('yargs 17 (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of packageTree('yargs')) await jsh.kernel.writeFile(path, data);
    await jsh.kernel.writeFile(
      '/os/y.mjs',
      "import yargs from 'yargs';\nimport { hideBin } from 'yargs/helpers';\nconst argv = yargs(hideBin(process.argv)).option('name', { type: 'string' }).parseSync();\nconsole.log(JSON.stringify({ a: argv.a, name: argv.name, _: argv._ }));\n"
    );
    await jsh.kernel.writeFile(
      '/os/y.cjs',
      "const yargs = require('yargs');\nconst { hideBin } = require('yargs/helpers');\nconst argv = yargs(hideBin(process.argv)).command('greet <who>', 'greet', () => {}, (a) => console.log('hello', a.who)).parseSync();\nconsole.log(JSON.stringify(argv._));\n"
    );
  });
  after(() => jsh?.close());

  it('ESM: hideBin + parseSync', async () => {
    const r = await jsh.run(['node', 'y.mjs', '--a', '1', '--name', 'x', 'pos']);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, '{"a":1,"name":"x","_":["pos"]}\n');
  });

  it('CJS: a command', async () => {
    const r = await jsh.run(['node', 'y.cjs', 'greet', 'world']);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'hello world\n["greet"]\n');
  });

  it('--help prints its usage', async () => {
    const r = await jsh.run(['node', 'y.mjs', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--name\s+\[string\]/);
  });
});
