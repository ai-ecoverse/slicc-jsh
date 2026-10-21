const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const als = new AsyncLocalStorage();
const other = new AsyncLocalStorage();
const log = [];
const note = (label) => log.push(`${label}: ${JSON.stringify(als.getStore())}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timerStep(next) {
  als.run('timer', () => {
    setTimeout(() => {
      note('timer');
      als.enterWith('timer enterWith');
      note('timer after enterWith');
      setTimeout(() => {
        note('timer > timer after enterWith');
        next();
      }, 1);
    }, 1);
  });
  setTimeout(() => note('timer outside, after the enterWith one'), 3);
}

function netStep(next) {
  const server = als.run('net listen', () =>
    net.createServer((socket) => {
      note('net connection');
      socket.on('data', (chunk) => {
        note(`net server data ${chunk}`);
        socket.end('pong');
      });
    })
  );
  als.run('net listen', () =>
    server.listen(0, '127.0.0.1', () => {
      note('net listening');
      const client = als.run('net client', () =>
        net.connect(server.address().port, '127.0.0.1', () => {
          note('net connect');
          client.write('ping');
        })
      );
      client.on('data', (chunk) => {
        note(`net client data ${chunk}`);
        als.enterWith('net data enterWith');
        note('net client data after enterWith');
        setTimeout(() => note('net client data > timer after enterWith'), 1);
        process.nextTick(() => note('net client data > nextTick after enterWith'));
      });
      client.on('end', () => note('net client end'));
      client.on('close', () => {
        note('net client close');
        server.close(next);
      });
    })
  );
}

function httpStep(next) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const server = als.run('http create', () =>
    http.createServer((req, res) => {
      note(`http request ${req.url}`);
      als.enterWith(`http request ${req.url} enterWith`);
      note(`http request ${req.url} after enterWith`);
      setTimeout(() => {
        note(`http request ${req.url} > timer after enterWith`);
        res.end('ok');
      }, 1);
      req.on('data', () => note(`http request ${req.url} data`));
      req.on('end', () => note(`http request ${req.url} end`));
    })
  );
  const get = (id, then) =>
    als.run(id, () => {
      const req = http.request({ port: server.address().port, host: '127.0.0.1', path: `/${id}`, method: 'POST', agent }, (res) => {
        note(`http response ${id}`);
        res.on('data', () => note(`http response ${id} data`));
        res.on('end', () => {
          note(`http response ${id} end`);
          then();
        });
      });
      req.end('body');
    });
  als.run('http listen', () =>
    server.listen(0, '127.0.0.1', () => {
      note('http listening');
      get('one', () =>
        get('two', () => {
          agent.destroy();
          server.close(next);
        })
      );
    })
  );
}

function childStep(next) {
  als.run('child', () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("out")']);
    child.stdout.on('data', (chunk) => note(`child stdout data ${chunk}`));
    child.stdout.on('end', () => note('child stdout end'));
    child.on('close', () => {
      note('child close');
      next();
    });
  });
}

async function nested(label) {
  await null;
  note(`${label} nested after await null`);
  await sleep(1);
  note(`${label} nested after await sleep`);
  return label;
}

async function awaitStep() {
  await als.run('await', async () => {
    note('await before');
    await sleep(2);
    note('await after sleep');
    await null;
    note('await after await null');
    await nested('await');
    note('await after nested');
    await { then: (resolve) => setTimeout(resolve, 1) };
    note('await after thenable');
    await Promise.resolve().then(() => note('await then')).then(() => note('await then then'));
    note('await after then chain');
    sleep(1).then(async () => {
      note('await then registered after await');
      await null;
      note('await then registered after await > await');
    });
    queueMicrotask(() => note('await queueMicrotask after await'));
    setTimeout(() => note('await setTimeout after await'), 1);
    setImmediate(() => note('await setImmediate after await'));
    process.nextTick(() => note('await nextTick after await'));
    const data = await fs.promises.readFile(__filename, 'utf8');
    note(`await after fs.promises.readFile ${data.length > 0}`);
    await new Promise((resolve) => fs.readFile(__filename, () => {
      note('await fs.readFile callback');
      resolve();
    }));
    note('await after fs.readFile callback');
    for await (const x of (async function* () {
      yield 1;
      await sleep(1);
      note('await async generator after await');
      yield 2;
    })()) note(`await for await ${x}`);
    await other.run('other', async () => {
      await null;
      note(`await other.run after await (other ${JSON.stringify(other.getStore())})`);
    });
    note(`await after other.run (other ${JSON.stringify(other.getStore())})`);
    await als.exit(async () => {
      await null;
      note('await exit after await');
    });
    note('await after exit');
    await sleep(5);
  });
  note('await outside, after the run');
}

async function enterWithStep() {
  await als.run('enterWith', async () => {
    await null;
    als.enterWith('enterWith after await');
    note('enterWith after await');
    await sleep(1);
    note('enterWith after await > await');
    setTimeout(() => note('enterWith after await > timer'), 1);
    await sleep(3);
  });
  note('enterWith outside, after the run');
  await (async () => {
    await null;
    als.enterWith('enterWith in an async function');
    await null;
    note('enterWith in an async function > await');
  })();
  note('enterWith outside, after the async function');
  als.run(undefined, () => {});
  setTimeout(() => note('enterWith outside > timer'), 1);
  await sleep(3);
}

async function concurrentStep() {
  const request = (id, first, second) =>
    als.run(id, async () => {
      note(`concurrent ${id} before await`);
      sleep(second).then(() => note(`concurrent ${id} then in run`));
      await sleep(first);
      note(`concurrent ${id} after await`);
      await null;
      note(`concurrent ${id} after await null`);
      await sleep(second);
      als.enterWith(`${id} entered`);
      await sleep(first);
      note(`concurrent ${id} after enterWith > await`);
    });
  await Promise.all([request('A', 5, 1), request('B', 1, 8), request('C', 3, 3)]);
  note('concurrent outside, after Promise.all');
}

async function ioStep() {
  const server = http.createServer(async (req, res) => {
    await als.run(`http ${req.url}`, async () => {
      await sleep(req.url === '/a' ? 5 : 1);
      note(`io http ${req.url} after await`);
      for await (const chunk of req) note(`io http ${req.url} body ${chunk}`);
      note(`io http ${req.url} after body`);
      res.end(req.url);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (path) =>
    als.run(`client ${path}`, async () => {
      const body = await new Promise((resolve, reject) => {
        const req = http.request({ port: server.address().port, host: '127.0.0.1', path, method: 'POST', agent: false }, (res) => {
          note(`io client ${path} response`);
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end(path);
      });
      note(`io client ${path} after await response ${body}`);
    });
  await Promise.all([get('/a'), get('/b')]);
  await new Promise((resolve) => server.close(resolve));
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  await als.run('net', async () => {
    const socket = net.connect(echo.address().port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    note('io net after await connect');
    socket.write('x');
    await new Promise((resolve) => socket.once('data', resolve));
    note('io net after await data');
    socket.end();
    await new Promise((resolve) => socket.once('close', resolve));
    note('io net after await close');
  });
  await new Promise((resolve) => echo.close(resolve));
}

async function moreAwaitStep() {
  const early = sleep(3);
  await als.run('more', async () => {
    await early;
    note('more awaited a promise made outside the run');
    let n = 0;
    await new Promise((resolve) => {
      const id = setInterval(async () => {
        await null;
        note(`more interval ${n} after await`);
        if (++n === 2) {
          clearInterval(id);
          resolve();
        }
      }, 1);
    });
    const bound = AsyncResource.bind(() => note('more AsyncResource.bind after await'));
    als.run('more inner', bound);
    als.exit(() => {
      note('more exit');
      setTimeout(() => note('more exit > timer'), 1);
      Promise.resolve().then(() => note('more exit > then'));
    });
    try {
      await als.run('more throws', async () => {
        await null;
        throw new Error('boom');
      });
    } catch {
      note('more catch after a throwing run');
    }
    await sleep(3);
  });
  const made = als.run('more made in a run', () => sleep(1));
  await made.then(() => note('more then registered outside on a promise made in a run'));
}

timerStep(() =>
  netStep(() =>
    httpStep(() =>
      childStep(() =>
        als.run(undefined, async () => {
          await awaitStep();
          await enterWithStep();
          await concurrentStep();
          await ioStep();
          await moreAwaitStep();
          note('end');
        })
      )
    )
  )
);
process.once('beforeExit', () => {
  for (const line of [...log].sort()) console.log(line);
});
