import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('slicc-jsh kernel smoke (PR2 runtime)', () => {
  it('registers node and jsh', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node']), { status: 0, stdout: '', stderr: '' });
      assert.deepEqual(await run(['jsh']), { status: 0, stdout: '', stderr: '' });
    } finally {
      close();
    }
  });

  it('runs node -e with console, Buffer, and exit codes', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node', '-e', "console.log('hi')"]), {
        status: 0,
        stdout: 'hi\n',
        stderr: '',
      });
      assert.deepEqual(await run(['node', '-p', '2+2']), {
        status: 0,
        stdout: '4\n',
        stderr: '',
      });
      assert.equal((await run(['node', '-e', 'process.exit(5)'])).status, 5);
      assert.equal((await run(['node', '-e', 'process.exitCode=9'])).status, 9);
    } finally {
      close();
    }
  });

  it('honours timer ref/unref for event-loop exit', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run(['node', '-e', "setTimeout(()=>console.log('nope'), 500).unref(); console.log('done')"]),
        { status: 0, stdout: 'done\n', stderr: '' }
      );
      assert.deepEqual(await run(['node', '-e', "setTimeout(()=>console.log('fire'), 15)"]), {
        status: 0,
        stdout: 'fire\n',
        stderr: '',
      });
    } finally {
      close();
    }
  });

  it('installs fetch and WebSocket into writable lockdown slots', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run([
          'node',
          '-e',
          "const d=Object.getOwnPropertyDescriptor(globalThis,'fetch'); console.log(typeof fetch, typeof WebSocket, d.writable, d.configurable)",
        ]),
        { status: 0, stdout: 'function function true true\n', stderr: '' }
      );
    } finally {
      close();
    }
  });

  it('zero-fills allocUnsafe and exposes poolSize 0', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run([
          'node',
          '-e',
          "const b=Buffer.allocUnsafe(8); const s=Buffer.allocUnsafeSlow(4); console.log(Buffer.poolSize, b.every(x=>x===0), s.every(x=>x===0))",
        ]),
        { status: 0, stdout: '0 true true\n', stderr: '' }
      );
    } finally {
      close();
    }
  });

  it('listens with net.createServer and closes', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run([
          'node',
          '-e',
          "const net=require('net'); const s=net.createServer(); s.listen(0, ()=>{ console.log('listening'); s.close() })",
        ]),
        { status: 0, stdout: 'listening\n', stderr: '' }
      );
    } finally {
      close();
    }
  });

  it('serves http and round-trips get', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(
        await run([
          'node',
          '-e',
          "const http=require('http'); const s=http.createServer((req,res)=>{res.end('ok')}); s.listen(0,()=>{ const {port}=s.address(); http.get('http://127.0.0.1:'+port+'/',res=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ console.log(d); s.close() }) }) })",
        ]),
        { status: 0, stdout: 'ok\n', stderr: '' }
      );
    } finally {
      close();
    }
  });

  it('http client keeps connection-close bodies until socket end', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net'), http=require('http');",
          'const srv=net.createServer(sock=>{',
          "  sock.once('data',()=>{",
          "    sock.write('HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n\\r\\npart1');",
          "    setTimeout(()=>{ sock.write('part2'); sock.end(); }, 20);",
          '  });',
          '});',
          'srv.listen(0,()=>{',
          '  const {port}=srv.address();',
          "  http.get('http://127.0.0.1:'+port+'/',res=>{",
          "    let d=''; res.on('data',c=>d+=c);",
          "    res.on('end',()=>{ console.log(d); srv.close(); setImmediate(()=>process.exit(0)); });",
          '  });',
          '});',
        ].join(''),
      ]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'part1part2\n');
    } finally {
      close();
    }
  });

  it('http client HEAD ignores Content-Length body wait', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net'), http=require('http');",
          "const srv=net.createServer(sock=>{",
          "  sock.once('data',()=>{",
          "    sock.end('HTTP/1.1 200 OK\\r\\nContent-Length: 1234\\r\\nConnection: close\\r\\n\\r\\n');",
          "  });",
          "});",
          "srv.listen(0,()=>{",
          "  const {port}=srv.address();",
          "  const req=http.request({host:'127.0.0.1',port,path:'/',method:'HEAD'},res=>{",
          "    let n=0; res.on('data',c=>n+=c.length);",
          "    res.on('end',()=>{ console.log(res.statusCode,n); srv.close(); process.exit(0); });",
          "  });",
          "  req.on('error',()=>{});",
          "  req.end();",
          "});",
        ].join(''),
      ]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '200 0\n');
    } finally {
      close();
    }
  });

  it('http server decodes chunked request bodies', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net'), http=require('http');",
          "const s=http.createServer((req,res)=>{",
          "  let d=''; req.on('data',c=>d+=c);",
          "  req.on('end',()=>{ console.log(d); res.end('ok'); s.close(); setImmediate(()=>process.exit(0)); });",
          "});",
          "s.listen(0,()=>{",
          "  const {port}=s.address();",
          "  const sock=net.connect({host:'127.0.0.1',port},()=>{",
          // Drain the response so res.end() can finish before we exit.
          "    sock.on('data',()=>{});",
          "    sock.end(",
          "      'POST / HTTP/1.1\\r\\nHost: localhost\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n'",
          "      + '5\\r\\nhello\\r\\n0\\r\\n\\r\\n'",
          "    );",
          "  });",
          "  sock.on('error',()=>{});",
          "});",
        ].join(''),
      ]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'hello\n');
    } finally {
      close();
    }
  });

  it('http server rejects oversized Content-Length with 413', async () => {
    const { run, close } = await withJsh();
    try {
      // Assert on the first response bytes — do not wait for peer FIN (ctx.net gap).
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net'), http=require('http');",
          "const s=http.createServer(()=>{ console.log('should-not-run'); });",
          "s.listen(0,()=>{",
          "  const {port}=s.address();",
          "  const sock=net.connect({host:'127.0.0.1',port},()=>{",
          "    sock.write(",
          "      'POST / HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 999999999\\r\\n\\r\\n'",
          "    );",
          "  });",
          "  sock.on('error',()=>{});",
          "  let d='';",
          "  sock.on('data',c=>{",
          "    d+=c;",
          "    if(/^HTTP\\/1\\.1 413/.test(d)){",
          "      console.log('413');",
          '      try{sock.destroy()}catch{}',
          '      try{s.close()}catch{}',
          // process.exit throws NodeExitError — leave the 'data' emit stack.
          '      setImmediate(()=>process.exit(0));',
          '    }',
          '  });',
          '});',
        ].join(''),
      ]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '413\n');
    } finally {
      close();
    }
  });

  it('resolves CJS require over node_modules on the memory root', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/node_modules/demo/package.json',
        JSON.stringify({ name: 'demo', main: 'index.js' })
      );
      await kernel.writeFile('/os/node_modules/demo/index.js', 'module.exports = { v: 42 };\n');
      await kernel.writeFile(
        '/os/app.js',
        "const d = require('demo'); console.log(d.v, require('path').join('x', 'y'));\n"
      );
      assert.deepEqual(await run(['node', 'app.js']), {
        status: 0,
        stdout: '42 x/y\n',
        stderr: '',
      });
    } finally {
      close();
    }
  });
});
