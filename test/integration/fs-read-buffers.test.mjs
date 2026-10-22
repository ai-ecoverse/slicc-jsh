import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('fs.readFile buffers own their bytes (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('gives each read its own bytes, whatever the form', async () => {
    await jsh.kernel.writeFile(
      '/os/own.js',
      [
        "const fs = require('fs');",
        "const size = 3 * 1024 * 1024 + 5; const src = Buffer.alloc(size, 'ab');",
        'const own = (b) => b.byteOffset === 0 && b.buffer.byteLength === b.length && !(b.buffer instanceof SharedArrayBuffer);',
        "fs.writeFileSync('own.bin', src); fs.writeFileSync('small.txt', 'xy');",
        '(async () => {',
        "  const fd = fs.openSync('own.bin', 'r');",
        "  const fh = await fs.promises.open('own.bin');",
        '  const reads = [',
        "    fs.readFileSync('own.bin'), fs.readFileSync('own.bin'), fs.readFileSync(fd),",
        "    await fs.promises.readFile('own.bin'), await fh.readFile(),",
        "    await new Promise((r) => fs.readFile('own.bin', (e, d) => r(d))),",
        '  ];',
        '  fs.closeSync(fd); await fh.close();',
        '  for (const b of reads) b.fill(0x7a);',
        "  const again = fs.readFileSync('own.bin');",
        '  const small = [fs.readFileSync(\'small.txt\'), fs.readFileSync(\'small.txt\')];',
        '  small[0][0] = 0x51;',
        '  console.log(reads.map((b) => [Buffer.isBuffer(b), b.length, b.every((x) => x === 0x7a), own(b)].join()).join(" "));',
        '  console.log(again.equals(src), new Set(reads.map((b) => b.buffer)).size, small.map(String).join());',
        "  for (const flags of ['r', 'r+']) {",
        '    const at = fs.openSync(\'own.bin\', flags); fs.readSync(at, Buffer.alloc(7), 0, 7, null);',
        '    const rest = fs.readFileSync(at); const end = fs.readFileSync(at); fs.closeSync(at);',
        '    console.log(flags, rest.length, rest.byteOffset, rest.every((x, i) => x === src[i + 7]), end.length, end.byteOffset);',
        '  }',
        '})();',
      ].join('\n')
    );
    const r = await jsh.run(['node', 'own.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const one = `true,${3 * 1024 * 1024 + 5},true,true`;
    const rest = 3 * 1024 * 1024 - 2;
    assert.equal(r.stdout, `${Array(6).fill(one).join(' ')}\ntrue 6 Qy,xy\nr ${rest} 0 true 0 0\nr+ ${rest} 0 true 0 0\n`);
  });
});
