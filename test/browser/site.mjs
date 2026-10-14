/**
 * The site the browser suite drives: a local HTTP + WebSocket server on
 * 127.0.0.1, opened as http://localhost:<port>/ (another origin than the
 * harness's 127.0.0.1 page, so `ensureTab`'s origin match never picks the
 * kernel's own tab). Fixed, credential-free values only.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export const COOKIE = 'jsh-session-42';
export const STORED = 'stored-token-42';

const app = `<!doctype html>
<meta charset="utf-8">
<title>jsh browser site</title>
<h1>jsh browser site</h1>
<script>
  localStorage.setItem('jsh-token', ${JSON.stringify(STORED)});
  window.marker = 6 * 7;
  window.openFeed = (n) => {
    const ws = new WebSocket('ws://' + location.host + '/feed?n=' + n);
    ws.onopen = () => ws.send('subscribe');
    ws.onmessage = () => {};
    return 'opened';
  };
</script>
`;

export async function startSite() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    hits.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/app' || url.pathname === '/other') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `jsh_sid=${COOKIE}; Path=/; SameSite=Lax`,
      });
      return res.end(app.replace('jsh browser site</title>', `jsh browser site ${url.pathname}</title>`));
    }
    if (url.pathname === '/api/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-jsh': 'yes' });
        res.end(
          JSON.stringify({
            method: req.method,
            cookie: req.headers.cookie ?? null,
            header: req.headers['x-test'] ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      });
      return;
    }
    if (url.pathname === '/api/text') {
      res.writeHead(201, { 'content-type': 'text/plain' });
      return res.end('plain text 42');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  const wss = new WebSocketServer({ server, path: '/feed' });
  wss.on('connection', (ws, req) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') ?? 3);
    let i = 0;
    let tick;
    ws.once('message', () => {
     tick = setInterval(() => {
      i += 1;
      ws.send(JSON.stringify({ type: i % 2 ? 'odd' : 'even', seq: i }));
      if (i >= n) {
        clearInterval(tick);
        ws.close();
      }
     }, 50);
    });
    ws.on('close', () => clearInterval(tick));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://localhost:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
