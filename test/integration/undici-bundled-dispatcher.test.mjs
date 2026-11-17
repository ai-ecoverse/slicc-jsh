/**
 * A copy of undici that a bundle carries keeps its own global dispatcher, as
 * npm undici does (#1270). The kernel's Node entry runs programs in a realm
 * whose global holds the host Node's dispatcher (undici's
 * `Symbol.for('undici.globalDispatcher.2')`). The CJS loader moved npm
 * undici's lib to a slot of its own, but a bundled copy, such as the one in
 * cf's ES module dist, which rolldown writes with backtick quotes, or
 * wrangler's CommonJS bundle, still found the host's Agent. Its sockets were
 * the host's, which the program's event loop doesn't count, so
 * `cf auth login` exited 13 on an unsettled top-level await as soon as it
 * fetched.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { withJsh } from './helpers.mjs';

const require = createRequire(import.meta.url);

const bundle = async (format) => {
  const out = await build({
    stdin: {
      contents: "export { fetch, getGlobalDispatcher } from 'undici';",
      resolveDir: dirname(require.resolve('undici/package.json')),
    },
    bundle: true,
    platform: 'node',
    format,
    target: 'node22',
    write: false,
    logLevel: 'silent',
    ...(format === 'esm'
      ? { banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' } }
      : {}),
  });
  return out.outputFiles[0].text;
};

const runner = (spec) => `import { createServer } from 'node:http';
const planted = { dispatch() { return false; }, close() {}, destroy() {} };
// The host's slot, by a key the loaders don't remap (they remap the literal).
Object.defineProperty(globalThis, Symbol.for(['undici', 'globalDispatcher', '2'].join('.')), {
  value: planted,
  writable: true,
  enumerable: false,
  configurable: false,
});
const { fetch, getGlobalDispatcher } = await import(${JSON.stringify(spec)});
console.log('own dispatcher', getGlobalDispatcher() !== planted);
// The planted one never answers.
if (getGlobalDispatcher() === planted) process.exit(1);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.flushHeaders();
  setTimeout(() => res.end('late ' + req.url), 20);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
for (let i = 0; i < 3; i++) {
  const res = await fetch(base + '/' + i);
  console.log(res.status, await res.text());
}
server.close();
`;

const expected = 'own dispatcher true\n200 late /0\n200 late /1\n200 late /2\n';

describe('a bundled undici keeps its own global dispatcher (#1270)', () => {
  let jsh;

  before(async () => {
    jsh = await withJsh();
    const esm = await bundle('esm');
    assert.match(esm, /Symbol\.for\("undici\.globalDispatcher\.2"\)/);
    // rolldown's output (cf's dist) quotes it with backticks.
    const backticks = esm.replaceAll(/Symbol\.for\("(undici\.globalDispatcher\.[12])"\)/g, 'Symbol.for(`$1`)');
    await jsh.kernel.writeFile('/os/dist/undici-esm.mjs', esm);
    await jsh.kernel.writeFile('/os/dist/undici-backticks.mjs', backticks);
    await jsh.kernel.writeFile('/os/dist/undici.cjs', await bundle('cjs'));
    for (const name of ['esm', 'backticks', 'cjs']) {
      const spec = name === 'cjs' ? './dist/undici.cjs' : `./dist/undici-${name}.mjs`;
      await jsh.kernel.writeFile(`/os/run-${name}.mjs`, runner(spec));
    }
  });

  after(() => jsh?.close());

  for (const [name, what] of [
    ['esm', 'an ES module bundle'],
    ['backticks', 'an ES module bundle that quotes with backticks (rolldown, cf)'],
    ['cjs', 'a CommonJS bundle (esbuild, wrangler)'],
  ]) {
    it(`${what} fetches through its own Agent`, async () => {
      const out = await jsh.run(['node', `run-${name}.mjs`]);
      assert.deepEqual(out, { status: 0, stdout: expected, stderr: '' });
    });
  }
});
