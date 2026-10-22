const { MessageChannel, receiveMessageOnPort } = require('worker_threads');
const log = (...a) => console.log(...a);
const three = (mode) => {
  const chans = ['a', 'b', 'c'].map((name) => [name, new MessageChannel()]);
  for (const [name, { port1, port2 }] of chans) {
    if (mode.includes('m2')) port2.on('message', (m) => log(name, '2 message', m));
    if (mode.includes('c2')) port2.on('close', () => log(name, '2 closed'));
    if (mode.includes('m1')) port1.on('message', (m) => log(name, '1 message', m));
    if (mode.includes('c1')) port1.on('close', () => log(name, '1 closed'));
    if (mode.includes('post')) port1.postMessage(name);
  }
  if (mode.includes('imm')) setImmediate(() => log('immediate'));
  if (mode.includes('t50')) setTimeout(() => log('timeout 50'), 50);
  for (const i of [1, 0, 2]) chans[i][1][mode.includes('from2') ? 'port2' : 'port1'].close();
  log('closed 1, 0, 2');
};
const cases = {
  'three m2c2': () => three('m2c2'),
  'three c2': () => three('c2'),
  'three m2c2c1': () => three('m2c2c1'),
  'three c1': () => three('c1'),
  'three m2c2m1c1': () => three('m2c2m1c1'),
  'three c2c1 from2': () => three('c2c1-from2'),
  'three c2 t50': () => three('c2-t50'),
  'three c2c1 imm': () => three('c2c1-imm'),
  'three m2c2c1 post imm': () => three('m2c2c1-post-imm'),
  'one of three refd': () => {
    const chans = ['a', 'b', 'c'].map((n) => [n, new MessageChannel()]);
    for (const [n, { port2 }] of chans) port2.on('close', () => log(n, '2 closed'));
    chans[1][1].port2.on('message', () => {});
    for (const [, { port1 }] of chans) port1.close();
  },
  'unref with a listener': () => {
    const { port1, port2 } = new MessageChannel();
    port2.on('message', () => {});
    port2.unref();
    port2.on('close', () => log('2 closed'));
    port1.close();
  },
  'beforeExit goes on': () => {
    const { port1, port2 } = new MessageChannel();
    port2.on('close', () => log('2 closed'));
    port1.close();
    let once = false;
    process.on('beforeExit', () => {
      log('beforeExit');
      if (!once) {
        once = true;
        setImmediate(() => log('immediate from beforeExit'));
      }
    });
  },
  'two check phases': () => {
    const chans = ['a', 'b', 'c'].map((n) => [n, new MessageChannel()]);
    for (const [n, { port1, port2 }] of chans) {
      port2.on('message', () => {});
      port2.on('close', () => log(n, '2 closed'));
      port1.on('close', () => log(n, '1 closed'));
    }
    chans[2][1].port1.close();
    setImmediate(() => {
      chans[0][1].port1.close();
      chans[1][1].port1.close();
    });
  },
  'to the closing end': () => {
    const { port1, port2 } = new MessageChannel();
    port1.on('message', (m) => log('1 message', m));
    port1.on('close', () => log('1 closed'));
    port2.on('close', () => log('2 closed'));
    port2.postMessage('x');
    port1.close();
    setImmediate(() => log('immediate'));
  },
  'a listener after close': () => {
    const { port1, port2 } = new MessageChannel();
    port2.postMessage('x');
    port1.close();
    setImmediate(() => port1.on('message', (m) => log('1 message', m)));
    port1.on('close', () => log('1 closed'));
  },
  'closed from a timer': () => {
    const { port1, port2 } = new MessageChannel();
    port1.on('message', (m) => log('1 message', m));
    port1.on('close', () => log('1 closed'));
    port2.on('message', (m) => log('2 message', m));
    port2.on('close', () => log('2 closed'));
    port2.postMessage('x');
    port1.postMessage('y');
    setTimeout(() => {
      port1.close();
      log('closed in a timer');
      setImmediate(() => log('immediate'));
    }, 5);
  },
  'closed in a handler': () => {
    const { port1, port2 } = new MessageChannel();
    const c = new MessageChannel();
    port2.on('message', (m) => {
      log('2 message', m);
      port2.close();
      c.port1.close();
      setImmediate(() => log('immediate'));
      process.nextTick(() => log('tick'));
    });
    port2.on('close', () => {
      log('2 closed');
      setImmediate(() => log('immediate from its close'));
    });
    port1.on('close', () => log('1 closed'));
    c.port1.on('close', () => log('c1 closed'));
    c.port2.on('close', () => log('c2 closed'));
    c.port2.on('message', () => {});
    port1.postMessage('x');
  },
  'closed in a close handler': () => {
    const a = new MessageChannel();
    const b = new MessageChannel();
    a.port2.on('message', () => {});
    b.port2.on('message', () => {});
    a.port1.on('close', () => {
      log('a1 closed');
      b.port1.close();
      setImmediate(() => log('immediate from a1'));
    });
    a.port2.on('close', () => log('a2 closed'));
    b.port1.on('close', () => log('b1 closed'));
    b.port2.on('close', () => log('b2 closed'));
    a.port1.close();
  },
  'posted from an immediate while a close waits': () => {
    const a = new MessageChannel();
    const b = new MessageChannel();
    b.port2.on('message', (m) => log('b2 message', m));
    b.port2.on('close', () => log('b2 closed'));
    a.port1.on('close', () => {
      log('a1 closed');
      b.port2.close();
    });
    setImmediate(() => {
      b.port1.postMessage('x');
      log('posted');
    });
    a.port1.close();
  },
  'posted from the main script while a close waits': () => {
    const a = new MessageChannel();
    const b = new MessageChannel();
    b.port2.on('message', (m) => log('b2 message', m));
    b.port2.on('close', () => log('b2 closed'));
    a.port1.on('close', () => {
      log('a1 closed');
      b.port2.close();
    });
    b.port1.postMessage('x');
    a.port1.close();
  },
  'held before its close': () => {
    const { port1, port2 } = new MessageChannel();
    port1.postMessage('x');
    port1.postMessage('y');
    port1.close();
    port2.on('message', (m) => log('2 message', m));
    port2.on('close', () => log('2 closed'));
    setImmediate(() => log('immediate'));
  },
  'started after its close': () => {
    const { port1, port2 } = new MessageChannel();
    port1.postMessage('x');
    port1.close();
    port2.on('close', () => log('2 closed'));
    setTimeout(() => {
      log('timeout');
      port2.on('message', (m) => log('2 message', m));
    }, 10);
  },
  'received until its close': () => {
    (async () => {
      const peerClosed = new MessageChannel();
      peerClosed.port1.postMessage('before its other end closed');
      peerClosed.port1.close();
      const selfClosed = new MessageChannel();
      selfClosed.port1.postMessage('before it closed itself');
      selfClosed.port2.close();
      log('at once', receiveMessageOnPort(selfClosed.port2)?.message);
      selfClosed.port1.postMessage('after it closed itself');
      await new Promise((resolve) => setImmediate(resolve));
      log('after an immediate', receiveMessageOnPort(peerClosed.port2)?.message, '|', receiveMessageOnPort(selfClosed.port2)?.message);
      setTimeout(() => log('later', receiveMessageOnPort(selfClosed.port2)?.message), 10);
    })();
  },
};
if (require.main === module) cases[process.argv[2]]();
else module.exports = Object.keys(cases);
