/**
 * node:wasi on slicc-kernel 1.133.0's ctx.sync.wasi.create
 * (ai-ecoverse/slicc-kernel#1111). The golden wasi-node22 holds it against
 * host Node; these are jsh's own parts: which fds a WASI program's stdio can
 * be, and the kernels without a WASI host.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('node:wasi (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    // prog.wasm (prog.wat): args, environment, the preopen's name, its data.txt, then exit 44.
    await jsh.kernel.writeFile('/os/wasi/prog.wasm', readFileSync(join(root, 'test/golden/fixtures/wasi-node22/prog.wasm')));
    await jsh.kernel.writeFile('/os/wasi/sandbox/data.txt', 'from the sandbox\n');
  });
  after(() => jsh?.close());

  const run = async (stdout) => {
    await jsh.kernel.writeFile(
      '/os/wasi/main.js',
      `const fs = require('fs');
const { WASI } = require('wasi');
const stdout = ${stdout};
try {
  const wasi = new WASI({ version: 'preview1', args: ['prog'], preopens: { '/s': __dirname + '/sandbox' }, stdout });
  const code = wasi.start(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(__dirname + '/prog.wasm')), wasi.getImportObject()));
  fs.writeSync(1, 'code ' + code + '\\n');
} catch (e) {
  fs.writeSync(1, e.code + ' ' + e.message + '\\n');
}
`
    );
    return jsh.run(['node', '--no-warnings', 'main.js'], { cwd: '/os/wasi' });
  };

  it('a file fs opened is no stdout for WASI: ERR_NOT_SUPPORTED, not output lost', async () => {
    const r = await run("fs.openSync(__dirname + '/out.txt', 'w')");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      "ERR_NOT_SUPPORTED slicc-jsh: options.stdout can't be fd 3, a file fs opened (it has no kernel fd); use 0, 1, 2 or a device\n"
    );
  });

  it('a device fs opened is: /dev/null takes the program\'s stdout', async () => {
    const r = await run("fs.openSync('/dev/null', 'w')");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'code 44\n');
    assert.equal(r.stderr, 'on stderr\n');
  });
});
