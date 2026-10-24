const { fork } = require('child_process');
const net = require('net');
const tls = require('tls');

if (process.send) {
  process.on('message', (m, h) => process.send(`the child got ${m} ${h === undefined ? 'with no handle' : `with a ${h.constructor.name}`}`));
  process.on('internalMessage', (m, h) => {
    if (m.cmd === 'NODE_HANDLE') process.send(`the child got a NODE_HANDLE for a ${m.type} ${h ? 'with' : 'without'} its handle`);
  });
  return;
}

const out = [];
const cp = fork(__filename);
const tryIt = (label, fn) => {
  try {
    out.push(`${label}: returned ${fn()}`);
  } catch (e) {
    out.push(`${label}: ${e.name} ${e.code} ${e.message}`);
  }
};
const callback = (label) => (err) => out.push(`${label} callback ${err}`);
const replies = (n) => new Promise((resolve) => {
  const on = (m) => {
    out.push(m);
    if (--n === 0) {
      cp.off('message', on);
      resolve();
    }
  };
  cp.on('message', on);
});

(async () => {
  tryIt('an object', () => cp.send('object', {}));
  tryIt('a number', () => cp.send('number', 5));
  tryIt('a string', () => cp.send('string', 'x'));
  tryIt('an array', () => cp.send('array', []));
  tryIt('a function as the handle', () => cp.send('fn', callback('fn')));
  tryIt('options not an object', () => cp.send('opts', null, 'nope'));
  tryIt('a null handle', () => cp.send('null', null));
  tryIt('an unconnected socket', () => cp.send('unconnected socket', new net.Socket(), callback('unconnected')));
  tryIt('a server not listening', () => cp.send('server not listening', net.createServer(), callback('not listening')));
  await replies(4);

  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => closed.close(resolve));
  tryIt('a closed server', () => cp.send('closed server', closed, callback('closed server')));
  await replies(1);

  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  net.connect(srv.address().port, '127.0.0.1').on('error', () => {});
  const accepted = await new Promise((resolve) => srv.once('connection', resolve));
  accepted.destroy();
  await new Promise((resolve) => accepted.on('close', resolve));
  srv.close();
  tryIt('a destroyed socket', () => cp.send('destroyed socket', accepted, callback('destroyed')));
  await replies(1);

  cp.disconnect();
  tryIt('a server after disconnect', () => cp.send('late', net.createServer(), callback('late')));
  await new Promise((resolve) => cp.on('exit', resolve));

  const cp2 = fork(__filename);
  cp2.on('message', (m) => out.push(m));
  process.on('uncaughtException', (e) => {
    out.push(`uncaught ${e.name} ${e.code} ${e.message}`);
    setTimeout(() => {
      cp2.disconnect();
      for (const line of out) console.log(line);
    }, 100);
  });
  tryIt('a TLSSocket', () => cp2.send('tls', new tls.TLSSocket(new net.Socket()), callback('tls')));
  tryIt('a send behind it', () => cp2.send('after it', callback('after it')));
})();
