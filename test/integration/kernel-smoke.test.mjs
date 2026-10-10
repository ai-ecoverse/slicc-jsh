import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('slicc-jsh kernel smoke (PR2 runtime)', () => {
  it('registers node and jsh', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node']), { status: 0, stdout: '', stderr: '' });
      assert.deepEqual(await run(['jsh']), { status: 0, stdout: '', stderr: '' });
    } finally {
      close();
    }
  });

  it('runs node -e with console, Buffer, and exit codes', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node', '-e', "console.log('hi')"]), {
        status: 0,
        stdout: 'hi\n',
        stderr: '',
      });
      assert.deepEqual(await run(['node', '-p', '2+2']), {
        status: 0,
        stdout: '4\n',
        stderr: '',
      });
      assert.equal((await run(['node', '-e', 'process.exit(5)'])).status, 5);
      assert.equal((await run(['node', '-e', 'process.exitCode=9'])).status, 9);
    } finally {
      close();
    }
  });

  it('honours timer ref/unref for event-loop exit', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run(['node', '-e', "setTimeout(()=>console.log('nope'), 500).unref(); console.log('done')"]),
        { status: 0, stdout: 'done\n', stderr: '' }
      );
      assert.deepEqual(await run(['node', '-e', "setTimeout(()=>console.log('fire'), 15)"]), {
        status: 0,
        stdout: 'fire\n',
        stderr: '',
      });
    } finally {
      close();
    }
  });

  it('resolves CJS require over node_modules on the memory root', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/node_modules/demo/package.json',
        JSON.stringify({ name: 'demo', main: 'index.js' })
      );
      await kernel.writeFile('/os/node_modules/demo/index.js', 'module.exports = { v: 42 };\n');
      await kernel.writeFile(
        '/os/app.js',
        "const d = require('demo'); console.log(d.v, require('path').join('x', 'y'));\n"
      );
      assert.deepEqual(await run(['node', 'app.js']), {
        status: 0,
        stdout: '42 x/y\n',
        stderr: '',
      });
    } finally {
      close();
    }
  });
});
