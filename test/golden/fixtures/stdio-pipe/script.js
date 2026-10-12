const { Readable, Writable, Duplex } = require('stream');
const tty = require('tty');
const shape = (s) => ({
  readable: s instanceof Readable,
  writable: s instanceof Writable,
  isTTY: s.isTTY,
  fd: s.fd,
  type: s._type,
  stdio: s._isStdio,
  pipe: typeof s.pipe,
  columns: s.columns,
});
console.error(JSON.stringify({ stdin: shape(process.stdin), stdout: shape(process.stdout), stderr: shape(process.stderr) }));
console.error(JSON.stringify([tty.isatty(0), tty.isatty(1), tty.isatty(2), tty.isatty(-1), tty.isatty(1.5), tty.isatty('1')]));
console.error(typeof tty.ReadStream, typeof tty.WriteStream, process.stdin instanceof tty.ReadStream);
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => console.error('stdin end'));
