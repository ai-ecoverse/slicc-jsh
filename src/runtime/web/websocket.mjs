/**
 * Browser/Node-shaped WebSocket over ctx.websocket (WebSocketStream-like).
 * Kernel ≥ 1.53.0 leaves globalThis.WebSocket as a writable undefined slot.
 */

import { NodeExitError } from '../exit.mjs';
import { kernelAtLeast } from '../kernel-version.mjs';
import { kernelRoute } from './loopback.mjs';
import { openLoopbackWebSocket } from './websocket-loopback.mjs';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** RFC 9110's token, which a subprotocol must be. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function toProtocols(protocols) {
  if (protocols == null) return undefined;
  if (typeof protocols === 'string') return protocols;
  if (Array.isArray(protocols)) return protocols.map(String);
  return String(protocols);
}

/** EventTarget.dispatchEvent requires a real Event — never a plain object. */
function asEvent(type, props = {}) {
  try {
    if (type === 'message' && typeof MessageEvent === 'function') {
      return new MessageEvent('message', props);
    }
    if (type === 'close' && typeof CloseEvent === 'function') {
      return new CloseEvent('close', props);
    }
    if (type === 'error' && typeof ErrorEvent === 'function') {
      return new ErrorEvent('error', props);
    }
  } catch {
    /* fall through */
  }
  const ev = new Event(type);
  for (const [k, v] of Object.entries(props)) {
    try {
      Object.defineProperty(ev, k, { value: v, enumerable: true, configurable: true });
    } catch {
      try {
        ev[k] = v;
      } catch {
        /* ignore */
      }
    }
  }
  return ev;
}

function messageEvent(data) {
  return asEvent('message', { data });
}

function closeEvent(code, reason, wasClean) {
  return asEvent('close', { code, reason, wasClean });
}

/**
 * Build an ErrorEvent. Kernel ≥ 1.59.1 rejects with TypeError + cause.code
 * (ECONNREFUSED, EAI_NONAME, …). Pass that Error through so callers can read
 * `event.error.cause.code`. Node undici's ErrorEvent.error has no .code/.cause,
 * so we do not copy cause.code onto error.code.
 */
function errorEvent(error) {
  return asEvent('error', {
    error,
    message: error?.message ?? String(error),
  });
}

/**
 * A `ws:` URL for a server of this kernel (its loopback names; see
 * kernelRoute), else null: `ctx.websocket`, the platform's network, takes it
 * (`host.slicc.internal` too, which the kernel forwards to the real machine).
 */
function loopbackRoute(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:') return null;
  url.protocol = 'http:';
  const route = kernelRoute(url);
  return route && !route.proxy ? route : null;
}

export function createWebSocket(ctx, { handles, trackPromise, getNet } = {}) {
  // slicc-kernel 1.106.3 (ai-ecoverse/slicc-kernel#822, #834): the kernel's
  // own loopback ctx.websocket answers as undici does (the handshake checks,
  // the close after the server has the echo and closed the connection, the
  // refused upgrade), so a loopback URL goes to it. Older kernels: jsh's own
  // RFC 6455 client over the kernel's sockets.
  const kernelLoopback = kernelAtLeast(ctx, '1.106.3');
  class WebSocket extends EventTarget {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    #socket;
    #writer;
    #readyState = CONNECTING;
    #url = '';
    #protocol = '';
    #bufferedAmount = 0;
    #binaryType = 'blob';
    #closed = false;

    constructor(url, protocols) {
      super();
      // The WHATWG constructor's checks (undici's, in Node 22): a URL, ws: or
      // wss: (http: and https: become them), no fragment, valid protocols.
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch (err) {
        throw new DOMException(String(err), 'SyntaxError');
      }
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw new DOMException(`Expected a ws: or wss: protocol, got ${parsed.protocol}`, 'SyntaxError');
      }
      if (parsed.hash || parsed.href.endsWith('#')) throw new DOMException('Got fragment', 'SyntaxError');
      const list = toProtocols(protocols);
      const names = list === undefined ? [] : Array.isArray(list) ? list : [list];
      if (new Set(names).size !== names.length || names.some((n) => !TOKEN.test(n))) {
        throw new DOMException('Invalid Sec-WebSocket-Protocol value', 'SyntaxError');
      }
      if (typeof ctx.websocket !== 'function') {
        const err = new Error('slicc-jsh: WebSocket is not supported in slicc-jsh yet');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
      const href = parsed.href;
      this.#url = href;
      this.#open(href, list);
    }

    get url() {
      return this.#url;
    }
    get readyState() {
      return this.#readyState;
    }
    get protocol() {
      return this.#protocol;
    }
    get extensions() {
      return '';
    }
    get bufferedAmount() {
      return this.#bufferedAmount;
    }
    get binaryType() {
      return this.#binaryType;
    }
    set binaryType(value) {
      if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value;
    }

    get onopen() {
      return this.#handler('open');
    }
    set onopen(fn) {
      this.#setHandler('open', fn);
    }
    get onmessage() {
      return this.#handler('message');
    }
    set onmessage(fn) {
      this.#setHandler('message', fn);
    }
    get onerror() {
      return this.#handler('error');
    }
    set onerror(fn) {
      this.#setHandler('error', fn);
    }
    get onclose() {
      return this.#handler('close');
    }
    set onclose(fn) {
      this.#setHandler('close', fn);
    }

    #handlers = new Map();
    #userHandlers = new Map();

    #handler(type) {
      return this.#userHandlers.get(type) ?? null;
    }

    #setHandler(type, fn) {
      const prev = this.#handlers.get(type);
      if (prev) this.removeEventListener(type, prev);
      if (typeof fn === 'function') {
        // EventTarget reports listener throws on nextTick (not sync), so catch
        // NodeExitError here — process.exit() already recorded the code.
        const wrapped = (ev) => {
          try {
            return fn.call(this, ev);
          } catch (err) {
            if (err instanceof NodeExitError || err?.name === 'NodeExitError') {
              try {
                handles?.notify?.();
              } catch {
                /* ignore */
              }
              return;
            }
            throw err;
          }
        };
        this.#userHandlers.set(type, fn);
        this.#handlers.set(type, wrapped);
        this.addEventListener(type, wrapped);
      } else {
        this.#userHandlers.delete(type);
        this.#handlers.delete(type);
      }
    }

    #open(url, protocols) {
      // Track the open promise so drainLoop stays alive until error fires
      // (without a handle the process can exit before the catch runs — m2g/ws2.js).
      // A loopback URL is a server of this kernel (as fetch has it). From
      // slicc-kernel 1.106.3 ctx.websocket reaches it as undici would; before
      // that its close came before the server had the echo
      // (ai-ecoverse/slicc-kernel#822), so jsh speaks RFC 6455 over the
      // kernel's sockets there. Anything else, ctx.websocket: the platform's
      // network, through the kernel's transport.
      const route = getNet && !kernelLoopback ? loopbackRoute(url) : null;
      const open = (async () => {
        try {
          const socket = route
            ? await openLoopbackWebSocket(getNet(), url, protocols, route)
            : await ctx.websocket(url, protocols != null ? { protocols } : undefined);
          if (this.#closed) {
            socket.close();
            return;
          }
          this.#socket = socket;
          this.#url = socket.url ?? url;
          this.#protocol = socket.protocol ?? '';
          this.#writer = socket.writable.getWriter();
          this.#readyState = OPEN;
          this.#emit(new Event('open'));
          const read = this.#readLoop(socket);
          if (trackPromise && handles) trackPromise(handles, read);
          const closed = socket.closed.then(
            (close) => this.#finishClose(close?.code ?? 1000, close?.reason ?? '', close?.wasClean ?? true),
            (err) => {
              // Peer closed before open / transport failure after dial: error only,
              // matching Node undici (no close event; readyState stays CONNECTING).
              if (!this.#closed) this.#emit(errorEvent(err));
            }
          );
          if (trackPromise && handles) trackPromise(handles, closed);
        } catch (err) {
          // Kernel ≥ 1.59.1 nodeTransport rejects at once (cause.code set).
          // Error Event, no close, readyState stays CONNECTING — Node 22 undici.
          if (!this.#closed) this.#emit(errorEvent(err));
        }
      })();
      if (trackPromise && handles) trackPromise(handles, open);
      else void open;
    }

    async #readLoop(socket) {
      const reader = socket.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (this.#readyState !== OPEN) break;
          let data = value;
          if (typeof data !== 'string') {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            data =
              this.#binaryType === 'arraybuffer'
                ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
                : new Blob([bytes]);
          }
          this.#emit(messageEvent(data));
        }
      } catch {
        /* closed / aborted */
      }
    }

    send(data) {
      if (this.#readyState !== OPEN) {
        const err = new Error(
          `WebSocket is not open: readyState ${this.#readyState} (${this.#readyState === CONNECTING ? 'CONNECTING' : 'CLOSED'})`
        );
        err.name = 'InvalidStateError';
        throw err;
      }
      let chunk = data;
      if (typeof data !== 'string') {
        if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) {
          chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          void data.arrayBuffer().then((buf) => {
            void this.#writer?.write(new Uint8Array(buf));
          });
          return;
        } else {
          chunk = String(data);
        }
      }
      const size = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      this.#bufferedAmount += size;
      void this.#writer.write(chunk).then(
        () => {
          this.#bufferedAmount = Math.max(0, this.#bufferedAmount - size);
        },
        (err) => {
          this.#bufferedAmount = Math.max(0, this.#bufferedAmount - size);
          this.#emit(errorEvent(err));
        }
      );
    }

    close(code, reason) {
      // undici's checks, before the state's: a code we may send, a reason that fits a control frame.
      if (code !== undefined && !(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999))) {
        throw new DOMException('invalid code', 'InvalidAccessError');
      }
      if (reason !== undefined) {
        const size = new TextEncoder().encode(String(reason)).length;
        if (size > 123) throw new DOMException(`Reason must be less than 123 bytes; received ${size}`, 'SyntaxError');
      }
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      this.#closed = true;
      this.#readyState = CLOSING;
      try {
        this.#socket?.close({ code, reason });
      } catch (err) {
        this.#emit(errorEvent(err));
        this.#finishClose(1006, '', false);
      }
    }

    #finishClose(code, reason, wasClean) {
      if (this.#readyState === CLOSED) return;
      this.#readyState = CLOSED;
      this.#closed = true;
      try {
        void this.#writer?.close();
      } catch {
        /* ignore */
      }
      this.#emit(closeEvent(code, reason, wasClean));
    }

    /** dispatchEvent; swallow NodeExitError (process.exit already recorded). */
    #emit(ev) {
      try {
        this.dispatchEvent(ev);
      } catch (err) {
        if (err instanceof NodeExitError || err?.name === 'NodeExitError') {
          try {
            handles?.notify?.();
          } catch {
            /* ignore */
          }
          return;
        }
        throw err;
      }
    }
  }

  WebSocket.CONNECTING = CONNECTING;
  WebSocket.OPEN = OPEN;
  WebSocket.CLOSING = CLOSING;
  WebSocket.CLOSED = CLOSED;
  return WebSocket;
}
