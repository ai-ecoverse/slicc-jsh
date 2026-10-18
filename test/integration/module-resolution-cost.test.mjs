import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withJsh } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const COUNTED = `
async function counted(ctx) {
  const counts = {};
  const counter = (target, area) =>
    new Proxy(target, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== 'function') return v;
        return (...a) => {
          const key = area + '.' + String(k);
          counts[key] = (counts[key] ?? 0) + 1;
          return Reflect.apply(v, t, a);
        };
      },
    });
  const bound = (t, k) => {
    const v = Reflect.get(t, k);
    return typeof v === 'function' ? v.bind(t) : v;
  };
  const sync = new Proxy(ctx.sync, { get: (t, k) => (k === 'fs' ? counter(t.fs, 'sync.fs') : bound(t, k)) });
  let saved = false;
  const save = () => {
    if (saved) return;
    saved = true;
    ctx.sync.fs.writeFile(ctx.env.JSH_FS_COUNTS, new TextEncoder().encode(JSON.stringify(counts)));
  };
  const wrapped = new Proxy(ctx, {
    get(t, k) {
      if (k === 'sync') return sync;
      if (k === 'fs') return counter(t.fs, 'fs');
      if (k === 'exit') return (...a) => (save(), t.exit(...a));
      return bound(t, k);
    },
  });
  try {
    return await main(wrapped);
  } finally {
    save();
  }
}
export { counted as default };
`;

const pkg = (dir, name, n) => `
{ const dir = '${dir}/node_modules/${name}';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/package.json', JSON.stringify({ name: '${name}', type: 'module', exports: './index.js' }));
  let src = '';
  for (let i = 0; i < ${n}; i++) { fs.writeFileSync(dir + '/f' + i + '.js', 'export default ' + i + ';\\n'); src += 'import f' + i + " from './f" + i + ".js';\\n"; }
  fs.writeFileSync(dir + '/index.js', src + 'export const n = f${n - 1} + 1;\\n');
  fs.writeFileSync('${dir}/${name}.mjs', "const { n } = await import('${name}'); console.log(n);"); }`;

describe('module resolution cost does not grow with the path depth (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    const node = readFileSync(join(root, 'dist/node.mjs'), 'utf8');
    const tail = 'export {\n  main as default\n};\n';
    assert.ok(node.endsWith(tail), "dist/node.mjs no longer ends with esbuild's `export { main as default }`");
    await jsh.kernel.writeFile(
      '/node_modules/counted-node/package.json',
      JSON.stringify({ name: 'counted-node', slicc: { commands: { 'counted-node': { abi: 'js', module: 'node.mjs' } } } })
    );
    await jsh.kernel.writeFile('/node_modules/counted-node/node.mjs', node.slice(0, -tail.length) + COUNTED);
  });
  after(() => jsh?.close());

  it("an import's fs calls are the same 1 and 49 directories deep: no term grows with the imports times the depth", async () => {
    const shallow = '/os/s';
    const deep = `/os/${Array.from({ length: 48 }, (_, i) => `d${i}`).join('/')}`;
    const setup = await jsh.run([
      'node',
      '-e',
      `const fs = require('fs'); ${pkg(shallow, 'small', 150)} ${pkg(shallow, 'large', 300)} ${pkg(deep, 'small', 150)} ${pkg(deep, 'large', 300)}`,
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    let runs = 0;
    const calls = async (main, n) => {
      const file = `/os/counts-${++runs}.json`;
      const r = await jsh.run(['counted-node', main], { env: { JSH_FS_COUNTS: file } });
      assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: `${n}\n`, stderr: '' });
      return JSON.parse(new TextDecoder().decode(await jsh.kernel.readFile(file)));
    };
    const minus = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));
    const total = (c) => Object.values(c).reduce((s, v) => s + v, 0);
    const s150 = await calls(`${shallow}/small.mjs`, 150);
    const s300 = await calls(`${shallow}/large.mjs`, 300);
    const d150 = await calls(`${deep}/small.mjs`, 150);
    const d300 = await calls(`${deep}/large.mjs`, 300);
    const perImportShallow = minus(s300, s150);
    const perImportDeep = minus(d300, d150);
    const report = JSON.stringify({ s150, s300, d150, d300 });
    assert.deepEqual(perImportDeep, perImportShallow, `150 more imports cost the same calls at either depth: ${report}`);
    assert.ok(total(perImportShallow) <= 150 * 8, `at most 8 fs calls per import: ${report}`);
    assert.deepEqual(minus(d300, s300), minus(d150, s150), `the depth costs the same calls for 150 and 300 imports: ${report}`);
    assert.ok(total(minus(d300, s300)) <= 48 * 4, `at most 4 fs calls per extra directory: ${report}`);
  });
});
