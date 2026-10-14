const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-'));

const pidOk = (pid) => (pid === undefined ? 'undefined' : Number.isInteger(pid) && pid > 0 ? 'number' : `bad ${pid}`);
const errShape = (e) => JSON.stringify([e.code, e.errno, e.syscall, e.path, e.spawnargs, e.message]);

/** Records a child's events, in order, and resolves on 'close'. */
function watch(label, child) {
  const events = [];
  return new Promise((resolve) => {
    child.on('spawn', () => events.push(`spawn pid=${pidOk(child.pid)}`));
    child.on('error', (e) => events.push(`error ${errShape(e)} pid=${pidOk(child.pid)}`));
    child.on('exit', (code, sig) => events.push(`exit ${code} ${sig}`));
    child.on('close', (code, sig) => {
      events.push(`close ${code} ${sig}`);
      console.log(`${label}: ${events.join(' | ')}`);
      resolve();
    });
  });
}

(async () => {
  // pid is there when spawn() returns, and it is the child's own.
  {
    const c = cp.spawn(process.execPath, ['-e', 'console.log(process.pid); process.exit(3)']);
    console.log('spawn pid at return:', pidOk(c.pid), 'exitCode', c.exitCode, 'killed', c.killed);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    await watch('exit 3', c);
    console.log('child saw its pid:', Number(out.trim()) === c.pid);
  }
  {
    const c = cp.spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'inherit'] });
    c.stdin.end('piped at once\n');
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    await watch('stdin', c);
    console.log('stdin echoed:', JSON.stringify(out));
  }
  // kill() right after spawn() reaches the child.
  {
    const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    console.log('kill at once:', c.kill(), 'killed', c.killed);
    await watch('killed', c);
  }
  {
    const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    console.log('SIGKILL at once:', c.kill('SIGKILL'));
    await watch('SIGKILL', c);
  }
  {
    const c = cp.spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    console.log('detached pid at return:', pidOk(c.pid));
    await watch('detached', c);
  }
  {
    const c = cp.spawn('/bin/sh', ['-c', 'printf "%s\\n" "$0"'], { argv0: 'zork' });
    console.log('argv0 pid at return:', pidOk(c.pid), JSON.stringify(c.spawnargs));
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    await watch('argv0', c);
    console.log('argv0 seen:', JSON.stringify(out));
  }
  {
    const f = path.join(work, 'out.txt');
    const fd = fs.openSync(f, 'w');
    const c = cp.spawn('/bin/sh', ['-c', 'echo to the fd'], { stdio: ['ignore', fd, 'inherit'] });
    fs.closeSync(fd);
    console.log('fd stdio pid at return:', pidOk(c.pid), 'stdout', c.stdout);
    await watch('fd stdio', c);
    console.log('fd got:', JSON.stringify(fs.readFileSync(f, 'utf8')));
  }
  await new Promise((resolve) => {
    const c = cp.execFile(process.execPath, ['-e', 'console.log("ef")'], (e, out) => {
      console.log('execFile:', e, JSON.stringify(out));
      resolve();
    });
    console.log('execFile pid at return:', pidOk(c.pid));
  });
  await new Promise((resolve) => {
    const c = cp.exec('echo ex; exit 2', (e, out) => {
      console.log('exec:', e && e.code, JSON.stringify(out));
      resolve();
    });
    console.log('exec pid at return:', pidOk(c.pid));
  });

  // A spawn error is an 'error' event on a later tick, with pid undefined.
  {
    let c;
    try {
      c = cp.spawn('no-such-command-zz', ['a', 'b']);
    } catch (e) {
      console.log('ENOENT threw', e.code);
    }
    console.log('ENOENT pid at return:', pidOk(c.pid), 'spawnargs', JSON.stringify(c.spawnargs));
    await watch('ENOENT', c);
    console.log('ENOENT after: pid', pidOk(c.pid), 'exitCode', c.exitCode, 'kill', c.kill());
  }
  {
    const c = cp.spawn('/no/such/dir/cmd');
    console.log('ENOENT path pid at return:', pidOk(c.pid));
    await watch('ENOENT path', c);
  }
  {
    const f = path.join(work, 'plain.sh');
    fs.writeFileSync(f, '#!/bin/sh\necho no\n');
    fs.chmodSync(f, 0o644);
    const c = cp.spawn(f, ['x']);
    console.log('EACCES pid at return:', pidOk(c.pid));
    const events = [];
    c.on('spawn', () => events.push('spawn'));
    c.on('exit', (code, sig) => events.push(`exit ${code} ${sig}`));
    await new Promise((resolve) => {
      c.on('error', (e) => {
        events.push(`error ${JSON.stringify([e.code, e.errno, e.syscall, e.spawnargs, e.message]).split(work).join('<work>')}`);
      });
      c.on('close', (code, sig) => {
        events.push(`close ${code} ${sig}`);
        resolve();
      });
    });
    console.log('EACCES:', events.join(' | '), 'pid', pidOk(c.pid));
  }
  await new Promise((resolve) => {
    const c = cp.execFile('no-such-command-zz', ['q'], (e) => {
      console.log('execFile ENOENT:', e.code, e.errno, e.syscall, e.path, JSON.stringify(e.spawnargs), e.cmd);
      resolve();
    });
    console.log('execFile ENOENT pid at return:', pidOk(c.pid));
  });
  fs.rmSync(work, { recursive: true, force: true });
})();
