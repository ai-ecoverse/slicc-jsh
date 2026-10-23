import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('slicc-jsh kernel smoke (PR2 runtime)', () => {
  it('registers node and jsh', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['node']), { status: 0, stdout: '', stderr: '' });
      const bare = await run(['jsh']);
      assert.equal(bare.status, 2);
      assert.match(bare.stderr, /^Usage: jsh /);
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

  it('http client assembles a body delivered across delayed writes', async () => {
    const { run, close } = await withJsh();
    try {
      // Use Content-Length so completion does not depend on a flaky peer FIN under CI load.
      // (no-CL / Connection: close framing is covered by the client close fallback + HEAD test.)
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net'), http=require('http');",
          'const srv=net.createServer(sock=>{',
          "  sock.once('data',()=>{",
          "    sock.write('HTTP/1.1 200 OK\\r\\nContent-Length: 10\\r\\nConnection: close\\r\\n\\r\\npart1');",
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
      assert.equal(r.status, 0, r.stderr + r.stdout);
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

  it('http response body supports pipe, for-await, setEncoding, late listener', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const http=require('http'), {Writable}=require('stream');",
          "const body='hello-stream';",
          "const s=http.createServer((req,res)=>res.end(body));",
          "s.listen(0,async()=>{",
          "  const {port}=s.address();",
          "  const url='http://127.0.0.1:'+port+'/';",
          "  const get=()=>new Promise((resolve,reject)=>{",
          "    http.get(url,res=>resolve(res)).on('error',reject);",
          "  });",
          "  const out=[];",
          // pipe
          "  {",
          "    const res=await get();",
          "    let d='';",
          "    const w=new Writable({write(c,_,cb){d+=c;cb();}});",
          "    await new Promise((resolve,reject)=>{",
          "      w.on('finish',resolve); w.on('error',reject); res.on('error',reject);",
          "      res.pipe(w);",
          "    });",
          "    out.push('pipe:'+d);",
          "  }",
          // for-await
          "  {",
          "    const res=await get();",
          "    let d='';",
          "    for await (const c of res) d+=c;",
          "    out.push('async:'+d);",
          "  }",
          // setEncoding
          "  {",
          "    const res=await get();",
          "    res.setEncoding('utf8');",
          "    let d=''; let types=[];",
          "    await new Promise((resolve,reject)=>{",
          "      res.on('data',c=>{types.push(typeof c);d+=c;});",
          "      res.on('end',resolve); res.on('error',reject);",
          "    });",
          "    out.push('enc:'+d+':'+(types[0]||''));",
          "  }",
          // late listener after await
          "  {",
          "    const res=await get();",
          "    await new Promise(r=>setTimeout(r,10));",
          "    let d='';",
          "    await new Promise((resolve,reject)=>{",
          "      res.setEncoding('utf8');",
          "      res.on('data',c=>d+=c);",
          "      res.on('end',resolve); res.on('error',reject);",
          "    });",
          "    out.push('late:'+d);",
          "  }",
          "  console.log(out.join('|'));",
          "  s.close();",
          "  setImmediate(()=>process.exit(0));",
          "});",
        ].join(''),
      ]);
      assert.equal(r.status, 0);
      assert.equal(
        r.stdout,
        'pipe:hello-stream|async:hello-stream|enc:hello-stream:string|late:hello-stream\n'
      );
    } finally {
      close();
    }
  });

  it('http server takes a huge Content-Length at its head, as Node does, and a 413 it answers closes both sides once', async () => {
    const { run, close } = await withJsh();
    try {
      // Fail fast: a half-open 413 used to hang until the 120s test timeout.
      // Bound the kernel run and require exactly one 'close' on each socket.
      const r = await Promise.race([
        run([
          'node',
          '-e',
          [
            "const net=require('net'), http=require('http');",
            'let done=false, got413=false, clientCloses=0, serverCloses=0;',
            'const finish=(line)=>{ if(done)return; done=true; console.log(line); setImmediate(()=>process.exit(0)); };',
            'const maybe=()=>{ if(got413 && clientCloses===1 && serverCloses===1) finish("ok");',
            '  else if(clientCloses>1||serverCloses>1) finish("double-close c="+clientCloses+" s="+serverCloses); };',
            'setTimeout(()=>finish("TIMEOUT c="+clientCloses+" s="+serverCloses+" 413="+got413), 4000).unref?.();',
            "const s=http.createServer((req,res)=>{ console.log('request at the head', req.headers['content-length'], req.complete); res.writeHead(413,{Connection:'close'}); res.end(); });",
            "s.on('connection',(ss)=>{",
            '  ss.on("close",()=>{ serverCloses++; console.log("server-close",serverCloses); maybe(); });',
            '});',
            "s.listen(0,()=>{",
            "  const {port}=s.address();",
            "  const sock=net.connect({host:'127.0.0.1',port},()=>{",
            "    sock.write(",
            "      'POST / HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 999999999\\r\\n\\r\\n'",
            "    );",
            "  });",
            "  sock.on('error',()=>{});",
            "  sock.on('close',()=>{ clientCloses++; console.log('client-close',clientCloses); maybe(); });",
            "  let d='';",
            "  sock.on('data',c=>{",
            "    d+=c;",
            "    if(/^HTTP\\/1\\.1 413/.test(d)){",
            "      console.log('413'); got413=true;",
            '      try{s.close()}catch{}',
            '      maybe();',
            '    }',
            '  });',
            '});',
          ].join(''),
        ]),
        new Promise((res) =>
          setTimeout(() => res({ status: 'HOST_TIMEOUT', stdout: '', stderr: '' }), 8000)
        ),
      ]);
      assert.notEqual(r.status, 'HOST_TIMEOUT', '413 path hung past 8s host bound');
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /^request at the head 999999999 false$/m);
      assert.match(r.stdout, /^413$/m);
      assert.match(r.stdout, /^server-close 1$/m);
      assert.match(r.stdout, /^client-close 1$/m);
      assert.match(r.stdout, /^ok$/m);
      assert.doesNotMatch(r.stdout, /TIMEOUT|double-close|server-close 2|client-close 2/);
    } finally {
      close();
    }
  });

  it('http 304 preserves explicit Content-Length and omits body', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const http=require('http');",
          "const s=http.createServer((req,res)=>{",
          "  res.writeHead(304,{'Content-Length':'42'});",
          "  res.end('should-not-send');",
          "});",
          "s.listen(0,()=>{",
          "  http.get({host:'127.0.0.1',port:s.address().port},res=>{",
          "    let n=0; res.on('data',c=>n+=c.length);",
          "    res.on('end',()=>{",
          "      console.log(res.statusCode,res.headers['content-length'],n);",
          "      s.close(); setImmediate(()=>process.exit(0));",
          "    });",
          "  });",
          "});",
        ].join(''),
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '304 42 0\n');
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

  it('http client body writes across timers: chunked with no CL, as Node, and streamed with a CL', async () => {
    const { run, close } = await withJsh();
    try {
      for (const [label, headers, cl] of [
        ['nolen', '{}', 'undefined'],
        ['cl', "{'content-length':9}", '9'],
      ]) {
        const r = await run([
          'node',
          '-e',
          [
            "const http=require('http');",
            "const srv=http.createServer((req,res)=>{",
            "  let n=0,s=''; req.on('data',c=>{n+=c.length;s+=c});",
            "  req.on('end',()=>res.end('cl='+req.headers['content-length']+' got='+n+' tail='+s.slice(-3)));",
            '});',
            "srv.listen(0,'127.0.0.1',()=>{",
            `  const q=http.request({host:'127.0.0.1',port:srv.address().port,method:'POST',path:'/',headers:${headers}},res=>{`,
            "    let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ console.log('" +
              label +
              "',b); srv.close(); });",
            '  });',
            "  q.write('aaa');",
            "  setTimeout(()=>{ q.write('bbb'); setTimeout(()=>q.end('ccc'),10); },10);",
            '});',
          ].join(''),
        ]);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(r.stdout, new RegExp(`${label} cl=${cl} got=9 tail=ccc`));
      }
    } finally {
      close();
    }
  });

  it('net FIN: single close each side after peer end', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const net=require('net');",
          "const srv=net.createServer(s=>{",
          "  const ev=[];",
          "  s.on('end',()=>ev.push('end'));",
          "  s.on('close',h=>ev.push('close:'+h));",
          "  s.write('hello'); s.end();",
          // 50 ms after the server's close (a second one would show), not
          // after the connection: under load the FIN can take longer.
          "  s.once('close',()=>setTimeout(()=>{ console.log('server',ev.join(',')); srv.close(); },50));",
          '});',
          "srv.listen(0,'127.0.0.1',()=>{",
          '  const c=net.connect(srv.address().port,"127.0.0.1");',
          "  const ev=[]; let data='';",
          "  c.on('data',d=>data+=d);",
          "  c.on('end',()=>ev.push('end'));",
          "  c.on('close',h=>ev.push('close:'+h));",
          "  c.on('close',()=>console.log('client',ev.join(','),'data',data));",
          '});',
          "const hs=require('http').createServer();",
          "console.log('allowHalfOpen',hs.allowHalfOpen);",
        ].join(''),
      ]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /allowHalfOpen true/);
      assert.match(r.stdout, /client end,close:false data hello/);
      assert.match(r.stdout, /server end,close:false/);
      // Exactly one close per side (no double-close).
      assert.equal((r.stdout.match(/client end,close:false/g) || []).length, 1);
      assert.equal((r.stdout.match(/server end,close:false/g) || []).length, 1);
    } finally {
      close();
    }
  });

  it('http.Agent.destroy and reusedSocket=false', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await run([
        'node',
        '-e',
        [
          "const http=require('http');",
          'let conns=0;',
          "const srv=http.createServer((req,res)=>res.end('ok'));",
          "srv.on('connection',()=>conns++);",
          "srv.listen(0,'127.0.0.1',async()=>{",
          '  const agent=new http.Agent({keepAlive:true,maxSockets:1});',
          '  const port=srv.address().port;',
          "  await new Promise((r,j)=>http.get({host:'127.0.0.1',port,path:'/',agent},res=>{",
          "    console.log('reused',res.req.reusedSocket); res.resume(); res.on('end',r);",
          '  }).on("error",j));',
          '  agent.destroy();',
          "  console.log('destroyed',typeof agent.destroy,'conns',conns);",
          '  srv.close();',
          '});',
        ].join(''),
      ]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /reused false/);
      assert.match(r.stdout, /destroyed function/);
    } finally {
      close();
    }
  });

  it('fs.access / accessSync and -p prints strings unquoted', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/f.txt', 'x');
      const a = await run([
        'node',
        '-e',
        [
          "const fs=require('fs');",
          "fs.accessSync('/os/f.txt');",
          "fs.access('/os/f.txt',fs.constants.F_OK,err=>console.log('access',err&&err.code,fs.constants.R_OK));",
        ].join(''),
      ]);
      assert.equal(a.status, 0, a.stderr);
      assert.match(a.stdout, /access null 4/);
      const p = await run(['node', '-p', "'abc'"]);
      assert.equal(p.status, 0, p.stderr);
      assert.equal(p.stdout, 'abc\n');
    } finally {
      close();
    }
  });
});
