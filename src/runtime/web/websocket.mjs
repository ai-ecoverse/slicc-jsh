/**
 * Browser/Node-shaped WebSocket over ctx.websocket (WebSocketStream-like).
 * Kernel ≥ 1.53.0 leaves globalThis.WebSocket as a writable undefined slot.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

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

function errorEvent(error) {
  return asEvent('error', {
    error,
    message: error?.message ?? String(error),
  });
}

export function createWebSocket(ctx) {
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
      if (typeof ctx.websocket !== 'function') {
        const err = new Error('slicc-jsh: WebSocket is not supported in slicc-jsh yet');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
      const href = String(url);
      this.#url = href;
      this.#open(href, toProtocols(protocols));
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

    #handler(type) {
      return this.#handlers.get(type) ?? null;
    }

    #setHandler(type, fn) {
      const prev = this.#handlers.get(type);
      if (prev) this.removeEventListener(type, prev);
      if (typeof fn === 'function') {
        this.#handlers.set(type, fn);
        this.addEventListener(type, fn);
      } else {
        this.#handlers.delete(type);
      }
    }

    async #open(url, protocols) {
      try {
        const socket = await ctx.websocket(url, protocols != null ? { protocols } : undefined);
        if (this.#closed) {
          socket.close();
          return;
        }
        this.#socket = socket;
        this.#url = socket.url ?? url;
        this.#protocol = socket.protocol ?? '';
        this.#writer = socket.writable.getWriter();
        this.#readyState = OPEN;
        this.dispatchEvent(new Event('open'));
        void this.#readLoop(socket);
        void socket.closed.then(
          (close) => this.#finishClose(close?.code ?? 1000, close?.reason ?? '', true),
          (err) => {
            this.dispatchEvent(errorEvent(err));
            this.#finishClose(1006, '', false);
          }
        );
      } catch (err) {
        this.dispatchEvent(errorEvent(err));
        this.#finishClose(1006, '', false);
      }
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
          this.dispatchEvent(messageEvent(data));
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
          this.dispatchEvent(errorEvent(err));
        }
      );
    }

    close(code, reason) {
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      this.#closed = true;
      this.#readyState = CLOSING;
      try {
        this.#socket?.close({ code, reason });
      } catch (err) {
        this.dispatchEvent(errorEvent(err));
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
      this.dispatchEvent(closeEvent(code, reason, wasClean));
    }
  }

  WebSocket.CONNECTING = CONNECTING;
  WebSocket.OPEN = OPEN;
  WebSocket.CLOSING = CLOSING;
  WebSocket.CLOSED = CLOSED;
  return WebSocket;
}
