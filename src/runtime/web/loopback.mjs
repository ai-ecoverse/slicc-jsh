/**
 * The kernel's own loopback, for the web APIs (`fetch`, `WebSocket`): which
 * URLs go to a server of this kernel rather than to the platform (the
 * kernel's transport), and HTTP/1.1 over a kernel socket (node:net on
 * ctx.net) to reach it.
 */

/**
 * A loopback URL's address on the kernel's own loopback, as the kernel
 * classifies names: 127.0.0.0/8, ::1, 0.0.0.0, localhost and *.localhost (a
 * trailing dot or not) at the URL's port; `<port>.kernel.localhost` (the
 * page's way to name a kernel port) at that port. `host.slicc.internal` (and
 * its address 10.0.2.2), the real machine's loopback, through the kernel's
 * proxy (`proxy: true`), which forwards it there. Else null: the platform.
 */
export function kernelRoute(url) {
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = Number(url.port || 80);
  const kernelPort = /^(\d+)\.kernel\.localhost$/.exec(host);
  if (kernelPort) return { host: '127.0.0.1', port: Number(kernelPort[1]) };
  if (host === 'localhost' || host.endsWith('.localhost')) return { host: '127.0.0.1', port };
  if (/^127(\.\d{1,3}){3}$/.test(host)) return { host, port };
  if (host === '0.0.0.0') return { host: '127.0.0.1', port };
  if (host === '[::1]' || host === '::1') return { host: '::1', port };
  if (host === 'host.slicc.internal' || host === '10.0.2.2') return KERNEL_PROXY;
  return null;
}

// The kernel's HTTP proxy (it takes absolute-form requests).
const KERNEL_PROXY = Object.freeze({ host: '127.0.0.1', port: 3128, proxy: true });

/**
 * A connected kernel socket to `host:port`. Rejects with the socket's errno
 * error (`ECONNREFUSED`, …), or the signal's reason.
 */
export function dialLoopback(net, { host, port, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = net.connect({ host, port });
    const onAbort = () => {
      done();
      socket.destroy();
      reject(signal.reason);
    };
    const onError = (err) => {
      done();
      reject(err);
    };
    const onConnect = () => {
      done();
      resolve(socket);
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

/** Write an HTTP/1.1 request head: `headers` are `[name, value]` pairs, in order. */
export function writeHead(socket, { method, path, headers }) {
  let head = `${method} ${path} HTTP/1.1\r\n`;
  for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
  socket.write(`${head}\r\n`);
}

const MAX_HEAD = 64 * 1024;

/**
 * The response head, once `\r\n\r\n` has arrived: `{ status, statusText,
 * rawHeaders, rest }`, `rawHeaders` as Node's (name, value, name, value…)
 * and `rest` the bytes after the head. The socket is paused then, with no
 * `data` listener of this function's left on it: the caller reads the rest.
 */
export function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buffered = new Uint8Array(0);
    const onData = (chunk) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const joined = new Uint8Array(buffered.length + bytes.length);
      joined.set(buffered);
      joined.set(bytes, buffered.length);
      buffered = joined;
      const end = headEnd(buffered);
      if (end < 0) {
        if (buffered.length > MAX_HEAD) fail(Object.assign(new Error('response head too large'), { code: 'HPE_HEADER_OVERFLOW' }));
        return;
      }
      done();
      socket.pause();
      const lines = latin1(buffered.subarray(0, end)).split('\r\n');
      const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines.shift());
      if (!status) {
        reject(Object.assign(new Error('invalid response status line'), { code: 'HPE_INVALID_CONSTANT' }));
        return;
      }
      const rawHeaders = [];
      for (const line of lines) {
        const at = line.indexOf(':');
        if (at <= 0) continue;
        rawHeaders.push(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      resolve({
        status: Number(status[1]),
        statusText: status[2] ?? '',
        rawHeaders,
        rest: buffered.subarray(end + 4),
      });
    };
    const onEnd = () => fail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const fail = (err) => {
      done();
      reject(err);
    };
    const done = () => {
      socket.off('data', onData);
      socket.off('error', fail);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
  });
}

function headEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
