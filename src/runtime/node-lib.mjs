/**
 * Loads dist/vendor/node-lib.cjs (Node v22.22.0's own lib files, see
 * src/node-lib/README.md) with the runtime's versions of the modules they
 * require. Loaded once per realm, eagerly (`events` is Node's) — so what the
 * files need at run time (process, a builtin, the options) is looked up on
 * the program's `process` when they ask.
 */
import { stripVTControlCharacters } from 'node-inspect-extracted';
import nodeInspect from 'node-inspect-extracted';
import { loadVendorCjs } from './vendor-load.mjs';
import * as errors from './node-errors.mjs';
import {
  getSystemErrorMap,
  getSystemErrorMessage,
  getSystemErrorName,
  internalBinding,
  setBinding,
  uvErrmapGet,
} from './node-bindings.mjs';
import { createUtil } from './builtins/util.mjs';
import { createUrlInternals, urlBindings } from './builtins/url-internal.mjs';
import * as acorn from 'acorn';
import { ES_GLOBALS, decorateErrorStack, makeContextifyScriptWith, setGlobalOverlay } from './builtins/vm.mjs';
import { ErrorPrepareStackTrace, overrideStackTrace, setInternalPrepareStackTrace } from './stack.mjs';

for (const [name, value] of Object.entries(urlBindings)) setBinding(name, value);

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

// The program's process (handed in by process.mjs; Node's own files see it as
// their free \`process\` once run.mjs installs it as the global).
let programProcess;
const proc = () => programProcess ?? globalThis.process;

/** internal/options getOptionValue, over process.execArgv (`--x=v` or `--x v`). */
/** Options Node turns on unless their --no- form is given. */
const DEFAULT_ON = new Set(['--experimental-repl-await']);

function getOptionValue(name) {
  const argv = proc()?._options ?? proc()?.execArgv ?? [];
  if (DEFAULT_ON.has(name)) return !argv.includes(`--no-${name.slice(2)}`);
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) values.push(VALUED.has(name) ? argv[++i] : true);
    else if (a.startsWith(`${name}=`)) values.push(a.slice(name.length + 1));
  }
  if (name === '--disable-warning') return values.filter((v) => typeof v === 'string');
  if (VALUED.has(name)) return values.length ? String(values[values.length - 1]) : '';
  return values.length > 0;
}
const VALUED = new Set(['--disable-warning', '--redirect-warnings', '--diagnostic-dir']);

const builtin = (id) => proc()._builtin(id);
const lazy = (get) => Object.assign(get, { lazyRequire: true });

const kEnhanceStackBeforeInspector = Symbol('kEnhanceStackBeforeInspector');
const kEvents = Symbol('kEvents');
const kIsEventTarget = Symbol.for('nodejs.event_target');

let urlInternals;
let experimentalWarned;

let maxStack;
/** internal/errors isStackOverflowError. */
function isStackOverflowError(err) {
  if (maxStack === undefined) {
    try {
      const overflow = () => overflow();
      overflow();
    } catch (e) {
      maxStack = { name: e.name, message: e.message };
    }
  }
  return !!err && err.name === maxStack.name && err.message === maxStack.message;
}
// The runtime's own util (inspect over node-inspect-extracted, promisify,
// deprecate, …) under Node's lib/util.js and console.
let rtUtil;
const runtimeUtil = () => (rtUtil ??= createUtil());
const errnoClasses = errors.makeErrnoClasses(getSystemErrorName);

/** internal/util defineLazyProperties (a binding in Node): getters that load `id` on first use. */
function defineLazyProperties(target, id, keys, enumerable = true) {
  for (const key of keys) {
    let value;
    let loaded = false;
    Object.defineProperty(target, key, {
      __proto__: null,
      enumerable,
      configurable: true,
      get() {
        if (!loaded) {
          value = proc()._nodeLib().internal(id)[key];
          loaded = true;
        }
        return value;
      },
      set(v) {
        value = v;
        loaded = true;
      },
    });
  }
}

/** lib/internal/streams/utils.js's stream kind checks. */
const isNodeStream = (obj) =>
  !!obj &&
  (obj._readableState ||
    obj._writableState ||
    (typeof obj.write === 'function' && typeof obj.on === 'function') ||
    (typeof obj.pipe === 'function' && typeof obj.on === 'function'));
const isReadableStream = (obj) =>
  !!(obj && !isNodeStream(obj) && typeof obj.pipeThrough === 'function' && typeof obj.getReader === 'function' && typeof obj.cancel === 'function');
const isWritableStream = (obj) =>
  !!(obj && !isNodeStream(obj) && typeof obj.getWriter === 'function' && typeof obj.abort === 'function');

/** internal/abort_controller's aborted / transferable* over the platform's AbortController. */
const abortController = {
  async aborted(signal, resource) {
    if (signal === undefined) throw errors.ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
    errors.validateAbortSignal(signal, 'signal');
    errors.validateObject(resource, 'resource', errors.kValidateObjectAllowNullable | errors.kValidateObjectAllowFunction);
    if (signal.aborted) return;
    await new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
  transferableAbortSignal(signal) {
    if (signal?.constructor?.name !== 'AbortSignal') throw errors.ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
    return signal;
  },
  transferableAbortController() {
    return new AbortController();
  },
};

/** lib/internal/util.js getCIDR (os.networkInterfaces). */
function getCIDR(address, netmask, family) {
  let ones = 0;
  let split = '.';
  let range = 10;
  let groupLength = 8;
  let hasZeros = false;
  let lastPos = 0;
  if (family === 'IPv6') {
    split = ':';
    range = 16;
    groupLength = 16;
  }
  const countBinaryOnes = (n) => {
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24;
  };
  for (let i = 0; i < netmask.length; i++) {
    if (netmask[i] !== split) {
      if (i + 1 < netmask.length) continue;
      i++;
    }
    const part = netmask.slice(lastPos, i);
    lastPos = i + 1;
    if (part !== '') {
      if (hasZeros) {
        if (part !== '0') return null;
      } else {
        const binary = Number.parseInt(part, range);
        const binaryOnes = countBinaryOnes(binary);
        ones += binaryOnes;
        if (binaryOnes !== groupLength) {
          if (binary.toString(2).includes('01')) return null;
          hasZeros = true;
        }
      }
    }
  }
  return `${address}/${ones}`;
}

/** internal/util's WeakReference: a weak ref that holds on while counted. */
class WeakReference {
  #weak;
  #strong = null;
  #count = 0;
  constructor(object) {
    this.#weak = new WeakRef(object);
  }
  incRef() {
    if (++this.#count === 1) this.#strong = this.#weak.deref();
    return this.#count;
  }
  decRef() {
    if (--this.#count === 0) this.#strong = null;
    return this.#count;
  }
  get() {
    return this.#weak.deref();
  }
}

/** internal/modules/helpers' makeRequireFunction: a require for `mod` (the REPL's: from the working directory). */
export function makeRequireFunction(mod) {
  const Module = builtin('module');
  const from = mod?.filename ?? builtin('path').resolve(proc().cwd(), 'repl');
  const require = Module.createRequire(from.startsWith('/') ? from : builtin('path').resolve(proc().cwd(), 'repl'));
  return require;
}

/** internal/modules/helpers' addBuiltinLibsToObject: each builtin as a lazy global (the REPL's `fs`, `path`, …). */
export function addBuiltinLibsToObject(object, dummyModuleName) {
  const { builtinModules } = builtin('module');
  for (const name of builtinModules) {
    if (name.startsWith('_') || name.includes('/') || Object.prototype.hasOwnProperty.call(object, name)) continue;
    const setReal = (val) => {
      delete object[name];
      object[name] = val;
    };
    Object.defineProperty(object, name, {
      get: () => {
        const lib = builtin(name);
        try {
          Object.defineProperty(object, name, { get: () => lib, set: setReal, configurable: true, enumerable: false });
        } catch {
          /* non-configurable now */
        }
        return lib;
      },
      set: setReal,
      configurable: true,
      enumerable: false,
    });
  }
  void dummyModuleName;
}

const kPatched = Symbol('slicc-jsh.replPatched');

/**
 * lib/repl.js's REPLServer.prototype.createContext, where the realm withholds
 * names the kernel locks on globalThis (the Node-hosted kernel: `module`,
 * `require`, `exports`, … as non-configurable undefined). Node's own runs
 * where none is locked (the browser kernel). Otherwise, as Node's:
 * - useGlobal: globalThis, with the REPL's `module` and `require` in the
 *   scope its lines run in (vm's overlay), as they can't be defined on it;
 * - a context of its own: the program's globals copied in (the locked ones
 *   left out), its own console, then `module` and `require` on it.
 */
export function patchReplServer(REPLServer) {
  if (!REPLServer || REPLServer.prototype[kPatched]) return REPLServer;
  const nodeCreateContext = REPLServer.prototype.createContext;
  const lockedOn = (o, n) => Object.getOwnPropertyDescriptor(o, n)?.configurable === false && o[n] === undefined;
  REPLServer.prototype.createContext = function createContext() {
    if (!['module', 'require'].some((n) => lockedOn(globalThis, n))) return nodeCreateContext.call(this);
    const Module = builtin('module');
    const replModule = new Module('<repl>');
    replModule.paths = Module._resolveLookupPaths('<repl>', { paths: Module._nodeModulePaths(proc().cwd()) });
    if (this.useGlobal) {
      const overlay = Object.create(null);
      overlay.module = replModule;
      overlay.require = makeRequireFunction(replModule);
      setGlobalOverlay(overlay);
      addBuiltinLibsToObject(globalThis, '<REPL>');
      return globalThis;
    }
    const context = builtin('vm').createContext();
    const fresh = new Set(ES_GLOBALS);
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (fresh.has(name) || lockedOn(globalThis, name)) continue;
      Object.defineProperty(context, name, { __proto__: null, ...Object.getOwnPropertyDescriptor(globalThis, name) });
    }
    context.global = context;
    Object.defineProperty(context, 'console', {
      configurable: true,
      writable: true,
      value: new (builtin('console').Console)(this.output),
    });
    Object.defineProperty(context, 'module', { configurable: true, writable: true, value: replModule });
    Object.defineProperty(context, 'require', { configurable: true, writable: true, value: makeRequireFunction(replModule) });
    addBuiltinLibsToObject(context, '<REPL>');
    return context;
  };
  Object.defineProperty(REPLServer.prototype, kPatched, { value: true });
  return REPLServer;
}

export function loadNodeLib({ ctx, process } = {}) {
  if (process) programProcess = process;
  return loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'node-lib',
    process: proc(),
    requires: {
      'internal/errors': {
        codes: errors.errorCodes(),
        AbortError: errors.AbortError,
        isErrorStackTraceLimitWritable: () => true,
        hideStackFrames: (fn) => fn,
        ErrnoException: errnoClasses.ErrnoException,
        isStackOverflowError,
        ExceptionWithHostPort: errnoClasses.ExceptionWithHostPort,
        uvErrmapGet,
        genericNodeError(message, errorProperties) {
          return Object.assign(new Error(message), errorProperties);
        },
        kEnhanceStackBeforeInspector,
        ErrorPrepareStackTrace,
        overrideStackTrace,
        // lib/internal/source_map: the formatter of every stack while source
        // maps are on (jsh's own otherwise: `defaultPrepareStackTrace`).
        defaultPrepareStackTrace: null,
        setInternalPrepareStackTrace,
        kIsNodeError: Symbol('kIsNodeError'),
      },
      'internal/validators': {
        validateAbortSignal: errors.validateAbortSignal,
        validateArray: errors.validateArray,
        validateOneOf: errors.validateOneOf,
        validateBoolean: errors.validateBoolean,
        validateFunction: errors.validateFunction,
        validateInteger: errors.validateInteger,
        validateInt32: errors.validateInt32,
        validateNumber: errors.validateNumber,
        validateObject: errors.validateObject,
        validateStringArray: errors.validateStringArray,
        validateBooleanArray: errors.validateBooleanArray,
        validateUnion: errors.validateUnion,
        kValidateObjectAllowNullable: errors.kValidateObjectAllowNullable,
        kValidateObjectAllowArray: errors.kValidateObjectAllowArray,
        kValidateObjectAllowFunction: errors.kValidateObjectAllowFunction,
        validateString: errors.validateString,
        validateUint32: errors.validateUint32,
      },
      'internal/util': {
        kEmptyObject: Object.freeze({ __proto__: null }),
        SymbolDispose: Symbol.dispose || Symbol.for('nodejs.dispose'),
        SymbolAsyncDispose: Symbol.asyncDispose || Symbol.for('nodejs.asyncDispose'),
        get promisify() {
          return runtimeUtil().promisify;
        },
        get deprecate() {
          return runtimeUtil().deprecate;
        },
        getSystemErrorMap,
        getSystemErrorName,
        getSystemErrorMessage,
        defineLazyProperties,
        assignFunctionName(name, fn, descriptor = {}) {
          if (typeof name !== 'string') name = `[${name.description}]`;
          return Object.defineProperty(fn, 'name', {
            writable: false,
            enumerable: false,
            configurable: true,
            ...descriptor,
            value: name,
          });
        },
        isWindows: false,
        isUnderNodeModules: (filename) => /[\\/]node_modules[\\/]/.test(String(filename)),
        // Node's: one ExperimentalWarning per feature.
        emitExperimentalWarning(feature) {
          experimentalWarned ??= new Set();
          if (experimentalWarned.has(feature)) return;
          experimentalWarned.add(feature);
          proc().emitWarning(`${feature} is an experimental feature and might change at any time`, 'ExperimentalWarning');
        },
        isError: (e) => Object.prototype.toString.call(e) === '[object Error]' || e instanceof Error,
        isMacOS: false,
        getLazy(initializer) {
          let value;
          let initialized = false;
          return () => {
            if (!initialized) {
              value = initializer();
              initialized = true;
            }
            return value;
          };
        },
        getCIDR,
        spliceOne(list, index) {
          for (; index + 1 < list.length; index++) list[index] = list[index + 1];
          list.pop();
        },
        decorateErrorStack,
        normalizeEncoding: errors.normalizeEncoding,
        // Node runs these in a realm of their own so RegExp.$1… stay the
        // program's; here they are the plain methods.
        SideEffectFreeRegExpPrototypeSymbolReplace: (regex, string, replacement) =>
          RegExp.prototype[Symbol.replace].call(regex, string, replacement),
        SideEffectFreeRegExpPrototypeSymbolSplit: (regex, string, limit) =>
          RegExp.prototype[Symbol.split].call(regex, string, limit),
        WeakReference,
      },
      'internal/util/inspect': {
        get inspect() {
          return runtimeUtil().inspect;
        },
        get format() {
          return runtimeUtil().format;
        },
        get formatWithOptions() {
          return runtimeUtil().formatWithOptions;
        },
        identicalSequenceRange: nodeInspect.identicalSequenceRange,
        getStringWidth: nodeInspect.getStringWidth,
        stripVTControlCharacters,
      },
      'internal/abort_controller': abortController,
      'internal/v8/startup_snapshot': { namespace: { addSerializeCallback() {}, isBuildingSnapshot: () => false } },
      'internal/encoding': { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder },
      'internal/util/trace_sigint': {
        // Node's: any value (truthy starts the SIGINT watchdog, which a
        // script here can't be interrupted by anyway: nothing to do).
        setTraceSigInt() {},
      },
      'internal/crypto/util': { kKeyObject: Symbol('kKeyObject') },
      'internal/crypto/keys': lazy(() => ({
        isKeyObject: (v) => v instanceof builtin('crypto').KeyObject,
        isCryptoKey: (v) => typeof globalThis.CryptoKey === 'function' && v instanceof globalThis.CryptoKey,
      })),
      // stream/consumers' Blob: the platform's.
      'internal/blob': { Blob: globalThis.Blob },
      console: lazy(() => builtin('console')),
      // The platform's EventTarget has none of Node's internals (listener
      // lists, max listeners): events' EventTarget paths see only Node's own.
      'internal/event_target': {
        isEventTarget: (obj) => obj?.constructor?.[kIsEventTarget] === true,
        kEvents,
        kResistStopPropagation: Symbol('kResistStopPropagation'),
      },
      'internal/process/task_queues': { queueMicrotask: (fn) => queueMicrotask(fn) },
      'internal/options': { getOptionValue },
      'internal/streams/utils': lazy(() => ({
        isWritable: builtin('stream').isWritable,
        isReadable: builtin('stream').isReadable,
        isDestroyed: builtin('stream').isDestroyed,
        // lib/internal/streams/utils.js's.
        isWritableEnded(stream) {
          if (stream.writableEnded === true) return true;
          const wState = stream._writableState;
          if (wState?.errored) return false;
          if (typeof wState?.ended !== 'boolean') return null;
          return wState.ended;
        },
        isNodeStream,
        isReadableStream,
        isWritableStream,
      })),
      'internal/streams/end-of-stream': lazy(() => builtin('stream').finished),
      // Readable/Writable/Duplex.fromWeb and toWeb (lib/internal/webstreams/adapters.js): the platform's streams.
      'internal/webstreams/readablestream': {
        ReadableStream: globalThis.ReadableStream,
        isReadableStream: (v) => typeof globalThis.ReadableStream === 'function' && v instanceof globalThis.ReadableStream,
      },
      'internal/webstreams/writablestream': {
        WritableStream: globalThis.WritableStream,
        isWritableStream: (v) => typeof globalThis.WritableStream === 'function' && v instanceof globalThis.WritableStream,
      },
      'internal/webstreams/queuingstrategies': {
        CountQueuingStrategy: globalThis.CountQueuingStrategy,
        ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
      },
      stream: lazy(() => builtin('stream')),
      string_decoder: lazy(() => builtin('string_decoder')),
      timers: lazy(() => builtin('timers')),
      // The REPL's (src/node-lib/lib/repl.js and internal/repl/*).
      'internal/deps/acorn/acorn/dist/acorn': acorn,
      vm: lazy(() => builtin('vm')),
      'internal/vm': lazy(() => ({ makeContextifyScript: makeContextifyScriptWith(builtin('vm')) })),
      'internal/async_hooks': { useDomainTrampoline() {} },
      'internal/bootstrap/realm': {
        // Node's scheme-only builtins (node:sea, node:sqlite, node:test, …): none here.
        BuiltinModule: { getSchemeOnlyModuleNames: () => [] },
      },
      'internal/modules/cjs/loader': lazy(() => ({ Module: builtin('module') })),
      'internal/modules/esm/formats': {
        extensionFormatMap: { __proto__: null, '.cjs': 'commonjs', '.js': 'module', '.json': 'json', '.mjs': 'module' },
      },
      'internal/modules/esm/loader': {
        getOrInitializeCascadedLoader: () => ({
          import: (specifier, parentURL, attributes) =>
            proc()._importFrom(specifier, decodeURIComponent(new URL(parentURL).pathname), { with: attributes }),
        }),
      },
      'internal/modules/helpers': lazy(() => ({
        makeRequireFunction,
        addBuiltinLibsToObject,
        // Node's: a path as a file: URL, a URL as it is, else undefined.
        normalizeReferrerURL(referrerName) {
          if (referrerName == null) return undefined;
          if (builtin('path').isAbsolute(referrerName)) {
            return createUrlInternals({ nodePath: builtin('path'), Buffer: builtin('buffer').Buffer }).pathToFileURL(referrerName).href;
          }
          if (referrerName.startsWith('file://') || URL.canParse(referrerName)) return referrerName;
          return undefined;
        },
      })),
      'internal/process/permission': { isEnabled: () => false, has: () => true },
      'internal/util/inspector': {
        // No inspector: what Node does without one.
        sendInspectorCommand: (cb, onError) => onError?.(),
      },
      'internal/assert': function assert(value, message) {
        if (!value) throw new Error(message ?? 'Assertion failed');
      },
      'internal/console/global': lazy(() => builtin('console')),
      async_hooks: lazy(() => builtin('async_hooks')),
      os: lazy(() => builtin('os')),
      fs: lazy(() => builtin('fs')),
      path: lazy(() => builtin('path')),
      // The console is made before the builtins exist: until then, the Buffer class itself.
      buffer: lazy(() => (typeof proc()._builtinLoader === 'function' ? builtin('buffer') : { Buffer: proc()._Buffer })),
      'internal/url': lazy(() => (urlInternals ??= createUrlInternals({ nodePath: builtin('path'), Buffer: builtin('buffer').Buffer }))),
      '__jsh/internal-binding': {
        internalBinding,
        // The program's process, whoever is the global yet.
        process: new Proxy(
          {},
          {
            get: (_, key) => {
              const p = proc();
              const v = Reflect.get(p, key, p);
              return v;
            },
            set: (_, key, value) => Reflect.set(proc(), key, value),
            has: (_, key) => key in proc(),
            ownKeys: () => Reflect.ownKeys(proc()),
            // lib/domain.js defines process.domain (an accessor, not
            // configurable): on the program's process, and — as the Proxy
            // invariants want for a non-configurable one — on the target too.
            defineProperty: (target, key, desc) => {
              const ok = Reflect.defineProperty(proc(), key, desc);
              if (ok && desc.configurable !== true) Reflect.defineProperty(target, key, { ...desc, configurable: false });
              return ok;
            },
            getOwnPropertyDescriptor: (target, key) => {
              const own = Reflect.getOwnPropertyDescriptor(target, key);
              if (own) return own;
              const d = Reflect.getOwnPropertyDescriptor(proc(), key);
              if (d) d.configurable = true;
              return d;
            },
            getPrototypeOf: () => Object.getPrototypeOf(proc()),
          }
        ),
      },
    },
  });
}
