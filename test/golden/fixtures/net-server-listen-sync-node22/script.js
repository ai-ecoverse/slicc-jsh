const net = require('net');

const state = (s) => {
  const a = s.address();
  return `address ${a ? typeof a.port : a} listening ${s.listening} handle ${s._handle ? 'yes' : 'no'}`;
};

function attempt(label, server, args) {
  return new Promise((resolve) => {
    const order = [];
    let inside = true;
    const done = (event) => {
      order.push(event);
      if (order.length < 2) return;
      console.log(label, 'order', order.join(' then '));
      resolve();
    };
    server.removeAllListeners('listening');
    server.removeAllListeners('error');
    server.once('listening', () => {
      console.log(label, 'listening', inside ? 'inside listen' : 'later', state(server));
      done('listening');
    });
    server.once('error', (e) => {
      console.log(label, 'error', inside ? 'inside listen' : 'later', e.code, e.syscall, state(server));
      done('error');
    });
    server.listen(...args);
    inside = false;
    console.log(label, 'after listen', state(server));
    process.nextTick(() => done('nextTick'));
  });
}

const closed = (s) => new Promise((resolve) => s.close(resolve));

async function main() {
  for (const [label, args] of [
    ['listen(0)', [0]],
    ['listen({ port: 0 })', [{ port: 0 }]],
    ['listen()', []],
    ["listen(0, '127.0.0.1')", [0, '127.0.0.1']],
    ["listen(0, 'localhost')", [0, 'localhost']],
    ["listen(0, 'no-such-host.invalid')", [0, 'no-such-host.invalid']],
  ]) {
    const s = net.createServer();
    await attempt(label, s, args);
    await closed(s);
  }

  const holder = net.createServer((socket) => socket.end('held'));
  await attempt('holder', holder, [0]);
  const port = holder.address().port;
  const second = net.createServer((socket) => socket.end('second'));
  await attempt('listen(port) in use', second, [port]);
  await new Promise((resolve) => holder._handle.close(resolve));
  await attempt('listen(port) freed', second, [port]);
  console.log('same port', second.address().port === port);
  const got = await new Promise((resolve, reject) => {
    let data = '';
    net
      .connect(port, '127.0.0.1')
      .on('data', (d) => (data += d))
      .on('end', () => resolve(data))
      .on('error', reject);
  });
  console.log('connected to', got);
  await closed(second);
  await closed(holder);
  console.log('done');
}

main();
