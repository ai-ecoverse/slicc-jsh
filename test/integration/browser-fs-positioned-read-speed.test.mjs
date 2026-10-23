import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from '../browser/chrome.mjs';
import { booted } from '../browser/kernel.mjs';
import { packageFiles, withJsh, wrapCommandMain } from './helpers.mjs';

const kernel = JSON.parse(readFileSync(new URL('../../node_modules/@ai-ecoverse/slicc-kernel/package.json', import.meta.url), 'utf8')).version;
const MIB = 1024 * 1024;
const CHUNKS = [64 * 1024, 256 * 1024, MIB, 4 * MIB, 16 * MIB, 64 * MIB];

const bench = [
  "const fs = require('fs');",
  `const MIB = ${MIB};`,
  `const CHUNKS = ${JSON.stringify(CHUNKS)};`,
  'const [file, mib, make] = process.argv.slice(2);',
  'const size = Number(mib) * MIB;',
  'const STRIDE = 4093;',
  'const sample = (h, buf, n, pos) => {',
  '  for (let i = (STRIDE - (pos % STRIDE)) % STRIDE; i < n; i += STRIDE) h = (Math.imul(h, 31) + buf[i]) | 0;',
  '  return h;',
  '};',
  'if (make) {',
  "  const fd = fs.openSync(file, 'w');",
  '  const block = Buffer.alloc(MIB);',
  '  let x = 0x9e3779b9;',
  '  for (let at = 0; at < size; at += MIB) {',
  '    for (let i = 0; i < MIB; i += 4) {',
  '      x ^= x << 13;',
  '      x ^= x >>> 17;',
  '      x ^= x << 5;',
  '      block.writeInt32LE(x | 0, i);',
  '    }',
  '    fs.writeSync(fd, block, 0, MIB, at);',
  '  }',
  '  fs.closeSync(fd);',
  '  process.exit(0);',
  '}',
  'const whole = fs.readFileSync(file);',
  'const want = sample(0, whole, whole.length, 0);',
  'const rows = [];',
  'const row = (label, chunk, ms, h) => rows.push(`${label} ${chunk} ${Math.round(size / ms / 1000)} ${h === want ? "same" : "DIFFERENT"}`);',
  'const timed = async (label, chunk, fn) => {',
  '  const start = performance.now();',
  '  const h = await fn();',
  '  row(label, chunk, performance.now() - start, h);',
  '};',
  '(async () => {',
  "  const fd = fs.openSync(file, 'r');",
  '  for (const chunk of CHUNKS) {',
  '    const buf = Buffer.allocUnsafe(chunk);',
  "    await timed('readSync', chunk, () => {",
  '      let h = 0;',
  '      for (let pos = 0; pos < size; pos += chunk) h = sample(h, buf, fs.readSync(fd, buf, 0, chunk, pos), pos);',
  '      return h;',
  '    });',
  '  }',
  '  const rbuf = Buffer.allocUnsafe(MIB);',
  "  await timed('fs.read', MIB, async () => {",
  '    let h = 0;',
  '    for (let pos = 0; pos < size; pos += MIB) {',
  '      const n = await new Promise((resolve, reject) => fs.read(fd, rbuf, 0, MIB, pos, (e, got) => (e ? reject(e) : resolve(got))));',
  '      h = sample(h, rbuf, n, pos);',
  '    }',
  '    return h;',
  '  });',
  '  fs.closeSync(fd);',
  "  const fh = await fs.promises.open(file, 'r');",
  '  for (const chunk of [MIB, 64 * MIB]) {',
  '    const buf = Buffer.allocUnsafe(chunk);',
  "    await timed('FileHandle.read', chunk, async () => {",
  '      let h = 0;',
  '      for (let pos = 0; pos < size; pos += chunk) h = sample(h, buf, (await fh.read(buf, 0, chunk, pos)).bytesRead, pos);',
  '      return h;',
  '    });',
  '  }',
  '  await fh.close();',
  '  for (const chunk of [MIB, 16 * MIB]) {',
  "    await timed('createReadStream', chunk, async () => {",
  '      let h = 0;',
  '      let pos = 0;',
  '      for await (const c of fs.createReadStream(file, { start: 0, highWaterMark: chunk })) {',
  '        h = sample(h, c, c.length, pos);',
  '        pos += c.length;',
  '      }',
  '      return h;',
  '    });',
  '  }',
  "  await timed('readFileSync', size, () => sample(0, fs.readFileSync(file), size, 0));",
  "  await timed('promises.readFile', size, async () => sample(0, await fs.promises.readFile(file), size, 0));",
  "  console.log(rows.join('\\n'));",
  '})();',
].join('\n');

const plainread = wrapCommandMain(
  'node',
  `const hide = (target, gone) => new Proxy(target, {
  get(t, key) {
    if (key === gone) return undefined;
    const value = Reflect.get(t, key, t);
    return typeof value === 'function' ? value.bind(t) : value;
  },
  has: (t, key) => key !== gone && key in t,
});
export default function plainread(ctx) {
  const open = (path, options) => hide(ctx.sync.open(path, options), 'readInto');
  const sync = new Proxy(ctx.sync, {
    get(t, key) {
      if (key === 'open') return open;
      const value = Reflect.get(t, key, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return __main(new Proxy({}, { get: (_, key) => (key === 'sync' ? sync : ctx[key]), has: (_, key) => key in ctx }));
}
`
);
const plainPackage = JSON.stringify({ name: 'plainread', version: '1.0.0', type: 'module', slicc: { commands: { plainread: { abi: 'js', module: 'index.mjs' } } } });

const passes = (runs) => {
  const table = new Map();
  for (const [path, stdout] of runs) {
    for (const line of stdout.trim().split('\n')) {
      const [label, chunk, speed, check] = line.split(' ');
      assert.equal(check, 'same', line);
      const key = `${label} ${chunk}`;
      if (!table.has(key)) table.set(key, { read: [], readInto: [] });
      table.get(key)[path].push(Number(speed));
    }
  }
  return [...table].map(([key, { read, readInto }]) => `${key}: read ${read.join(', ')} | readInto ${readInto.join(', ')} MB/s`).join('\n');
};

const ROUNDS = ['readInto', 'read', 'readInto', 'read'];

test(`positioned reads in the Node kernel return the file's bytes at every chunk size, and report their speed, kernel ${kernel}`, { timeout: 600_000 }, async () => {
  const jsh = await withJsh();
  try {
    await jsh.kernel.writeFile('/node_modules/plainread/package.json', plainPackage);
    await jsh.kernel.writeFile('/node_modules/plainread/index.mjs', plainread);
    await jsh.kernel.writeFile('/os/bench.js', bench);
    const made = await jsh.run(['node', 'bench.js', 'big.bin', '128', 'make']);
    assert.equal(made.status, 0, made.stderr);
    const runs = [];
    for (const path of ROUNDS) {
      const r = await jsh.run([path === 'read' ? 'plainread' : 'node', 'bench.js', 'big.bin', '128']);
      assert.equal(r.status, 0, r.stderr);
      runs.push([path, r.stdout]);
    }
    console.log(`Node kernel ${kernel}, 128 MiB\n${passes(runs)}`);
  } finally {
    jsh.close();
  }
});

const pack = mkdtempSync(join(tmpdir(), 'jsh-pread-pack-'));
let chrome;

before(async () => {
  const put = (path, data) => {
    mkdirSync(dirname(join(pack, path)), { recursive: true });
    writeFileSync(join(pack, path), data);
  };
  for (const [rel, data] of packageFiles()) put(`node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
  put('node_modules/plainread/package.json', plainPackage);
  put('node_modules/plainread/index.mjs', plainread);
  put('home/bench.js', bench);
  chrome = await launch({ pack: `${pack}/` });
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

test(`positioned reads of an OPFS file in the browser return its bytes at every chunk size, and report their speed, kernel ${kernel}`, { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  const names = packageFiles().map(([rel]) => `node_modules/@ai-ecoverse/slicc-jsh/${rel}`);
  names.push('node_modules/plainread/package.json', 'node_modules/plainread/index.mjs', 'home/bench.js');
  await k.page.evaluate(async (list) => {
    for (const name of list) {
      const bytes = new Uint8Array(await (await fetch(`/pack/${name}`)).arrayBuffer());
      let dir = await navigator.storage.getDirectory();
      const parts = name.split('/');
      const base = parts.pop();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(base, { create: true })).createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  }, names);
  await k.reboot();
  const made = await k.run(['node', 'bench.js', 'big.bin', '256', 'make']);
  assert.equal(made.status, 0, made.stderr);
  await k.reboot();
  const runs = [];
  for (const path of ROUNDS) {
    const r = await k.run([path === 'read' ? 'plainread' : 'node', 'bench.js', 'big.bin', '256']);
    assert.equal(r.status, 0, r.stderr);
    runs.push([path, r.stdout]);
  }
  console.log(`browser, kernel ${kernel}, 256 MiB OPFS file\n${passes(runs)}`);
  assert.equal((await k.run(['rm', '/home/big.bin'])).status, 0);
  assert.deepEqual(k.page.errors, []);
});
