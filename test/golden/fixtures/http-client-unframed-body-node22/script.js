const http = require('http');
const net = require('net');
const show = (got) => {
  const at = got.indexOf('\r\n\r\n');
  const head = (at < 0 ? got : got.slice(0, at)).split('\r\n').filter((l) => !/^Host:/i.test(l)).join('|');
  return `${JSON.stringify(head)} body ${JSON.stringify(at < 0 ? '' : got.slice(at + 4))}`;
};
let pending = null;
const srv = net.createServer((s) => {
  const row = pending;
  let got = '';
  s.on('data', (d) => {
    got += d;
    row.wire = got;
    const end = got.indexOf('\r\n\r\n');
    if (end < 0 || !got.slice(end + 4).endsWith(row.want) || row.settling) return;
    row.settling = setTimeout(() => {
      row.ev.push(`server ${show(got)}`);
      s.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    }, 20);
  });
});
const row = (label, opts, want, drive) => new Promise((resolve) => {
  const ev = [];
  pending = { want, ev, wire: '' };
  let ended = false;
  let done = false;
  let t;
  const finish = (line) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    console.log(`${label} | ${line}`);
    resolve();
  };
  const end = (why) => {
    if (ended) return;
    ended = true;
    ev.push(`end() ${why}`);
    if (drive.last !== undefined) req.end(drive.last);
    else req.end();
  };
  const wait = () => {
    t = setTimeout(() => {
      if (!ended) {
        end('after 5 s');
        return wait();
      }
      finish(`${ev.join(', ')}, no response after 5 s, server has ${show(pending.wire)}`);
      req.destroy();
    }, 5000);
  };
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, agent: false, ...opts }, (res) => {
    ev.push(`response ${res.statusCode}`);
    end('on the response');
    res.resume();
    res.on('end', () => finish(ev.join(', ')));
  });
  req.on('error', (e) => finish(`${ev.join(', ')}, error ${e.code}`));
  wait();
  const go = () => {
    for (const w of drive.writes) req.write(w);
    if (drive.endAtOnce) end('at once');
  };
  if (drive.afterConnect) req.on('socket', (s) => s.once('connect', () => setImmediate(go)));
  else go();
});
srv.listen(0, '127.0.0.1', async () => {
  await row('DELETE, a write', { method: 'DELETE' }, 'hello', { writes: ['hello'] });
  await row('GET, two writes', { method: 'GET' }, 'hello', { writes: ['he', 'llo'] });
  await row('OPTIONS, a write after the connect', { method: 'OPTIONS' }, 'hello', { writes: ['hello'], afterConnect: true });
  await row('POST, Transfer-Encoding identity, two writes', { method: 'POST', headers: { 'Transfer-Encoding': 'identity' } }, 'hello', { writes: ['hel', 'lo'] });
  await row('PUT, Transfer-Encoding gzip, a write', { method: 'PUT', headers: { 'Transfer-Encoding': 'gzip' } }, 'hello', { writes: ['hello'] });
  await row('GET, end(data) alone', { method: 'GET' }, 'hello', { writes: [], last: 'hello', endAtOnce: true });
  await row('DELETE, a write, then end(data)', { method: 'DELETE' }, 'hello', { writes: ['hel'], last: 'lo', endAtOnce: true });
  await row('POST, Transfer-Encoding identity, end(data) alone', { method: 'POST', headers: { 'Transfer-Encoding': 'identity' } }, 'hello', { writes: [], last: 'hello', endAtOnce: true });
  await row('PUT, Transfer-Encoding identity, end() alone', { method: 'PUT', headers: { 'Transfer-Encoding': 'identity' } }, '', { writes: [], endAtOnce: true });
  await row('POST, Transfer-Encoding chunked, end(data) alone', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, '0\r\n\r\n', { writes: [], last: 'hello', endAtOnce: true });
  await row('POST, Transfer-Encoding chunked, end() alone', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, '0\r\n\r\n', { writes: [], endAtOnce: true });
  await row('POST, Transfer-Encoding chunked, end(data) after the connect', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, '0\r\n\r\n', { writes: [], last: 'hello', endAtOnce: true, afterConnect: true });
  await row('PUT, Content-Length, end(data) after the connect', { method: 'PUT', headers: { 'Content-Length': 5 } }, 'hello', { writes: [], last: 'hello', endAtOnce: true, afterConnect: true });
  await row('DELETE, end(data) after the connect', { method: 'DELETE' }, 'hello', { writes: [], last: 'hello', endAtOnce: true, afterConnect: true });
  await row('POST, Transfer-Encoding gzip, end(data) alone', { method: 'POST', headers: { 'Transfer-Encoding': 'gzip' } }, 'hello', { writes: [], last: 'hello', endAtOnce: true });
  srv.close();
});
