// The forked side: answers what script.js asks.
const mode = process.argv[2];
const v8 = require('v8');
const describe = (m) => (typeof m === 'object' && m !== null ? Object.prototype.toString.call(m) : typeof m);

if (mode === 'echo') {
  process.on('message', (m) => {
    if (m === 'bye') {
      process.send('bye too', () => process.disconnect());
      return;
    }
    process.send({ got: m, kind: describe(m) });
  });
} else if (mode === 'info') {
  process.send({
    send: typeof process.send,
    connected: process.connected,
    channelFd: process.env.NODE_CHANNEL_FD,
    mode: process.env.NODE_CHANNEL_SERIALIZATION_MODE,
    channel: typeof process.channel,
    fd: process.channel && process.channel.fd,
    execArgv: process.execArgv,
    argv: process.argv.slice(2),
  });
  process.disconnect();
} else if (mode === 'advanced') {
  process.once('message', (m) => {
    const map = m.map;
    process.send({
      map: map instanceof Map && [...map],
      set: m.set instanceof Set && [...m.set],
      date: m.date instanceof Date && m.date.toISOString(),
      big: typeof m.big,
      buf: Buffer.isBuffer(m.buf) ? 'Buffer ' + m.buf.toString('hex') : describe(m.buf),
      u16: m.u16 instanceof Uint16Array && [...m.u16],
      err: m.err instanceof Error && [m.err.constructor.name, m.err.message, m.err.cause],
      circular: m.circular.self === m.circular,
      holes: m.arr.length + ' ' + (1 in m.arr) + ' ' + m.arr[2],
      undef: 'u' in m && m.u === undefined,
    });
    process.send(new Map([['back', new Set([1n])]]));
    process.disconnect();
  });
} else if (mode === 'json-lossy') {
  process.once('message', (m) => {
    process.send({ seen: m, keys: Object.keys(m) });
    process.disconnect();
  });
} else if (mode === 'internal') {
  process.send({ cmd: 'NODE_TEST', n: 1 });
  process.send({ cmd: 'NODE_', n: 2 });
  process.send({ cmd: 'user', n: 3 });
  process.disconnect();
} else if (mode === 'many') {
  let n = 0;
  process.on('message', (m) => {
    n++;
    if (m === 'done') {
      process.send({ received: n - 1 });
      process.disconnect();
    }
  });
} else if (mode === 'big') {
  process.once('message', (m) => {
    // Disconnect once it is written: Node drops a write still queued when the channel closes.
    process.send({ length: m.length, head: m.slice(0, 5), back: 'y'.repeat(300000) }, () => process.disconnect());
  });
} else if (mode === 'stay') {
  // A 'message' listener keeps the child while the channel is open.
  process.on('message', () => {});
  process.on('disconnect', () => {
    console.log('child: parent disconnected');
  });
  process.send('ready');
} else if (mode === 'no-listener') {
  // No listener: the channel doesn't keep the child.
  setTimeout(() => console.log('child: done without listeners'), 10);
} else if (mode === 'exit-code') {
  process.send('about to exit');
  process.exitCode = 7;
  process.disconnect();
} else if (mode === 'wait-kill') {
  process.on('message', () => {});
  process.send('ready');
} else if (mode === 'silent') {
  console.log('to stdout');
  console.error('to stderr');
  process.send('sent');
  process.disconnect();
} else if (mode === 'serializer') {
  process.send({ serialized: v8.deserialize(v8.serialize({ a: [1, 2] })) });
  process.disconnect();
}
