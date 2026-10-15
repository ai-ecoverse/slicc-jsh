const b = Buffer.from('hello world'); const s = b.subarray(0, 5); s[0] = 0x48; const sl = b.slice(6); sl[0] = 0x57;
console.log('subarray/slice share', b.toString(), s.buffer === b.buffer, Buffer.isBuffer(s), Buffer.isBuffer(sl));
const u = new Uint8Array([1, 2, 3]); const bu = Buffer.from(u.buffer, 1, 2); bu[0] = 9; console.log('from(arraybuffer) shares', [...u]);
console.log('require buffer', require('buffer').Buffer === Buffer, typeof require('buffer').kMaxLength, typeof require('buffer').constants.MAX_LENGTH, typeof require('buffer').Blob, typeof require('node:buffer').atob);
process.env.N = 42; process.env.B = true; process.env.U = undefined; process.env.O = { a: 1 }; console.log('env', JSON.stringify([process.env.N, process.env.B, process.env.U, process.env.O, typeof process.env.N]));
delete process.env.N; console.log('env deleted', 'N' in process.env, process.env.N);
try { process.env.S = Symbol('x'); } catch (e) { console.log('env symbol', e.name); }
const { exec, execFile } = require('child_process'); const { promisify } = require('util');
(async () => {
  console.log('promisify exec', JSON.stringify(await promisify(exec)('echo out; echo err >&2')));
  console.log('promisify execFile', JSON.stringify(await promisify(execFile)('sh', ['-c', 'echo o2'])));
  try { await promisify(exec)('echo partial; echo e2 >&2; exit 3'); } catch (e) { console.log('promisify exec error', e.code, JSON.stringify(e.stdout), JSON.stringify(e.stderr), e instanceof Error, typeof e.cmd); }
  try { await promisify(execFile)('sh', ['-c', 'echo p; exit 4']); } catch (e) { console.log('promisify execFile error', e.code, JSON.stringify(e.stdout), JSON.stringify(e.stderr)); }
  try { await promisify(execFile)('no-such-zz'); } catch (e) { console.log('promisify missing', e.code, e.syscall); }
})();
