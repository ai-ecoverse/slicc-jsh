/** Minimal EventEmitter (from slicc 6 realm, Apache-2.0). */

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
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    const list = this._events.get(event);
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
    return [...(this._events.get(event) ?? [])];
  }
}

export function createEvents() {
  return Object.assign(EventEmitter, { EventEmitter });
}
