const { AsyncLocalStorage } = require('async_hooks');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const als = new AsyncLocalStorage();
const log = [];
const note = (label) => log.push(`${label}: ${JSON.stringify(als.getStore())}`);

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

timerStep(() => netStep(() => httpStep(() => childStep(() => {}))));
process.once('beforeExit', () => {
  for (const line of [...log].sort()) console.log(line);
});
