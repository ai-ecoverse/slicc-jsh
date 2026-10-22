import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh, wrapCommandMain } from './helpers.mjs';


const IGNORING = `
async function ignoring(ctx) {
  const net = new Proxy(ctx.net, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (k !== 'connect') return typeof v === 'function' ? v.bind(t) : v;
      return (options = {}) => {
        if (!options.tls) return t.connect(options);
        const { tls, host, port, ...rest } = options;
        return t.connect({ ...rest, host: '127.0.0.1', port: Number(ctx.env.PEER_PORT) });
      };
    },
  });
  return __main(new Proxy(ctx, { get: (t, k) => (k === 'net' ? net : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
}
export { ignoring as default };
`;

const PROGRAM = `
const net = require('net');
const tls = require('tls');
const https = require('https');
let bytes = 0;
const open = new Set();
let dialled = 0;
const peer = net.createServer((s) => {
  dialled++;
  open.add(s);
  s.on('data', (d) => { bytes += d.length; console.log('peer: got', JSON.stringify(String(d).split('\\r\\n')[0])); process.exit(1); });
  s.on('close', () => { open.delete(s); done(); });
});
let errors = 0;
const done = () => {
  if (errors < 2 || open.size) return;
  console.log('peer: dialled', dialled > 0, 'bytes', bytes);
  peer.close();
};
const failed = (what) => (e) => { console.log(what, e.code, e.message.includes('example.test')); errors++; done(); };
peer.listen(Number(process.env.PEER_PORT), '127.0.0.1', () => {
  const t = tls.connect({ host: 'example.test', port: 443, servername: 'example.test' });
  t.write('GET /secret HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n');
  t.on('secureConnect', () => console.log('tls.connect: secureConnect'));
  t.on('error', failed('tls.connect'));
  t.on('close', () => {
    const req = https.request({ host: 'example.test', path: '/secret', method: 'POST', agent: new https.Agent({ keepAlive: true }) }, () => console.log('https: a response'));
    req.on('error', failed('https.request'));
    req.end('password=hunter2');
  });
});
`;

describe('a kernel that ignores the TLS request: jsh sends nothing over the plain connection', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile(
      '/node_modules/tls-ignored-node/package.json',
      JSON.stringify({ name: 'tls-ignored-node', slicc: { commands: { 'tls-ignored-node': { abi: 'js', module: 'node.mjs' } } } })
    );
    await jsh.kernel.writeFile('/node_modules/tls-ignored-node/node.mjs', wrapCommandMain('node', IGNORING));
    await jsh.kernel.writeFile('/os/tls-ignored.js', PROGRAM);
  });
  after(() => jsh?.close());

  it('tls.connect and https.request get ERR_NOT_SUPPORTED, and the peer the kernel dialled got 0 bytes', async () => {
    const run = jsh.run(['tls-ignored-node', 'tls-ignored.js'], { cwd: '/os', env: { PEER_PORT: '40443' } });
    let bound;
    const r = await Promise.race([run, new Promise((resolve) => (bound = setTimeout(() => resolve({ stdout: 'still running after 60 s: neither an error nor bytes\n', stderr: '', status: null }), 60_000)))]);
    clearTimeout(bound);
    assert.equal(r.stdout, 'tls.connect ERR_NOT_SUPPORTED true\nhttps.request ERR_NOT_SUPPORTED true\npeer: dialled true bytes 0\n', r.stderr);
    assert.equal(r.status, 0, r.stderr);
  });
});
