/**
 * Node 22's MessageEvent: undici 6.23's (lib/web/websocket/events.js), with
 * its WebIDL conversions and their messages (lib/web/fetch/webidl.js).
 *
 * The program gets this one instead of the platform's. Node 26 makes its
 * global MessageEvent lazily from undici, and loading undici takes ~10 ms in
 * each process and thread; the first message a port delivers paid it in every
 * worker_threads.Worker (#566).
 *
 * Marked uncloneable, as undici's are: posting one is a DataCloneError
 * (./uncloneable.mjs). The platform's structuredClone of one still gives
 * what it makes of a plain object.
 */
import { inspect } from 'node-inspect-extracted';
import { markOwnUncloneable } from './uncloneable.mjs';

const exception = (header, message) => new TypeError(`${header}: ${message}`);

function type(V) {
  if (V === null) return 'Null';
  switch (typeof V) {
    case 'undefined':
      return 'Undefined';
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'symbol':
      return 'Symbol';
    case 'number':
      return 'Number';
    case 'bigint':
      return 'BigInt';
    default:
      return 'Object';
  }
}

function stringify(V) {
  switch (type(V)) {
    case 'Symbol':
      return `Symbol(${V.description})`;
    case 'Object':
      return inspect(V);
    case 'String':
      return `"${V}"`;
    default:
      return `${V}`;
  }
}

function brandCheck(V, I) {
  if (!(V instanceof I)) {
    const err = new TypeError('Illegal invocation');
    err.code = 'ERR_INVALID_THIS';
    throw err;
  }
}

function argumentLengthCheck({ length }, min, header) {
  if (length < min) {
    throw exception(header, `${min} argument${min !== 1 ? 's' : ''} required, but${length ? ' only' : ''} ${length} found.`);
  }
}

function DOMString(V, prefix, argument) {
  if (typeof V === 'symbol') throw exception(prefix, `${argument} is a symbol, which cannot be converted to a DOMString.`);
  return String(V);
}

const USVString = (V) => `${V}`.toWellFormed();

/**
 * The MessageEvent class, its ports and source checked against `MessagePort`
 * (the program's).
 * @param {{ MessagePort: Function }} options
 */
export function createMessageEvent({ MessagePort }) {
  const port = (V, prefix, argument) => {
    if (!(V instanceof MessagePort)) {
      throw exception(prefix, `Expected ${argument} ("${stringify(V)}") to be an instance of ${MessagePort.name}.`);
    }
    return V;
  };
  const ports = (V, prefix, argument) => {
    if (type(V) !== 'Object') throw exception(prefix, `${argument} (${stringify(V)}) is not iterable.`);
    const method = V?.[Symbol.iterator]?.();
    if (method === undefined || typeof method.next !== 'function') throw exception(prefix, `${argument} is not iterable.`);
    const seq = [];
    let index = 0;
    for (;;) {
      const { done, value } = method.next();
      if (done) break;
      seq.push(port(value, prefix, `${argument}[${index++}]`));
    }
    return seq;
  };
  const fields = [
    ['bubbles', Boolean, () => false],
    ['cancelable', Boolean, () => false],
    ['composed', Boolean, () => false],
    ['data', (V) => V, () => null],
    ['origin', USVString, () => ''],
    ['lastEventId', DOMString, () => ''],
    ['source', (V, prefix, argument) => (V === null ? V : port(V, prefix, argument)), () => null],
    ['ports', ports, () => []],
  ];
  // webidl.dictionaryConverter: null or undefined is an empty dictionary,
  // without its defaults.
  const MessageEventInit = (dictionary, prefix, argument) => {
    const kind = type(dictionary);
    const dict = {};
    if (kind === 'Null' || kind === 'Undefined') return dict;
    if (kind !== 'Object') throw exception(prefix, `Expected ${dictionary} to be one of: Null, Undefined, Object.`);
    for (const [key, converter, defaultValue] of fields) {
      let value = dictionary[key];
      if (value !== null) value ??= defaultValue();
      dict[key] = converter(value, prefix, `${argument}.${key}`);
    }
    return dict;
  };

  // Node 22 bundles it as _MessageEvent: V8 names the class so in its own
  // messages (`Class constructor _MessageEvent cannot be invoked without 'new'`).
  const MessageEvent = class _MessageEvent extends Event {
    #eventInit;

    constructor(type, eventInitDict = {}) {
      const prefix = 'MessageEvent constructor';
      argumentLengthCheck(arguments, 1, prefix);
      type = DOMString(type, prefix, 'type');
      eventInitDict = MessageEventInit(eventInitDict, prefix, 'eventInitDict');
      super(type, eventInitDict);
      this.#eventInit = eventInitDict;
      // undici marks its events: posting one is a DataCloneError.
      markOwnUncloneable(this);
    }

    get data() {
      brandCheck(this, MessageEvent);
      return this.#eventInit.data;
    }

    get origin() {
      brandCheck(this, MessageEvent);
      return this.#eventInit.origin;
    }

    get lastEventId() {
      brandCheck(this, MessageEvent);
      return this.#eventInit.lastEventId;
    }

    get source() {
      brandCheck(this, MessageEvent);
      return this.#eventInit.source;
    }

    get ports() {
      brandCheck(this, MessageEvent);
      if (!Object.isFrozen(this.#eventInit.ports)) Object.freeze(this.#eventInit.ports);
      return this.#eventInit.ports;
    }

    initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = '', lastEventId = '', source = null, ports = []) {
      brandCheck(this, MessageEvent);
      argumentLengthCheck(arguments, 1, 'MessageEvent.initMessageEvent');
      return new MessageEvent(type, { bubbles, cancelable, data, origin, lastEventId, source, ports });
    }
  };
  Object.defineProperty(MessageEvent, 'name', { value: 'MessageEvent', configurable: true });
  const enumerable = { enumerable: true };
  Object.defineProperties(MessageEvent.prototype, {
    [Symbol.toStringTag]: { value: 'MessageEvent', configurable: true },
    data: enumerable,
    origin: enumerable,
    lastEventId: enumerable,
    source: enumerable,
    ports: enumerable,
    initMessageEvent: enumerable,
  });
  return MessageEvent;
}

/**
 * Make `MessageEvent` the program's global. The platform's slot is deleted
 * first, never read: on Node, reading or redefining it over its lazy value
 * makes it, and that loads undici. Returns the undo (the platform's is gone
 * then; the program is over).
 */
export function installMessageEvent(MessageEvent, scope = globalThis) {
  try {
    delete scope.MessageEvent;
    Object.defineProperty(scope, 'MessageEvent', { value: MessageEvent, writable: true, enumerable: false, configurable: true });
  } catch {
    return () => {};
  }
  return () => {
    if (scope.MessageEvent === MessageEvent) delete scope.MessageEvent;
  };
}
