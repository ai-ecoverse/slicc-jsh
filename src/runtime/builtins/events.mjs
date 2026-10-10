/** EventEmitter with Node-ish 'error' semantics and events.once helper. */

export class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  on(event, fn) {
    const list = this._events.get(event);
    if (list) list.push(fn);
    else this._events.set(event, [fn]);
    return this;
  }

  addListener(event, fn) {
    return this.on(event, fn);
  }

  off(event, fn) {
    const list = this._events.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._events.delete(event);
    }
    return this;
  }

  removeListener(event, fn) {
    return this.off(event, fn);
  }

  once(event, fn) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    wrapped.listener = fn;
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    const list = this._events.get(event);
    if ((!list || list.length === 0) && event === 'error') {
      const arg = args[0];
      if (arg instanceof Error) throw arg;
      const err = new Error(`Unhandled error. (${typeof arg === 'string' ? `'${arg}'` : String(arg)})`);
      err.code = 'ERR_UNHANDLED_ERROR';
      err.context = arg;
      throw err;
    }
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  removeAllListeners(event) {
    if (event !== undefined) this._events.delete(event);
    else this._events.clear();
    return this;
  }

  listenerCount(event) {
    return this._events.get(event)?.length ?? 0;
  }

  listeners(event) {
    return [...(this._events.get(event) ?? [])].map((fn) => fn.listener ?? fn);
  }
}

EventEmitter.defaultMaxListeners = 10;

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      emitter.off(event, onEvent);
      if (event !== 'error') emitter.off('error', onError);
    };
    emitter.on(event, onEvent);
    if (event !== 'error') emitter.on('error', onError);
  });
}

export function createEvents() {
  return Object.assign(EventEmitter, {
    EventEmitter,
    once,
    defaultMaxListeners: EventEmitter.defaultMaxListeners,
  });
}
