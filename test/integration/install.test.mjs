import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { root } from './run-script.mjs';

const run = (t, kase) =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', [join(root, 'test/install/run.sh'), kase], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    t.signal.addEventListener('abort', kill, { once: true });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      t.signal.removeEventListener('abort', kill);
      resolve({ status, out });
    });
  });

for (const [kase, what] of [
  ['node', 'with Node 22 or later on PATH: an older version piped from curl, a #!/usr/bin/env jsh script, a failed upgrade that keeps it, an upgrade to the latest, JSH_HOME, JSH_BIN_DIR and an odd bin dir'],
  ['no-node', 'with no Node, or a too-old one, and no terminal: a clean failure with the instructions'],
  ['pty', 'with no Node on a pseudo-terminal: no stops, yes downloads Node 22 and adds the rc line'],
  ['uninstall', '--uninstall removes what it wrote and leaves what it did not'],
  ['integrity', '--integrity and JSH_INTEGRITY pin the tarball, and a wrong or malformed value is refused'],
]) {
  test(`install.sh ${what}`, { timeout: 600_000 }, async (t) => {
    const { status, out } = await run(t, kase);
    assert.equal(status, 0, out);
    assert.match(out, /^all install\.sh cases passed$/m, out);
    assert.doesNotMatch(out, /^FAIL: /m, out);
  });
}
