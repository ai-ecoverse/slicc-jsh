/**
 * jsh net.mjs close-frame smoke (not a kernel repro — see run-raw-ctx-net-fin.mjs).
 *
 * Server writes a close-framed HTTP response (no Content-Length) then end()s.
 * Client should see 'end' after the body (half-close via writer.close()).
 *
 *   node scripts/repro-ctx-net-fin.mjs
 *
 * Expect: "END bytes=…". TIMEOUT means jsh net.mjs is still mishandling EOF.
 */
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFiles } from '../test/integration/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jshPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const kernelPkg = JSON.parse(
  readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
);

const DEADLINE_MS = 2000;

const kernel = await createNodeKernel();
const base = '/node_modules/@ai-ecoverse/slicc-jsh';
for (const [rel, data] of packageFiles()) {
  await kernel.writeFile(`${base}/${rel}`, data);
}

console.log(
  JSON.stringify({
    entry: 'node (createNodeKernel)',
    'slicc-kernel': kernelPkg.version,
    'slicc-jsh': jshPkg.version,
    deadlineMs: DEADLINE_MS,
  })
);

const script = `
const net = require('net');
const deadline = ${DEADLINE_MS};
const srv = net.createServer((sock) => {
  sock.once('data', () => {
    setImmediate(() => {
      sock.end('HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n\\r\\nhello');
    });
  });
});
srv.listen(0, () => {
  const { port } = srv.address();
  const c = net.connect({ host: '127.0.0.1', port }, () => {
    c.write('GET / HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n');
  });
  let n = 0;
  let ended = false;
  c.on('data', (d) => {
    n += d.length;
  });
  c.on('end', () => {
    ended = true;
    console.log('END bytes=' + n);
    srv.close();
    setImmediate(() => process.exit(0));
  });
  c.on('error', () => {});
  setTimeout(() => {
    if (ended) return;
    console.log('TIMEOUT bytes=' + n + ' (no end)');
    try { c.destroy(); } catch {}
    try { srv.close(); } catch {}
    setImmediate(() => process.exit(2));
  }, deadline);
});
`;

const result = await kernel.run(['node', '-e', script], { cwd: '/os' });
console.log(
  JSON.stringify({
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim().slice(0, 200),
  })
);
kernel.terminate();
const ok = result.status === 0 && /^END bytes=/.test(result.stdout);
process.exit(ok ? 0 : 1);
