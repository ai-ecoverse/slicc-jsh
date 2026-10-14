/**
 * A WebSocket client to a server of this kernel (RFC 6455 over a kernel
 * socket), for `new WebSocket('ws://127.0.0.1:…')` and the other loopback
 * names: `ctx.websocket` goes to the kernel's transport, the platform's
 * network, never to the kernel's own listeners (the CDP facade on 9222, a
 * `ws` server of another program). Node's WebSocket on a machine reaches
 * that machine's loopback; in the kernel, that's the kernel's.
 *
 * It answers with the shape of `ctx.websocket`'s socket (WebSocketStream
 * -like): `url`, `protocol`, `readable` (strings for text, Uint8Arrays for
 * binary), `writable` (a string goes as text, bytes as binary), `closed`
 * (`{ code, reason, wasClean }`) and `close({ code, reason })`.
 */
import { dialLoopback, readHead, writeHead } from './loopback.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
const MAX_MESSAGE = 64 * 1024 * 1024;
const CLOSE_WAIT_MS = 5000;

const encoder = new TextEncoder();

function failed(cause) {
  return Object.assign(new TypeError('websocket failed'), { cause });
}

function errno(code, message) {
  return Object.assign(new Error(message), { code });
}

function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function acceptFor(key) {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(key + GUID));
  return base64(new Uint8Array(digest));
}

function header(rawHeaders, name) {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) return rawHeaders[i + 1];
  }
  return undefined;
}

/** One client frame: FIN set, masked, as RFC 6455 has a client send it. */
function frame(opcode, payload) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + extra + 4 + length);
  out[0] = 0x80 | opcode;
  if (extra === 0) out[1] = 0x80 | length;
  else if (extra === 2) {
    out[1] = 0x80 | 126;
    out[2] = length >> 8;
    out[3] = length & 0xff;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(length));
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, 2 + extra);
  const at = 2 + extra + 4;
  for (let i = 0; i < length; i++) out[at + i] = payload[i] ^ mask[i & 3];
  return out;
}

function closePayload(code, reason) {
  if (code === undefined) return new Uint8Array(0);
  const text = encoder.encode(reason ?? '');
  const out = new Uint8Array(2 + text.length);
  out[0] = code >> 8;
  out[1] = code & 0xff;
  out.set(text, 2);
  return out;
}

/**
 * Open `href` (a `ws:` URL) on the kernel's `route` ({ host, port }) through
 * node:net `net`. Rejects as `ctx.websocket` does: a TypeError whose `cause`
 * has the errno (`ECONNREFUSED`, `EPROTO` for a refused upgrade).
 */
export async function openLoopbackWebSocket(net, href, protocols, route) {
  const url = new URL(href);
  const offered = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
  let socket;
  try {
    socket = await dialLoopback(net, route);
  } catch (err) {
    throw failed(err);
  }
  const key = base64(crypto.getRandomValues(new Uint8Array(16)));
  const headers = [
    ['host', url.host],
    ['connection', 'upgrade'],
    ['upgrade', 'websocket'],
    ['sec-websocket-key', key],
    ['sec-websocket-version', '13'],
  ];
  if (offered.length) headers.push(['sec-websocket-protocol', offered.join(', ')]);
  let head;
  try {
    writeHead(socket, { method: 'GET', path: `${url.pathname}${url.search}`, headers });
    head = await readHead(socket);
  } catch (err) {
    socket.destroy();
    throw failed(err);
  }
  const refuse = (message) => {
    socket.destroy();
    throw failed(errno('EPROTO', message));
  };
  if (head.status !== 101) refuse(`the server answered the upgrade with ${head.status}`);
  if (header(head.rawHeaders, 'upgrade')?.toLowerCase() !== 'websocket') refuse('no Upgrade: websocket');
  const connection = (header(head.rawHeaders, 'connection') ?? '').toLowerCase().split(',');
  if (!connection.some((token) => token.trim() === 'upgrade')) refuse('no Connection: upgrade');
  if (header(head.rawHeaders, 'sec-websocket-extensions')) refuse('the far end chose an extension the program did not offer');
  if (header(head.rawHeaders, 'sec-websocket-accept') !== (await acceptFor(key))) {
    refuse('wrong Sec-WebSocket-Accept');
  }
  const protocol = header(head.rawHeaders, 'sec-websocket-protocol') ?? '';
  if (protocol && !offered.includes(protocol)) refuse('the far end chose a subprotocol the program did not offer');
  return connected(socket, url.href, protocol, head.rest);
}

function connected(socket, href, protocol, rest) {
  let readable;
  let reading;
  let closing = false; // our close frame went out
  let ended = false;
  let peerClose = null; // the server's close frame, once it came
  let closeTimer;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const finish = (code, reason, wasClean) => {
    if (ended) return;
    ended = true;
    clearTimeout(closeTimer);
    socket.destroy();
    try {
      reading.close();
    } catch {
      /* already closed */
    }
    resolveClosed({ code, reason, wasClean });
  };
  const send = (opcode, payload, written) => {
    if (socket.destroyed) written?.();
    else socket.write(frame(opcode, payload), written);
  };
  const close = (code, reason) => {
    if (closing || ended) return;
    closing = true;
    send(OP.close, closePayload(code, reason));
    closeTimer = setTimeout(() => finish(1006, '', false), CLOSE_WAIT_MS);
    closeTimer.unref?.();
  };

  let buffered = rest;
  let message = null; // { opcode, parts, size }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // Failing the connection: our close frame, then a 1006 close, as undici reports it.
  const protocolError = (code, reason) => {
    close(code, reason);
    finish(1006, '', false);
  };
  const parse = () => {
    for (;;) {
      if (peerClose || ended || buffered.length < 2) return;
      const fin = (buffered[0] & 0x80) !== 0;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      // RFC 6455: no extension was negotiated (5.2), and a server never masks (5.1).
      if (buffered[0] & 0x70) return protocolError(1002, 'reserved bits set');
      if (masked) return protocolError(1002, 'a masked frame from the server');
      let length = buffered[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = (buffered[2] << 8) | buffered[3];
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = new DataView(buffered.buffer, buffered.byteOffset + 2, 8).getBigUint64(0);
        if (big > BigInt(MAX_MESSAGE)) return protocolError(1009, 'message too big');
        length = Number(big);
        at = 10;
      }
      if (opcode >= 8 && (!fin || length > 125)) return protocolError(1002, 'a fragmented or long control frame');
      if (buffered.length < at + length) return;
      const payload = buffered.slice(at, at + length);
      buffered = buffered.subarray(at + length);
      if (opcode >= 8) {
        if (opcode === OP.ping) send(OP.pong, payload);
        else if (opcode === OP.close) {
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
          let reason = '';
          try {
            reason = decoder.decode(payload.subarray(2));
          } catch {
            return protocolError(1007, 'invalid UTF-8 in the close reason');
          }
          peerClose = { code, reason };
          if (closing) finish(code, reason, true);
          else {
            // Echo it, and let the socket go only once the echo is out: end()
            // flushes and half-closes, where destroy() would drop it (5.5.1).
            closing = true;
            const done = () => finish(code, reason, true);
            send(OP.close, code === 1005 ? new Uint8Array(0) : payload.subarray(0, 2));
            socket.end(done);
            closeTimer = setTimeout(done, CLOSE_WAIT_MS);
            closeTimer.unref?.();
          }
          return;
        }
        continue;
      }
      if (opcode === OP.cont) {
        if (!message) return protocolError(1002, 'continuation without a message');
      } else if (opcode === OP.text || opcode === OP.binary) {
        if (message) return protocolError(1002, 'a new message inside a fragmented one');
        message = { opcode, parts: [], size: 0 };
      } else {
        return protocolError(1002, `unknown opcode ${opcode}`);
      }
      message.parts.push(payload);
      message.size += payload.length;
      if (message.size > MAX_MESSAGE) return protocolError(1009, 'message too big');
      if (!fin) continue;
      const whole = new Uint8Array(message.size);
      let offset = 0;
      for (const part of message.parts) {
        whole.set(part, offset);
        offset += part.length;
      }
      const { opcode: kind } = message;
      message = null;
      if (kind === OP.text) {
        let text;
        try {
          text = decoder.decode(whole);
        } catch {
          return protocolError(1007, 'invalid UTF-8');
        }
        deliver(text);
      } else {
        deliver(whole);
      }
    }
  };

  let cancelled = false;
  // A message after the reader went away (cancelled, or the socket ended) is dropped.
  const deliver = (message) => {
    if (cancelled || ended) return;
    try {
      reading.enqueue(message);
    } catch {
      /* closed */
    }
  };
  readable = new ReadableStream({
    start(controller) {
      reading = controller;
    },
    cancel() {
      cancelled = true;
      close(1000, '');
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      if (closing || ended) throw errno('EPIPE', 'the websocket is closed');
      if (typeof chunk === 'string') send(OP.text, encoder.encode(chunk));
      else send(OP.binary, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    },
  });

  socket.on('data', (chunk) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const joined = new Uint8Array(buffered.length + bytes.length);
    joined.set(buffered);
    joined.set(bytes, buffered.length);
    buffered = joined;
    parse();
  });
  // The socket going away: a clean close if the server's close frame came first, else 1006.
  const gone = () => finish(peerClose?.code ?? 1006, peerClose?.reason ?? '', peerClose !== null);
  socket.on('error', gone);
  socket.on('close', gone);
  socket.resume();
  if (buffered.length) queueMicrotask(parse);

  return {
    url: href,
    protocol,
    readable,
    writable,
    closed,
    close({ code, reason } = {}) {
      close(code, reason);
    },
  };
}
