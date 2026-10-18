// Responses stream, as Node's: a server's write() before end() sends the
// head and each chunk as they come (chunked), the client (http.get, fetch)
// gets the head at once and the body as it arrives; an SSE stream that
// never ends is read event by event and aborted; the server sees the client
// go ('close'); a POST answered with a stream; a body cut short is 'aborted'.
const http = require('http');
// /slow ends only when the client says so, once it has the head and the
// first chunk: 'early' is before the server's end(), whatever the load.
let endSlow = null;
let slowEnded = false;
const when = () => (slowEnded ? 'late' : 'early');
// The server's 'close' for the SSE response, which the client waits for
// after its abort.
let sseGone;
const sseClosed = new Promise((resolve) => (sseGone = resolve));
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first;');
      slowEnded = false;
      endSlow = () => {
        slowEnded = true;
        res.end('last');
      };
      return;
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      // Three events, then the stream stays open and quiet. A 4th sent while
      // the client is about to abort can be read after the abort, in Node
      // too (its chunk is already in the TextDecoderStream), which made the
      // `read after abort` line come and go under load (#241).
      let n = 0;
      const tick = setInterval(() => {
        res.write(`id: ${++n}\ndata: event ${n}\n\n`);
        if (n === 3) clearInterval(tick);
      }, 20);
      // (A request's own 'close' is its body's end: the response's tells the client went.)
      res.on('close', () => {
        clearInterval(tick);
        console.log('server: the SSE client went away');
        sseGone();
      });
      return;
    }
    if (req.url === '/echo-stream' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let i = 0;
      const next = () => {
        if (i === 3) return res.end();
        res.write(`${JSON.stringify({ i: i++, got: body })}\n`);
        setTimeout(next, 20);
      };
      next();
      return;
    }
    if (req.url === '/headers-after-write') {
      res.write('x');
      for (const [label, fn] of [
        ['setHeader', () => res.setHeader('x-late', '1')],
        ['removeHeader', () => res.removeHeader('content-type')],
        ['writeHead', () => res.writeHead(201)],
        ['flushHeaders', () => res.flushHeaders()],
      ]) {
        try {
          console.log('server:', label, fn() === res ? 'res' : fn());
        } catch (e) {
          console.log('server:', label, e.code, e.message);
        }
      }
      res.end();
      return;
    }
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-length': '100' });
      res.write('only part');
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    res.end('plain');
  });
});
srv.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  await new Promise((resolve) =>
    http.get(`${base}/slow`, (r) => {
      console.log('http.get: response', when(), r.headers['transfer-encoding']);
      r.setEncoding('utf8');
      r.on('data', (d) => {
        console.log('http.get: data', JSON.stringify(d), when());
        if (!slowEnded) endSlow();
      });
      r.on('end', resolve);
    })
  );
  const slow = await fetch(`${base}/slow`);
  console.log('fetch: headers', slow.status);
  endSlow();
  console.log('fetch: body', JSON.stringify(await slow.text()));
  // An EventSource-style client: fetch and a reader loop.
  const ac = new AbortController();
  const sse = await fetch(`${base}/sse`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
  console.log('sse: headers', sse.status, sse.headers.get('content-type'));
  const reader = sse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const events = [];
  while (events.length < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0 && events.length < 3) {
      events.push(buf.slice(0, i).replace(/\n/g, ' | '));
      buf = buf.slice(i + 2);
    }
  }
  console.log('sse: events', JSON.stringify(events));
  ac.abort();
  try {
    await reader.read();
  } catch (e) {
    console.log('sse: read after abort', e.name);
  }
  await sseClosed;
  const post = await fetch(`${base}/echo-stream`, { method: 'POST', body: 'hello' });
  console.log('post: headers', post.status, post.headers.get('content-type'));
  for await (const chunk of post.body.pipeThrough(new TextDecoderStream())) {
    for (const line of chunk.split('\n').filter(Boolean)) console.log('post: line', line);
  }
  await (await fetch(`${base}/headers-after-write`)).text();
  const cut = await fetch(`${base}/cut`);
  try {
    await cut.text();
  } catch (e) {
    console.log('cut: fetch body', e.name, e.message, e.cause?.code);
  }
  await new Promise((resolve) =>
    http.get(`${base}/cut`, (r) => {
      r.on('aborted', () => console.log('cut: http.get aborted'));
      r.on('error', (e) => console.log('cut: http.get error', e.code, e.message));
      r.on('close', resolve);
      r.resume();
    })
  );
  srv.close();
});
