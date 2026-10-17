import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// The golden inspector-node22 pins the surface against a Node whose
// inspector is not active. What would start one throws when it is called.
describe('inspector (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('inspector.open and Session#connect throw ERR_NOT_SUPPORTED when called; the rest answers as an inactive inspector', async () => {
    const r = await jsh.run([
      'node',
      '--input-type=module',
      '-e',
      `import inspector from 'node:inspector';
import { Session } from 'node:inspector/promises';
const t = (label, f) => { try { console.log(label, f()); } catch (e) { console.log(label, e.code, e.message); } };
t('open', () => inspector.open(9300, '127.0.0.1'));
t('connect', () => new inspector.Session().connect());
t('promises connect', () => new Session().connect());
t('url', () => inspector.url());
t('waitForDebugger', () => inspector.waitForDebugger());
await new Session().post('Profiler.enable').catch((e) => console.log('post', e.code, e.message));
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      "open ERR_NOT_SUPPORTED slicc-jsh: 'inspector.open' is not supported yet (no inspector in the kernel)",
      "connect ERR_NOT_SUPPORTED slicc-jsh: 'inspector.Session.connect' is not supported yet (no inspector in the kernel)",
      "promises connect ERR_NOT_SUPPORTED slicc-jsh: 'inspector.Session.connect' is not supported yet (no inspector in the kernel)",
      'url undefined',
      'waitForDebugger ERR_INSPECTOR_NOT_ACTIVE Inspector is not active',
      'post ERR_INSPECTOR_NOT_CONNECTED Session is not connected',
      '',
    ]);
  });
});
