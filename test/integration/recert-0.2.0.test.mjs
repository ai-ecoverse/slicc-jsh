/**
 * Regression tests for hb2 re-cert MUST items (0.2.0) and the prior hb2 five.
 * Fixtures mirror cert-jsh-0.2.0/fx — keep assertions Node-identical.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

async function writeTree(kernel, files) {
  for (const [path, body] of Object.entries(files)) {
    await kernel.writeFile(path, body);
  }
}

describe('slicc-jsh 0.2.0 re-cert regressions', () => {
  it('ESM object shorthand of imported bindings', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await writeTree(kernel, {
        '/os/one.js': 'export default 1;\n',
        '/os/short.js': `import x from './one.js';\nconst o = { x };\nconsole.log('shorthand', JSON.stringify(o));\n`,
        '/os/shortdef.js': `import x from './one.js';\nexport default { x };\n`,
        '/os/short2.js': `import o from './shortdef.js';\nconsole.log('export default { x }', JSON.stringify(o));\n`,
        '/os/named.js': `export const x = 2;\n`,
        '/os/short3.js': `import { x as y } from './named.js';\nconsole.log('named shorthand', JSON.stringify({ y }));\n`,
      });
      for (const [script, expect] of [
        ['short.js', 'shorthand {"x":1}\n'],
        ['short2.js', 'export default { x } {"x":1}\n'],
        ['short3.js', 'named shorthand {"y":2}\n'],
      ]) {
        const r = await run(['node', script], { cwd: '/os' });
        assert.equal(r.status, 0, `${script}: ${r.stderr}`);
        assert.equal(r.stdout, expect);
      }
    } finally {
      close();
    }
  });

  it('caught import() evaluation errors are not uncaught', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await writeTree(kernel, {
        '/os/bad.mjs': "throw new Error('boom in esm');\n",
        '/os/esm-imp-throw.mjs':
          "try { await import('./bad.mjs'); } catch (e) { console.log('esm caught', e.message); }\nconsole.log('esm after');\n",
        '/os/cjs/imp-throw.js':
          "console.log('before');\nimport('./bad.mjs').then(() => console.log('no'), (e) => console.log('caught', e.message));\nconsole.log('after');\n",
        '/os/cjs/bad.mjs': "throw new Error('boom in esm');\n",
      });
      const esm = await run(['node', 'esm-imp-throw.mjs'], { cwd: '/os' });
      assert.equal(esm.status, 0, esm.stderr);
      assert.equal(esm.stdout, 'esm caught boom in esm\nesm after\n');
      assert.equal(esm.stderr, '');

      const cjs = await run(['node', 'cjs/imp-throw.js'], { cwd: '/os' });
      assert.equal(cjs.status, 0, cjs.stderr);
      assert.match(cjs.stdout, /before\n/);
      assert.match(cjs.stdout, /after\n/);
      assert.match(cjs.stdout, /caught boom in esm/);
      assert.equal(cjs.stderr, '');
    } finally {
      close();
    }
  });

  it('s.end(data) in net end handler (allowHalfOpen false)', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/endreply.js',
        `const net = require('net');
const srv = net.createServer((s) => {
  s.on('end', () => { try { s.end('bye'); console.log('server end() in end handler ok'); } catch (e) { console.log('server threw', e.code, e.message); } });
  s.on('close', () => { console.log('server close'); srv.close(); });
  s.resume();
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.end('ping'));
  let d = '';
  c.on('data', (x) => (d += x));
  c.on('close', () => console.log('client got', JSON.stringify(d)));
});
`
      );
      const r = await run(['node', 'endreply.js'], { cwd: '/os' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /server end\(\) in end handler ok/);
      assert.match(r.stdout, /server close/);
      assert.match(r.stdout, /client got "bye"/);
      assert.doesNotMatch(r.stderr, /write after end/);
    } finally {
      close();
    }
  });

  it('client-initiated FIN: finish, end, close:false', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/fin4.js',
        `const net = require('net'); const ev = { server: [], client: [] };
const srv = net.createServer((s) => {
  s.on('data', (d) => ev.server.push('data:' + d));
  s.on('end', () => ev.server.push('end'));
  s.on('finish', () => ev.server.push('finish'));
  s.on('close', (h) => ev.server.push('close:' + h));
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => { c.write('ping'); c.end(); });
  c.on('end', () => ev.client.push('end'));
  c.on('finish', () => ev.client.push('finish'));
  c.on('close', (h) => ev.client.push('close:' + h));
  setTimeout(() => { console.log('client', ev.client.join(','), '| server', ev.server.join(',')); srv.close(); }, 500);
});
`
      );
      const r = await run(['node', 'fin4.js'], { cwd: '/os' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout.trim(),
        'client finish,end,close:false | server data:ping,end,finish,close:false'
      );
    } finally {
      close();
    }
  });

  it('http.Agent surface + subclass createConnection', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/agent.js',
        `const http = require('http');
const out = [];
const t = (n, f) => { try { const v = f(); out.push(\`\${n}: \${typeof v === 'object' && v ? v.constructor.name : v}\`); } catch (e) { out.push(\`\${n}: threw \${e.name} \${e.code ?? ''} \${e.message.split('\\n')[0]}\`); } };
const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
t('new Agent keepAlive', () => a instanceof http.Agent);
for (const m of ['destroy', 'getName', 'createConnection', 'keepSocketAlive', 'reuseSocket', 'addRequest', 'removeSocket', 'createSocket']) t(\`typeof \${m}\`, () => typeof a[m]);
t('getName', () => a.getName({ host: 'x', port: 1 }));
t('keepAlive prop', () => a.keepAlive);
t('maxSockets', () => a.maxSockets);
t('options.keepAlive', () => a.options && a.options.keepAlive);
t('sockets/freeSockets/requests', () => [typeof a.sockets, typeof a.freeSockets, typeof a.requests].join(','));
t('destroy()', () => a.destroy());
t('globalAgent instanceof Agent', () => http.globalAgent instanceof http.Agent);
t('https.Agent', () => typeof require('https').Agent);
console.log(out.join('\\n'));
`
      );
      const r = await run(['node', 'agent.js'], { cwd: '/os' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /typeof createConnection: function/);
      assert.match(r.stdout, /getName: x:1:/);
      assert.match(r.stdout, /sockets\/freeSockets\/requests: object,object,object/);

      await kernel.writeFile(
        '/os/agent-sub.js',
        `const http = require('http');
const net = require('net');
class A extends http.Agent {
  createConnection(opts, cb) {
    console.log('custom-cc', opts.host, opts.port);
    return net.createConnection(opts, cb);
  }
}
const a = new A();
const s = http.createServer((q, r) => r.end('ok'));
s.listen(0, '127.0.0.1', () => {
  http.get({ host: '127.0.0.1', port: s.address().port, agent: a }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { console.log('body', d); s.close(); });
  });
});
`
      );
      const sub = await run(['node', 'agent-sub.js'], { cwd: '/os' });
      assert.equal(sub.status, 0, sub.stderr);
      assert.match(sub.stdout, /custom-cc/);
      assert.match(sub.stdout, /body ok/);
    } finally {
      close();
    }
  });

  it('process.exit from timer while server listens', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/exitsrv2.js',
        `const srv = require('http').createServer().listen(0, '127.0.0.1', () => {
  console.log('listening');
  setTimeout(() => { console.log('exit(5)'); process.exit(5); }, 50);
});
`
      );
      const r = await run(['node', 'exitsrv2.js'], { cwd: '/os' });
      assert.equal(r.status, 5, r.stderr);
      assert.match(r.stdout, /listening/);
      assert.match(r.stdout, /exit\(5\)/);
    } finally {
      close();
    }
  });

  it('WebSocket failed connect: Event instances, no crash without listeners', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/ws2.js',
        `const w = new WebSocket('ws://127.0.0.1:9/');
w.onerror = (e) => console.log('error event', e.type, e instanceof Event);
w.onclose = (e) => console.log('close event', e.code, e.wasClean);
`
      );
      const r = await run(['node', 'ws2.js'], { cwd: '/os' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /error event error true/);
      assert.match(r.stdout, /close event 1006 false/);
      assert.doesNotMatch(r.stderr, /event argument must be an instance of Event/);

      await kernel.writeFile(
        '/os/ws-bare.js',
        `new WebSocket('ws://127.0.0.1:9/');
setTimeout(() => console.log('survived'), 200);
`
      );
      const bare = await run(['node', 'ws-bare.js'], { cwd: '/os' });
      assert.equal(bare.status, 0, bare.stderr);
      assert.match(bare.stdout, /survived/);
    } finally {
      close();
    }
  });

  it('hb2: createRequire, dynamic import from CJS, Agent destroy/getName', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await writeTree(kernel, {
        '/os/dep.cjs': "module.exports = { v: 7 };\n",
        '/os/main.mjs': `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
console.log('req', require('./dep.cjs').v);
`,
        '/os/dyn.cjs': `import('./esm.mjs').then((m) => console.log('dyn', m.default));\n`,
        '/os/esm.mjs': "export default 42;\n",
      });
      const cr = await run(['node', 'main.mjs'], { cwd: '/os' });
      assert.equal(cr.status, 0, cr.stderr);
      assert.equal(cr.stdout, 'req 7\n');

      const dyn = await run(['node', 'dyn.cjs'], { cwd: '/os' });
      assert.equal(dyn.status, 0, dyn.stderr);
      assert.equal(dyn.stdout, 'dyn 42\n');

      const agent = await run(
        [
          'node',
          '-e',
          "const a=new (require('http').Agent)({keepAlive:true}); console.log(a.getName({host:'h',port:9}), typeof a.destroy, a.keepAlive); a.destroy();",
        ],
        { cwd: '/os' }
      );
      assert.equal(agent.status, 0, agent.stderr);
      assert.match(agent.stdout, /h:9:/);
    } finally {
      close();
    }
  });

  it('SHOULD: import() missing file → ERR_MODULE_NOT_FOUND; listen exit not EIO', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/imp-missing.js',
        `import('./nope.mjs').catch((e) => console.log('caught', e.code));
console.log('after');
`
      );
      const miss = await run(['node', 'imp-missing.js'], { cwd: '/os' });
      assert.equal(miss.status, 0, miss.stderr);
      assert.match(miss.stdout, /caught ERR_MODULE_NOT_FOUND/);

      await kernel.writeFile(
        '/os/exitsrv.js',
        `const srv = require('net').createServer().listen(0, '127.0.0.1', () => {
  console.log('listening, exit(4)');
  process.exit(4);
});
`
      );
      const ex = await run(['node', 'exitsrv.js'], { cwd: '/os' });
      assert.equal(ex.status, 4, ex.stderr);
      assert.match(ex.stdout, /listening, exit\(4\)/);
      assert.doesNotMatch(ex.stderr, /listen EIO/);
    } finally {
      close();
    }
  });
});
