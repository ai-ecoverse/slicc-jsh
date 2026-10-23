import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRoot } from '@ai-ecoverse/slicc-kernel/node';
import { withJsh } from './helpers.mjs';

const NAMES = ['sync.txt', 'callback.txt', 'handle.txt', 'stream.txt', 'read-stream.txt'];

async function full(root, name) {
  const dir = await root.getDirectoryHandle('os', { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  handle.createWritable = async () => {
    const refuse = async () => {
      throw new DOMException('the quota is used up', 'QuotaExceededError');
    };
    return { write: refuse, seek: refuse, truncate: refuse, close: refuse, abort: async () => {} };
  };
}

describe('fs close of a file whose write-back fails (kernel)', () => {
  let jsh;
  before(async () => {
    const root = memoryRoot();
    jsh = await withJsh({ root });
    for (const name of NAMES) await full(root, name);
  });
  after(() => jsh?.close());

  it("gives the close's error, as Node's close(2) does", async () => {
    await jsh.kernel.writeFile(
      '/os/close.js',
      [
        "const fs = require('fs');",
        'const show = (label, e) => console.log(label, e ? `${e.code} ${e.syscall} ${e.message}` : "closed");',
        'const write = (fd) => { try { fs.writeSync(fd, "data"); } catch (e) { console.log("write", e.code); } };',
        '(async () => {',
        "  let fd = fs.openSync('sync.txt', 'r+'); write(fd);",
        "  try { fs.closeSync(fd); show('closeSync'); } catch (e) { show('closeSync', e); }",
        "  try { fs.closeSync(fd); } catch (e) { show('closeSync again', e); }",
        "  fd = fs.openSync('callback.txt', 'r+'); write(fd);",
        "  await new Promise((r) => fs.close(fd, (e) => r(show('close', e))));",
        "  const fh = await fs.promises.open('handle.txt', 'r+');",
        "  await fh.write('data').catch((e) => console.log('write', e.code));",
        "  await fh.close().then(() => show('FileHandle.close'), (e) => show('FileHandle.close', e));",
        "  await fh.close().then(() => show('FileHandle.close again'), (e) => show('FileHandle.close again', e));",
        "  const ws = fs.createWriteStream('stream.txt', { flags: 'r+' });",
        "  ws.on('error', (e) => show('stream error', e)).on('close', () => console.log('stream close'));",
        "  ws.end('data');",
        "  await new Promise((r) => ws.on('close', r));",
        "  const rfd = fs.openSync('read-stream.txt', 'r+'); write(rfd);",
        "  const rs = fs.createReadStream(null, { fd: rfd });",
        "  rs.on('error', (e) => show('read stream error', e)).on('close', () => console.log('read stream close'));",
        "  rs.destroy(new Error('destroyed'));",
        '})();',
      ].join('\n')
    );
    const r = await jsh.run(['node', 'close.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const enospc = 'ENOSPC close ENOSPC: no space left on device, close';
    assert.deepEqual(r.stdout.trimEnd().split('\n'), [
      'write ENOSPC',
      `closeSync ${enospc}`,
      'closeSync again EBADF close EBADF: bad file descriptor, close',
      'write ENOSPC',
      `close ${enospc}`,
      'write ENOSPC',
      `FileHandle.close ${enospc}`,
      'FileHandle.close again EBADF close file closed',
      `stream error ${enospc}`,
      'stream close',
      'write ENOSPC',
      `read stream error ${enospc}`,
      'read stream close',
    ]);
  });
});
