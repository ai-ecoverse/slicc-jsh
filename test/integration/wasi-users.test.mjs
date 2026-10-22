/**
 * node:wasi under users: enforce. A WASI preopen is a second way into the
 * VFS beside fs: the guest's path_open, fd_write and path_unlink_file are
 * the kernel's WASI host's, under the running user's credentials. As `cone`,
 * with preopens of another user's directory, /etc and /dev, what Linux
 * refuses is EACCES (WASI errno 2) and changes nothing; cone's own files
 * work, and a new one takes the umask. (ops.wasm, from ops.wat: an
 * operation on a path in the preopen, its errno the exit code.)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('node:wasi under users: enforce (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.users.add({ name: 'cone' });
    await jsh.kernel.users.add({ name: 'other' });
    await jsh.kernel.writeFile('/tmp/ops.wasm', readFileSync(join(root, 'test/fixtures/wasi/ops.wasm')));
    await jsh.kernel.writeFile('/etc/jsh-wasi.txt', 'root\'s\n');
    await jsh.kernel.writeFile(
      '/tmp/setup.js',
      "const fs = require('fs'); fs.mkdirSync(process.argv[2], { mode: 0o755 }); fs.writeFileSync(process.argv[2] + '/secret.txt', 'theirs\\n', { mode: 0o600 });\n"
    );
    await jsh.kernel.writeFile(
      '/tmp/ops.js',
      `const fs = require('fs');
const { WASI } = require('wasi');
const mod = new WebAssembly.Module(fs.readFileSync('/tmp/ops.wasm'));
const run = (dir, op, path) => {
  try {
    const wasi = new WASI({ version: 'preview1', args: ['ops', op, path], preopens: { '/p': dir }, returnOnExit: true });
    return wasi.start(new WebAssembly.Instance(mod, wasi.getImportObject()));
  } catch (e) {
    return e.code;
  }
};
if (process.argv[2]) process.umask(Number(process.argv[2]));
const out = [];
for (const [dir, op, path] of JSON.parse(process.argv[3] ?? '[]')) out.push(dir + ' ' + op + ' ' + path + ' ' + run(dir, op, path));
console.log(out.join('\\n'));
`
    );
  });
  after(() => jsh?.close());

  it("refuses another user's files, /etc and /dev as Linux does, and takes cone's own with its umask", async () => {
    assert.equal((await jsh.run(['node', '/tmp/setup.js', '/tmp/other'], { user: 'other', cwd: '/tmp' })).status, 0);
    assert.equal((await jsh.run(['node', '/tmp/setup.js', '/tmp/cone'], { user: 'cone', cwd: '/tmp' })).status, 0);
    const ops = [
      ['/tmp/other', 'r', 'secret.txt'],
      ['/tmp/other', 'c', 'new.txt'],
      ['/tmp/other', 'u', 'secret.txt'],
      ['/etc', 'c', 'x.txt'],
      ['/etc', 'r', 'jsh-wasi.txt'],
      ['/etc', 'u', 'jsh-wasi.txt'],
      ['/dev', 'c', 'zz'],
      ['/tmp/cone', 'r', 'secret.txt'],
      ['/tmp/cone', 'c', 'mine.txt'],
      ['/tmp/cone', 'u', 'secret.txt'],
    ];
    const r = await jsh.run(['node', '--no-warnings', '/tmp/ops.js', '0o027', JSON.stringify(ops)], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        '/tmp/other r secret.txt 2',
        '/tmp/other c new.txt 2',
        '/tmp/other u secret.txt 2',
        '/etc c x.txt 2',
        '/etc r jsh-wasi.txt 0',
        '/etc u jsh-wasi.txt 2',
        '/dev c zz 2',
        '/tmp/cone r secret.txt 0',
        '/tmp/cone c mine.txt 0',
        '/tmp/cone u secret.txt 0',
        '',
      ].join('\n')
    );
    // Nothing refused changed; cone's new file is cone's, with umask 027.
    const left = await jsh.run(
      [
        'node',
        '-e',
        "const fs = require('fs'); for (const p of ['/tmp/other/secret.txt', '/tmp/other/new.txt', '/etc/x.txt', '/etc/jsh-wasi.txt', '/dev/zz', '/tmp/cone/mine.txt', '/tmp/cone/secret.txt']) { try { const s = fs.statSync(p); console.log(p, (s.mode & 0o777).toString(8), s.uid, fs.readFileSync(p, 'utf8').trim()); } catch (e) { console.log(p, e.code); } }",
      ],
      { cwd: '/tmp' }
    );
    assert.equal(
      left.stdout,
      "/tmp/other/secret.txt 600 1001 theirs\n/tmp/other/new.txt ENOENT\n/etc/x.txt ENOENT\n/etc/jsh-wasi.txt 644 0 root's\n/dev/zz ENOENT\n/tmp/cone/mine.txt 640 1000 x\n/tmp/cone/secret.txt ENOENT\n"
    );
  });
});
