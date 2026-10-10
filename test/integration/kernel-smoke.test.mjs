import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('slicc-jsh kernel smoke (PR1 skeleton)', () => {
  it('registers node and jsh and both exit 0', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node']), { status: 0, stdout: '', stderr: '' });
      assert.deepEqual(await run(['jsh']), { status: 0, stdout: '', stderr: '' });
    } finally {
      close();
    }
  });
});
