import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

// fork's IPC channel (ai-ecoverse/slicc-kernel#1093): cluster.fork works
// there (golden cluster-fork-node22).

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The golden cluster-trace-events-node22 pins both modules against Node;
// here the real prom-client's cluster aggregation runs as the primary, and
// a fork throws when it's called, without the kernel's IPC channel.
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

  // A worker that is gone while the primary still binds the address it
  // asked for: the primary neither adds it nor answers it, and its listener
  // closes, so the primary ends. (Node answers it there, and the EPIPE is an
  // unhandled 'error' on the Worker.) raw.js sends cluster's queryServer
  // itself, then disconnects at once: the race, every time.
  it('a worker gone while the primary binds its address: the primary closes it and ends', async () => {
    await jsh.kernel.writeFile(
      '/os/race/raw.js',
      `process.send({ cmd: 'NODE_CLUSTER', act: 'online', seq: 0 });
process.send({ cmd: 'NODE_CLUSTER', act: 'queryServer', index: 0, data: null, address: '127.0.0.1', port: 0, addressType: 4, fd: -1, proxy: { port: 1 }, seq: 1 });
process.disconnect();
`
    );
    await jsh.kernel.writeFile(
      '/os/race/primary.js',
      `const cluster = require('cluster');
process.on('exit', () => console.log('primary ends'));
cluster.setupPrimary({ exec: __dirname + '/raw.js' });
cluster.fork().on('exit', (code, signal) => console.log('worker exit', code, signal));
`
    );
    const r = await jsh.run(['node', 'primary.js'], { cwd: '/os/race' });
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'worker exit 0 null\nprimary ends\n');
  });
});
