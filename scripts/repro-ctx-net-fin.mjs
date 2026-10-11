/**
 * Minimal repro: ctx.net loopback does not deliver peer FIN to the client reader.
 *
 * Entry: Node (`createNodeKernel` / `@ai-ecoverse/slicc-kernel/node`)
 * Kernel: see package.json engines / installed @ai-ecoverse/slicc-kernel version.
 *
 * Server writes a close-framed HTTP response (no Content-Length) then end()s.
 * Client receives the bytes but never sees readable 'end' / reader done within the
 * deadline — so Connection: close body framing cannot complete without guessing.
 *
 *   node scripts/repro-ctx-net-fin.mjs
 *
 * Expect: exit 2 and "TIMEOUT … (no end)". Exit 0 means FIN works (bug fixed).
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
    // No Content-Length / TE — body framed by connection close.
    sock.end('HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n\\r\\nhello');
  });
});
srv.listen(0, () => {
  const { port } = srv.address();
  const c = net.connect({ host: '127.0.0.1', port }, () => {
    c.write('GET / HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n');
  });
  let n = 0;
  c.on('data', (d) => {
    n += d.length;
  });
  c.on('end', () => {
    console.log('END bytes=' + n);
    srv.close();
    process.exit(0);
  });
  c.on('error', () => {});
  setTimeout(() => {
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
// Exit 0 from this harness means the repro ran; inner TIMEOUT (2) confirms the bug.
process.exit(result.stdout.includes('TIMEOUT') || result.stdout.includes('END ') ? 0 : 1);
