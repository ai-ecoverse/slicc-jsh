import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The golden cluster-trace-events-node22 pins both modules against Node;
// here the real prom-client's cluster aggregation runs as the primary, and
// a fork throws when it's called.
describe('cluster (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('prom-client')) await jsh.kernel.writeFile(`/os${path}`, data);
  });
  after(() => jsh?.close());

  it("the real prom-client's AggregatorRegistry (it requires cluster) aggregates as the primary with no workers", async () => {
    assert.equal(version('prom-client'), '15.1.3');
    await jsh.kernel.writeFile(
      '/os/prom.js',
      `const client = require('prom-client');
const jobs = new client.Counter({ name: 'jobs_total', help: 'jobs done' });
jobs.inc(2);
const aggregator = new client.AggregatorRegistry();
aggregator.clusterMetrics().then(
  (m) => console.log('cluster metrics', JSON.stringify(m)),
  (e) => console.log('cluster error', e.message)
);
client.register.metrics().then((m) => console.log(m.split('\\n').filter((l) => l.startsWith('jobs_total')).join()));
`
    );
    const r = await jsh.run(['node', 'prom.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), ['cluster metrics ""', 'jobs_total 2', '']);
  });

  it('cluster.fork throws ERR_NOT_SUPPORTED when it is called, after setupPrimary', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const cluster = require('cluster');
cluster.on('setup', (s) => console.log('setup', s.silent));
try { cluster.fork({ X: '1' }); } catch (e) { console.log(e.code, e.message); }
console.log('workers', JSON.stringify(cluster.workers), Object.keys(cluster.settings).join());
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      "ERR_NOT_SUPPORTED slicc-jsh: 'cluster.fork' is not supported yet (child_process.fork has no IPC channel)",
      'workers {} args,exec,execArgv,silent',
      'setup false',
      '',
    ]);
  });
});
