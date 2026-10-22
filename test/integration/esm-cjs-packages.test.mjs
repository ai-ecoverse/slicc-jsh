import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { node22Bin } from '../../scripts/node22.mjs';
import { devPackageTree, withJsh } from './helpers.mjs';
import { root } from './run-script.mjs';

const PACKAGES = [
  'express',
  'ioredis',
  'googleapis-common',
  '@smithy/node-http-handler',
  'prom-client',
  'nats',
  'readable-stream',
  'string_decoder',
  'superagent',
  'ssh2',
  'smtp-server',
  'abort-controller',
  'undici',
];

const probe = `${PACKAGES.map((name, i) => `import * as p${i} from '${name}';`).join('\n')}
for (const [name, ns] of [${PACKAGES.map((name, i) => `['${name}', p${i}]`).join(', ')}]) {
  console.log(name, typeof ns.default, Object.keys(ns).sort().join(' '));
}
`;

describe('ESM imports of CommonJS npm packages: the named exports Node finds (cjs-module-lexer, re-exports included)', { timeout: 300_000 }, () => {
  let jsh;
  let host;
  before(async () => {
    mkdirSync(join(root, 'node_modules/.cache'), { recursive: true });
    host = mkdtempSync(join(root, 'node_modules/.cache/jsh-esm-cjs-'));
    writeFileSync(join(host, 'probe.mjs'), probe);
    jsh = await withJsh();
    const written = new Set();
    for (const name of PACKAGES) {
      for (const [path, data] of devPackageTree(name)) {
        if (written.has(path)) continue;
        written.add(path);
        await jsh.kernel.writeFile(path, data);
      }
    }
    await jsh.kernel.writeFile('/os/probe.mjs', probe);
  });
  after(() => {
    jsh?.close();
    if (host) rmSync(host, { recursive: true, force: true });
  });

  it('import * as ns gives the same keys, and the same default, as host Node 22.22.0', async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const expected = execFileSync(node22Bin(), ['probe.mjs'], { cwd: host, env, encoding: 'utf8' });
    assert.equal(expected.trim().split('\n').length, PACKAGES.length);
    const r = await jsh.run(['node', 'probe.mjs']);
    assert.deepEqual(r, { status: 0, stdout: expected, stderr: '' });
  });
});
