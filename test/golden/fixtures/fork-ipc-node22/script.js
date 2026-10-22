// child_process.fork and 'ipc' in spawn's stdio against host Node 22. Each
// case waits for the last thing it expects before the next one starts, so
// the order of events is the child's and the parent's, never a race.
const { fork, spawn, spawnSync } = require('child_process');
const path = require('path');
const child = path.join(__dirname, 'child.js');
const log = (...args) => console.log(...args);
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const err = (e) => `${e.constructor.name} ${e.code} ${e.message}`;
const events = (cp, label) => {
  const seen = [];
  const ends = {};
  const end = (event) => (code, signal) => {
    if (!ends.disconnect && !ends.exit) seen.push(ends);
    ends[event] = event === 'exit' ? `exit ${code} ${signal}` : event;
  };
  cp.on('message', (m) => seen.push(`message ${json(m)}`));
  cp.on('disconnect', end('disconnect'));
  cp.on('exit', end('exit'));
  return new Promise((resolve) =>
    cp.on('close', (code, signal) =>
      setImmediate(() => {
        const line = seen.map((s) => (s === ends ? [ends.disconnect, ends.exit].filter(Boolean).join(' | ') : s));
        log(label, [...line, `close ${code} ${signal}`].join(' | '));
        resolve();
      })
    )
  );
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('echo json', async () => {
  const cp = fork(child, ['echo']);
  const done = events(cp, 'echo json:');
  log('send returns', cp.send({ a: 1, s: 'xé€😀' }), cp.connected, typeof cp.channel);
  cp.send([1, 'two', null, true]);
  cp.send('a string');
  cp.send(42);
  cp.send(false);
  cp.send('bye', (e) => log('send callback', e));
  await done;
  log('after close', cp.connected, cp.channel);
});

test('echo advanced', async () => {
  const cp = fork(child, ['echo'], { serialization: 'advanced' });
  const done = events(cp, 'echo advanced:');
  cp.send(new Map([[1, 2]]));
  cp.send(new Date(0));
  cp.send(new Uint8Array([1, 2]));
  cp.send({ big: 10n });
  try {
    cp.send(10n);
  } catch (e) {
    log('top-level bigint', err(e));
  }
  cp.send('bye');
  await done;
});

test('child info', async () => {
  const cp = fork(child, ['info', 'x', 'y'], { execArgv: ['--no-warnings'] });
  await events(cp, 'child info:');
  const cp2 = fork(child, ['info'], { serialization: 'advanced' });
  await events(cp2, 'child info advanced:');
});

test('advanced values', async () => {
  const cp = fork(child, ['advanced'], { serialization: 'advanced' });
  const done = events(cp, 'advanced values:');
  const circular = { name: 'c' };
  circular.self = circular;
  cp.send({
    map: new Map([['k', { v: 1 }]]),
    set: new Set([1, 'a']),
    date: new Date(86400000),
    big: 2n ** 70n,
    buf: Buffer.from('hi'),
    u16: new Uint16Array([1, 65535]),
    err: new RangeError('bad', { cause: 'why' }),
    circular,
    arr: [1, , undefined],
    u: undefined,
  });
  await done;
});

test('json is lossy', async () => {
  const cp = fork(child, ['json-lossy']);
  const done = events(cp, 'json lossy:');
  cp.send({ map: new Map([[1, 2]]), date: new Date(0), u: undefined, nan: NaN, nested: { toJSON: () => 'custom' } });
  await done;
});

test('internal messages', async () => {
  const cp = fork(child, ['internal']);
  cp.on('internalMessage', (m) => log('internalMessage', json(m)));
  await events(cp, 'internal:');
});

test('many messages in order', async () => {
  const cp = fork(child, ['many']);
  const done = events(cp, 'many:');
  for (let i = 0; i < 2000; i++) cp.send({ i, pad: 'p'.repeat(i % 50) });
  cp.send('done');
  await done;
});

test('big messages', async () => {
  for (const serialization of ['json', 'advanced']) {
    const cp = fork(child, ['big'], { serialization });
    let back;
    cp.on('message', (m) => {
      back = m;
    });
    const closed = new Promise((r) => cp.on('close', r));
    cp.send('x'.repeat(1000000));
    await closed;
    log('big', serialization, back.length, back.head, back.back.length);
  }
});

test('parent disconnects first', async () => {
  const cp = fork(child, ['stay']);
  const seen = [];
  cp.on('exit', (c, s) => {
    seen.push(`exit ${c} ${s}`);
    log('parent disconnects first:', seen.join(' | '), 'connected', cp.connected);
  });
  cp.on('close', () => log('close (not expected)'));
  await new Promise((r) => cp.once('message', r));
  cp.on('disconnect', () => seen.push('disconnect'));
  cp.disconnect();
  seen.push(`after disconnect() connected=${cp.connected} channel=${cp.channel}`);
  await new Promise((r) => cp.on('exit', r));
});

test('send after disconnect', async () => {
  const cp = fork(child, ['stay'], { silent: true });
  let out = '';
  cp.stdout.on('data', (d) => (out += d));
  const done = Promise.all([new Promise((r) => cp.stdout.on('end', r)), new Promise((r) => cp.on('exit', r))]);
  await new Promise((r) => cp.once('message', r));
  cp.disconnect();
  log('send returns', cp.send('late', (e) => log('callback:', err(e))));
  cp.once('error', (e) => log('error event:', err(e)));
  cp.send('later');
  await new Promise((r) => cp.once('error', r));
  cp.once('error', (e) => log('second disconnect:', err(e)));
  cp.disconnect();
  await done;
  process.stdout.write(out);
});

test('a channel without listeners lets the child end', async () => {
  const cp = fork(child, ['no-listener']);
  await events(cp, 'no listener:');
});

test('a child that sends and exits at once', async () => {
  for (const serialization of ['json', 'advanced']) await events(fork(child, ['send-exit'], { serialization }), `send then exit (${serialization}):`);
});

test('exit code and kill', async () => {
  const cp = fork(child, ['exit-code']);
  await events(cp, 'exit code:');
  const k = fork(child, ['wait-kill']);
  const done = events(k, 'killed:');
  await new Promise((r) => k.once('message', r));
  k.kill();
  await done;
});

test('silent', async () => {
  const cp = fork(child, ['silent'], { silent: true });
  let out = '';
  let errOut = '';
  cp.stdout.on('data', (d) => (out += d));
  cp.stderr.on('data', (d) => (errOut += d));
  await events(cp, 'silent:');
  log('silent stdio', json(out), json(errOut), cp.stdio.length);
});

test('spawn with ipc', async () => {
  const cp = spawn(process.execPath, [child, 'info'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  await events(cp, 'spawn ipc 3:');
  const cp4 = spawn(process.execPath, [child, 'info'], { stdio: ['ignore', 'inherit', 'inherit', 'ignore', 'ipc'] });
  await events(cp4, 'spawn ipc 4:');
  const cps = fork(child, ['info'], { stdio: 'pipe' });
  await events(cps, 'fork stdio pipe:');
});

test('v8 in the child', async () => {
  await events(fork(child, ['serializer'], { serialization: 'advanced' }), 'serializer:');
});

test('errors', async () => {
  const tries = {
    'fork without ipc': () => fork(child, [], { stdio: ['pipe', 'pipe', 'pipe'] }),
    'two ipc': () => spawn(process.execPath, [child], { stdio: ['pipe', 'pipe', 'pipe', 'ipc', 'ipc'] }),
    'bad serialization': () => fork(child, [], { serialization: 'yaml' }),
    'spawnSync ipc': () => spawnSync(process.execPath, [child], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }),
    'bad modulePath': () => fork(42),
    'bad args': () => fork(child, 'x'),
    'bad stdio string': () => fork(child, [], { stdio: 'bogus' }),
  };
  for (const [label, fn] of Object.entries(tries)) {
    try {
      const cp = fn();
      log(label, 'no throw', typeof cp);
    } catch (e) {
      log(label, err(e));
    }
  }
  const cp = fork(child, ['stay']);
  await new Promise((r) => cp.once('message', r));
  for (const [label, message] of [
    ['undefined', undefined],
    ['symbol', Symbol('s')],
    ['function', () => {}],
  ]) {
    try {
      cp.send(message);
      log('send', label, 'no throw');
    } catch (e) {
      log('send', label, err(e));
    }
  }
  try {
    cp.send({ big: 1n });
  } catch (e) {
    log('json bigint', err(e));
  }
  cp.disconnect();
  await new Promise((r) => cp.on('exit', r));
  const adv = fork(child, ['stay'], { serialization: 'advanced' });
  await new Promise((r) => adv.once('message', r));
  try {
    adv.send({ f() {} });
  } catch (e) {
    log('advanced function', err(e));
  }
  adv.disconnect();
  await new Promise((r) => adv.on('exit', r));
});

test('no channel here', async () => {
  log('process.send', typeof process.send, 'connected', process.connected, 'channel', process.channel);
});

(async () => {
  for (const [name, fn] of cases) {
    log(`--- ${name}`);
    await fn();
  }
})();
