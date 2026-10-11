/**
 * Probe https.get redirect behaviour and plain 200 on Node vs browser-shaped transport.
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

// Callback-driven (no top-level async IIFE): jsh's process may exit once the
// main script returns even if promises are pending.
const PROBE = [
  "const https=require('https');",
  "const out={};",
  "function get(url,cb){",
  "  const req=https.get(url,res=>{",
  "    cb(null,{statusCode:res.statusCode,location:res.headers.location||null});",
  "    res.resume();",
  "  });",
  "  req.setTimeout(20000,()=>req.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})));",
  "  req.on('error',e=>cb(null,{error:String(e&&e.message||e),causeCode:e&&e.cause&&e.cause.code,code:e&&e.code}));",
  "}",
  "get('https://example.com/',(e,r)=>{",
  "  out.get200=r;",
  "  get('https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302',(e2,r2)=>{",
  "    out.get302=r2;",
  "    console.log(JSON.stringify(out));",
  "    setImmediate(()=>process.exit(0));",
  "  });",
  "});",
].join('');

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
