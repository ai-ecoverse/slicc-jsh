const http = require('http');
const net = require('net');
const rawServer = (onBytes) => new Promise((resolve) => {
  const s = net.createServer((sock) => {
    let parts = [];
    sock.on('data', (d) => { parts.push(d); onBytes(Buffer.concat(parts).toString('latin1'), sock, s); });
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const shown = (t) => JSON.stringify(t.split('\r\n').filter((l) => !/^(Host|Connection):/i.test(l)).join('|'));
(async () => {
  {
    const s = await rawServer((text, sock) => {
      if (!text.includes('0\r\n\r\n')) return;
      console.log('flushHeaders, then writes with no length:', shown(text));
      sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', agent: false }, (res) => { res.resume(); res.on('end', resolve); });
      req.flushHeaders();
      req.write('ab');
      req.write('cde');
      req.end();
    });
    s.close();
  }
  {
    const s = await rawServer((text, sock) => {
      if (!text.includes('\r\n\r\n')) return;
      console.log('GET after flushHeaders:', shown(text));
      sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, agent: false }, (res) => { res.resume(); res.on('end', resolve); });
      req.flushHeaders();
      req.end();
    });
    s.close();
  }
  {
    let firstChunk;
    const seen = new Promise((resolve) => (firstChunk = resolve));
    const s = await rawServer((text, sock) => {
      if (text.includes('\r\n\r\n2\r\nab\r\n')) firstChunk('the first chunk came before end()');
      if (!text.includes('0\r\n\r\n')) return;
      console.log('array headers, no length, two writes:', shown(text));
      sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', agent: false, headers: ['Host', 'x', 'x-a', '1'] }, (res) => { res.resume(); res.on('end', resolve); });
      req.write('ab');
      const bound = setTimeout(() => firstChunk('no chunk 5 s after the first write'), 5000);
      seen.then((what) => {
        clearTimeout(bound);
        console.log('array headers, no length:', what);
        req.end('cd');
      });
    });
    s.close();
  }
  for (const [label, send] of [
    ['write(), then end() in one tick', (req) => { req.write('ab'); req.end('cd'); }],
    ['end(data) alone', (req) => req.end('abcd')],
    ['object headers, a write, then end() once the server has it', (req, seen) => { req.write('ab'); seen.then(() => req.end('cd')); }],
  ]) {
    let firstChunk;
    const seen = new Promise((resolve) => (firstChunk = resolve));
    const s = await rawServer((text, sock) => {
      if (text.includes('\r\n\r\n2\r\nab\r\n')) firstChunk();
      if (!text.includes('0\r\n\r\n') && !text.includes('abcd')) return;
      console.log(label + ':', shown(text));
      sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', agent: false, headers: { 'x-a': '1' } }, (res) => { res.resume(); res.on('end', resolve); });
      const bound = setTimeout(() => {
        console.log(label + ': no chunk 5 s after the first write');
        firstChunk();
      }, 5000);
      seen.then(() => clearTimeout(bound));
      send(req, seen);
      if (label === 'end(data) alone' || label.startsWith('write(), then')) clearTimeout(bound);
    });
    s.close();
  }
  {
    const s = await rawServer((text, sock) => {
      if (!text.includes('0\r\n\r\n')) return;
      console.log('array headers with Transfer-Encoding chunked:', shown(text));
      sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', agent: false, headers: ['Host', 'x', 'Transfer-Encoding', 'chunked'] }, (res) => { res.resume(); res.on('end', resolve); });
      req.write('ab');
      req.end('cd');
    });
    s.close();
  }
})();
