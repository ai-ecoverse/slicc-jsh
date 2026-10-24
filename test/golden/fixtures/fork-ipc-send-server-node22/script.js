const { fork } = require('child_process');
const net = require('net');
const http = require('http');

if (process.send) {
  const express = require('express');
  process.on('message', (m, handle) => {
    if (m === 'net server') {
      process.send(`child got a ${handle.constructor.name}: net.Server ${handle instanceof net.Server}, listening ${handle.listening}, port ${typeof handle.address().port}`);
      handle.once('connection', (socket) => {
        socket.end(`the child accepted ${socket.remoteAddress}\n`);
        handle.close(() => process.send('the child closed its net server'));
      });
      process.send('net ready');
    } else if (m === 'express') {
      const app = express();
      app.get('/hello/:name', (req, res) => res.json({ from: 'child', name: req.params.name }));
      const server = app.listen(handle, () => {
        process.send(`express listening ${server.listening}, on the passed port ${server.address().port === handle.address().port}`);
        process.send('express ready');
      });
      process.once('disconnect', () => server.close());
    } else if (m === 'back') {
      const own = net.createServer((socket) => socket.end('the child made this server\n'));
      own.listen(0, '127.0.0.1', () => {
        process.send('from the child', own, (err) => {
          process.send(`the child's send callback ${err}`);
          own.close();
        });
      });
    }
  });
  return;
}

const out = [];
const cp = fork(__filename);
const next = (what) => new Promise((resolve) => {
  const on = (m, handle) => {
    if (m === what) {
      cp.off('message', on);
      resolve(handle);
    } else out.push(`parent got: ${m}`);
  };
  cp.on('message', on);
});
const listen = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const read = (port) => new Promise((resolve) => {
  let data = '';
  net.connect(port, '127.0.0.1').on('data', (d) => (data += d)).on('end', () => resolve(data.trim()));
});
const get = (port, path) => new Promise((resolve) => {
  http.get({ port, host: '127.0.0.1', path, agent: false }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve(`${res.statusCode} ${res.headers['content-type']} ${body}`));
  });
});

(async () => {
  const one = await listen();
  const port = one.address().port;
  out.push(`send ${cp.send('net server', one, (err) => out.push(`send callback ${err}`))}`);
  await next('net ready');
  one.close(() => out.push('the parent closed its copy'));
  out.push(`the parent's copy is listening ${one.listening}`);
  out.push(`client read: ${(await read(port)).replace(/\d+\.\d+\.\d+\.\d+/, 'an address')}`);
  await next('the child closed its net server');
  out.push('the child closed its net server');

  const two = await listen();
  const expressPort = two.address().port;
  cp.send('express', two);
  await next('express ready');
  two.close();
  out.push(`express: ${await get(expressPort, '/hello/node')}`);

  cp.send('back');
  const back = await next('from the child');
  out.push(`the parent got a ${back.constructor.name}, listening ${back.listening}`);
  back.once('connection', (socket) => {
    socket.end('the parent accepted on the child\'s server\n');
    back.close();
  });
  out.push(`client read: ${await read(back.address().port)}`);
  out.push(`then: ${await new Promise((resolve) => cp.once('message', resolve))}`);

  cp.disconnect();
  cp.on('exit', (code) => {
    out.push(`child exit ${code}`);
    for (const line of out) console.log(line);
  });
})();
