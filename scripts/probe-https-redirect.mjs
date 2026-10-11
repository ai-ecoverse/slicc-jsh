/**
 * Probe redirect: 'manual' as seen by jsh (ctx.fetch / https.get).
 *
 * - Node entry: default nodeTransport (manualRedirects: true)
 * - Browser-shaped: fetchTransport({ redirect: 'follow' }) — same traits as the
 *   page default (manualRedirects: false). Real browser entry uses that transport.
 *
 *   node scripts/probe-https-redirect.mjs
 */
import { createNodeKernel, fetchTransport, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';
import { packageFiles } from '../test/integration/helpers.mjs';

async function withInstalledJsh(kernel) {
  const base = '/node_modules/@ai-ecoverse/slicc-jsh';
  for (const [rel, data] of packageFiles()) {
    await kernel.writeFile(`${base}/${rel}`, data);
  }
}

/**
 * In-realm http 302 via fetch(redirect:'manual'), plus https.get against a
 * public 302 (Node transport only — browser-shaped rejects manual before dial).
 */
const PROBE = `
const http = require('http');
const https = require('https');
(async () => {
  const out = {};
  const srv = http.createServer((req, res) => {
    if (req.url === '/from') {
      res.writeHead(302, { Location: '/to', 'Content-Length': '0' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('landed');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const url = 'http://127.0.0.1:' + port + '/from';
  try {
    const res = await fetch(url, { redirect: 'manual' });
    out.fetch = {
      statusCode: res.status,
      type: res.type,
      location: res.headers.get('location'),
    };
  } catch (e) {
    out.fetch = {
      error: String(e && e.message || e),
      causeCode: e && e.cause && e.cause.code,
    };
  }
  const httpsUrl = 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302';
  out.httpsGet = await new Promise((resolve) => {
    const req = https.get(httpsUrl, (res) => {
      resolve({ statusCode: res.statusCode, location: res.headers.location || null });
      res.resume();
    });
    req.setTimeout(12000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      resolve({
        error: String(e && e.message || e),
        causeCode: e && e.cause && e.cause.code,
        code: e && e.code,
      });
    });
  });
  console.log(JSON.stringify(out));
  srv.close();
})().catch((e) => { console.error(String(e)); process.exitCode = 1; });
`;

async function runProbe(label, transport) {
  const kernel = await createNodeKernel({ network: { transport } });
  try {
    await withInstalledJsh(kernel);
    const result = await kernel.run(['node', '-e', PROBE], { cwd: '/os' });
    console.log('---', label, '---');
    console.log('exit', result.status);
    console.log(result.stdout.trim() || '(no stdout)');
    if (result.stderr.trim()) console.log('stderr:', result.stderr.trim().slice(0, 400));
    return result;
  } finally {
    kernel.terminate();
  }
}

await runProbe('Node entry (nodeTransport, manualRedirects: true)', nodeTransport());
await runProbe(
  'Browser-shaped (fetchTransport redirect:follow, manualRedirects: false)',
  fetchTransport({ redirect: 'follow', webSocket: true, webSocketHeaders: true })
);
