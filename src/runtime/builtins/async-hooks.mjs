/**
 * async_hooks: what works without V8's promise hooks.
 *
 * - AsyncResource (Node's API: asyncId, triggerAsyncId, runInAsyncScope,
 *   bind, emitDestroy), so events.EventEmitterAsyncResource and packages
 *   that wrap callbacks in a resource work;
 * - executionAsyncId / triggerAsyncId / executionAsyncResource for the main
 *   context (1 / 0), createHook (hooks are never called), asyncWrapProviders.
 *
 * AsyncLocalStorage needs the store to follow every promise continuation,
 * which the runtime can't see: `new AsyncLocalStorage()` throws
 * ERR_NOT_SUPPORTED rather than lose the store after an `await`.
 */
import { ERR_INVALID_ARG_TYPE, nodeError, validateFunction, validateObject, validateString } from '../node-errors.mjs';

const PROVIDERS = [
  'NONE', 'DIRHANDLE', 'DNSCHANNEL', 'ELDHISTOGRAM', 'FILEHANDLE', 'FILEHANDLECLOSEREQ', 'BLOBREADER',
  'FSEVENTWRAP', 'FSREQCALLBACK', 'FSREQPROMISE', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'HEAPSNAPSHOT',
  'HTTP2SESSION', 'HTTP2STREAM', 'HTTP2PING', 'HTTP2SETTINGS', 'HTTPINCOMINGMESSAGE', 'HTTPCLIENTREQUEST',
  'JSSTREAM', 'JSUDPWRAP', 'MESSAGEPORT', 'PIPECONNECTWRAP', 'PIPESERVERWRAP', 'PIPEWRAP', 'PROCESSWRAP',
  'PROMISE', 'QUERYWRAP', 'QUIC_ENDPOINT', 'QUIC_LOGSTREAM', 'QUIC_PACKET', 'QUIC_SESSION', 'QUIC_STREAM',
  'QUIC_UDP', 'SHUTDOWNWRAP', 'SIGNALWRAP', 'STATWATCHER', 'STREAMPIPE', 'TCPCONNECTWRAP', 'TCPSERVERWRAP',
  'TCPWRAP', 'TTYWRAP', 'UDPSENDWRAP', 'UDPWRAP', 'SIGINTWATCHDOG', 'WORKER', 'WORKERCPUPROFILE',
  'WORKERCPUUSAGE', 'WORKERHEAPSNAPSHOT', 'WORKERHEAPSTATISTICS', 'WRITEWRAP', 'ZLIB', 'CHECKPRIMEREQUEST',
  'PBKDF2REQUEST', 'KEYPAIRGENREQUEST', 'KEYGENREQUEST', 'KEYEXPORTREQUEST', 'CIPHERREQUEST',
  'DERIVEBITSREQUEST', 'HASHREQUEST', 'RANDOMBYTESREQUEST', 'RANDOMPRIMEREQUEST', 'SCRYPTREQUEST',
  'SIGNREQUEST', 'TLSWRAP', 'VERIFYREQUEST',
];

export function createAsyncHooks() {
  let nextId = 2; // 1 is the main context
  const kAsyncId = Symbol('asyncId');
  const kTriggerId = Symbol('triggerAsyncId');
  const topResource = {};
  const executionStack = [];

  class AsyncResource {
    constructor(type, opts = {}) {
      validateString(type, 'type');
      if (type.length === 0) throw nodeError(TypeError, 'ERR_ASYNC_TYPE', `Invalid name for async "type": ${type}`);
      let triggerAsyncId = opts;
      if (typeof opts !== 'number') {
        triggerAsyncId = opts?.triggerAsyncId === undefined ? 1 : opts.triggerAsyncId;
      }
      if (!Number.isSafeInteger(triggerAsyncId) || triggerAsyncId < -1) {
        throw nodeError(RangeError, 'ERR_INVALID_ASYNC_ID', `Invalid triggerAsyncId value: ${triggerAsyncId}`);
      }
      this[kAsyncId] = nextId++;
      this[kTriggerId] = triggerAsyncId;
    }
    runInAsyncScope(fn, thisArg, ...args) {
      // executionAsyncId() is this resource's while fn runs (not across awaits).
      executionStack.push(this);
      try {
        return Reflect.apply(fn, thisArg, args);
      } finally {
        executionStack.pop();
      }
    }
    emitDestroy() {
      return this;
    }
    asyncId() {
      return this[kAsyncId];
    }
    triggerAsyncId() {
      return this[kTriggerId];
    }
    bind(fn, thisArg) {
      validateFunction(fn, 'fn');
      const resource = this;
      const bound =
        thisArg === undefined
          ? function (...args) {
              return resource.runInAsyncScope(fn, this, ...args);
            }
          : (...args) => resource.runInAsyncScope(fn, thisArg, ...args);
      Object.defineProperties(bound, {
        length: { configurable: true, enumerable: false, value: fn.length, writable: false },
        asyncResource: { configurable: true, enumerable: true, value: this, writable: true },
      });
      return bound;
    }
    static bind(fn, type, thisArg) {
      type = type || fn.name || 'bound-anonymous-fn';
      return new AsyncResource(type).bind(fn, thisArg);
    }
  }

  class AsyncLocalStorage {
    constructor() {
      throw nodeError(
        Error,
        'ERR_NOT_SUPPORTED',
        'slicc-jsh: AsyncLocalStorage is not supported yet (its store would not follow await)'
      );
    }
  }

  function createHook(callbacks) {
    validateObject(callbacks, 'callbacks');
    for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
      const fn = callbacks[name];
      if (fn !== undefined && typeof fn !== 'function') throw ERR_INVALID_ARG_TYPE(`hook.${name}`, 'Function', fn);
    }
    return {
      enable() {
        return this;
      },
      disable() {
        return this;
      },
    };
  }

  return {
    AsyncLocalStorage,
    createHook,
    executionAsyncId: () => executionStack.at(-1)?.[kAsyncId] ?? 1,
    triggerAsyncId: () => executionStack.at(-1)?.[kTriggerId] ?? 0,
    executionAsyncResource: () => executionStack.at(-1) ?? topResource,
    asyncWrapProviders: Object.freeze({ __proto__: null, ...Object.fromEntries(PROVIDERS.map((p, i) => [p, i])) }),
    AsyncResource,
  };
}
