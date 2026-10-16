// #93: every emitter in the runtime is a Node EventEmitter; new Stream() is one
const EventEmitter = require('events');
const { Stream, Readable, Writable, PassThrough } = require('stream');
const cp = require('child_process'); const net = require('net'); const http = require('http');
const isEE = (x) => x instanceof EventEmitter;
console.log('process', isEE(process), 'Stream', isEE(new Stream()), 'Readable', isEE(new Readable({ read() {} })), 'Writable', isEE(new Writable({ write(c, e, cb) { cb(); } })));
console.log('stdout', isEE(process.stdout), 'stdin', isEE(process.stdin), 'net.Server', isEE(net.createServer()), 'http.Server', isEE(http.createServer()));
console.log('same class', Object.getPrototypeOf(Stream.prototype) === EventEmitter.prototype, EventEmitter === require('node:events'), EventEmitter.EventEmitter === EventEmitter);
const p = new PassThrough(); const seen = [];
p.on('data', (d) => seen.push(String(d))); p.on('end', () => console.log('passthrough', seen.join('|')));
p.write('a'); p.end('b');
// One after another (#236): an http round trip, then a signal to this
// process, then a child. Their own timing gives no order (host Node's flips
// under load), so each starts from the one before. A signal handler keeps
// nothing alive: `hold` does, until it runs.
let hold;
process.once('SIGUSR2', () => {
  clearTimeout(hold);
  console.log('SIGUSR2 handled', process.listenerCount('SIGUSR2'));
  const ch = cp.spawn(process.execPath, ['-e', 'process.exit(4)']);
  console.log('child isEE', isEE(ch));
  ch.on('exit', (code) => console.log('child exit', code));
  ch.on('close', (code) => console.log('child close', code));
});
const srv = http.createServer((q, s) => s.end('ok'));
srv.on('listening', () => { console.log('listening event'); http.get({ port: srv.address().port, host: '127.0.0.1' }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { console.log('http body', b); srv.close(() => { console.log('server close event'); hold = setTimeout(() => console.log('no SIGUSR2'), 5000); process.kill(process.pid, 'SIGUSR2'); }); }); }); });
srv.listen(0, '127.0.0.1');
