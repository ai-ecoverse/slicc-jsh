import { createAssert, createAssertStrict } from '../builtins/assert.mjs';
import { createChildProcess } from '../builtins/child-process.mjs';
import { createEvents } from '../builtins/events.mjs';
import { createFs } from '../builtins/fs.mjs';
import { createHttp } from '../builtins/http.mjs';
import { createFetch } from '../web/fetch.mjs';
import { createHttps } from '../builtins/https.mjs';
import { createNet } from '../builtins/net.mjs';
import { createStream, createStreamPromises } from '../builtins/stream.mjs';
import { createStringDecoder } from '../builtins/string-decoder.mjs';
import { createTimersModule, createTimersPromises } from '../builtins/timers-module.mjs';
import { createUtil } from '../builtins/util.mjs';
import { createAsyncHooks } from '../builtins/async-hooks.mjs';
import { createV8 } from '../builtins/v8.mjs';
import { createVm } from '../builtins/vm.mjs';
import { createPerfHooks, createStreamWeb } from '../builtins/perf-hooks.mjs';
import { patchReplServer } from '../node-lib.mjs';
import { CRYPTO_CONSTANTS } from '../builtins/crypto-constants.mjs';
import { createZlib } from '../builtins/zlib.mjs';
import { createCrypto } from '../builtins/crypto.mjs';
import { createTty } from '../builtins/tty.mjs';

const BUILTIN_LIST = [
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'console',
  'constants',
  'crypto',
  'diagnostics_channel',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

const NOT_YET = [
  'http2',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'inspector',
  'trace_events',
  'wasi',
];

function notSupported(id) {
  const err = new Error(`slicc-jsh: '${id}' is not supported yet`);
  err.code = 'ERR_NOT_SUPPORTED';
  throw err;
}

/**
 * Builtins available to require() in M1.
 */
/** Node's "Received …" tail of an ERR_INVALID_ARG_TYPE message. */
function describeReceived(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'function') return `function ${value.name || '<anonymous>'}`;
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

const TRANSCODE_ENCODINGS = {
  ascii: 'ascii',
  latin1: 'latin1',
  binary: 'latin1',
  ucs2: 'utf16le',
  'ucs-2': 'utf16le',
  utf16le: 'utf16le',
  'utf-16le': 'utf16le',
  utf8: 'utf8',
  'utf-8': 'utf8',
};

/** require('buffer'): Node 22's exports around our Buffer. */
function bufferModule(Buffer) {
  const MAX_LENGTH = 2 ** 53 - 1;
  const MAX_STRING_LENGTH = 536870888;
  const fatal = new TextDecoder('utf-8', { fatal: true });
  const bytesOf = (input) => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer) {
      return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw invalidArgType('input', 'an instance of ArrayBuffer, Buffer, or TypedArray', input);
  };
  function SlowBuffer(size) {
    return Buffer.allocUnsafeSlow(size);
  }
  return {
    Buffer,
    SlowBuffer,
    /**
     * Node's transcode (ICU): text a target cannot hold becomes '?', as ICU's
     * substitution does; invalid UTF-8 decodes to U+FFFD first.
     */
    transcode(source, fromEnc, toEnc) {
      if (!(source instanceof Uint8Array)) {
        throw invalidArgType('source', 'an instance of Buffer or Uint8Array', source);
      }
      const from = TRANSCODE_ENCODINGS[String(fromEnc).toLowerCase()];
      const to = TRANSCODE_ENCODINGS[String(toEnc).toLowerCase()];
      if (!from || !to) {
        const err = new Error('Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]');
        err.code = 'U_ILLEGAL_ARGUMENT_ERROR';
        err.errno = 1;
        throw err;
      }
      let text = Buffer.from(source).toString(from);
      if (to === 'latin1') text = text.replace(/[^\u0000-\u00ff]/gu, '?');
      else if (to === 'ascii') text = text.replace(/[^\u0000-\u007f]/gu, '?');
      return Buffer.from(text, to);
    },
    isUtf8(input) {
      const bytes = bytesOf(input);
      try {
        fatal.decode(bytes);
        return true;
      } catch {
        return false;
      }
    },
    isAscii(input) {
      return bytesOf(input).every((b) => b < 0x80);
    },
    kMaxLength: MAX_LENGTH,
    kStringMaxLength: MAX_STRING_LENGTH,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    constants: { MAX_LENGTH, MAX_STRING_LENGTH },
    INSPECT_MAX_BYTES: 50,
    Blob: globalThis.Blob,
    File: globalThis.File,
    resolveObjectURL: () => undefined,
  };
}

export function createBuiltins({ ctx, process, Buffer, console, path, handles, timers }) {
  const util = createUtil();
  const events = createEvents();
  const assert = createAssert({ ctx, process });
  assert.strict = createAssertStrict({ ctx, process });
  const assertStrict = assert.strict;
  let stream;
  const getStream = () => {
    if (!stream) stream = createStream({ ctx, process, Buffer, handles });
    return stream;
  };
  const streamPromises = {
    pipeline(...args) {
      return createStreamPromises(getStream(), handles).pipeline(...args);
    },
    finished(...args) {
      return createStreamPromises(getStream(), handles).finished(...args);
    },
  };
  const stringDecoder = createStringDecoder({ ctx, process, Buffer });
  const fs = createFs({ ctx, path, process, Buffer, handles, getStream });
  const timersMod = createTimersModule(timers);
  const timersPromises = createTimersPromises(timers, handles);
  let net;
  const getNet = () => {
    if (!net) net = createNet({ ctx, process, Buffer, handles, getStream });
    return net;
  };
  let http;
  let kernelFetch;
  const getHttp = () => {
    // Its fetch fallback (no route) goes through jsh's own fetch, as fetch() does.
    if (!http) http = createHttp({ ctx, process, Buffer, handles, getStream, net: getNet(), getFetch: () => (kernelFetch ??= createFetch(ctx, { handles, getHttp })) });
    return http;
  };
  let https;
  const getHttps = () => {
    if (!https) https = createHttps({ ctx, Buffer, http: getHttp(), handles, getStream });
    return https;
  };
  let tty;
  let crypto;
  const getCrypto = () => {
    crypto ??= createCrypto({ ctx, process, Buffer, getStream, stringDecoder, handles, timers });
    return crypto;
  };
  let zlib;
  const getZlib = () => {
    zlib ??= createZlib({ ctx, process, Buffer, getStream, util, assert });
    return zlib;
  };
  let childProcess;
  const getChildProcess = () => {
    if (!childProcess) {
      childProcess = createChildProcess({ ctx, process, Buffer, handles, getStream, getFs: () => fs });
    }
    return childProcess;
  };

  let bufferExports;
  let asyncHooks;
  let v8;
  let vm;
  let constants;
  let perfHooks;
  let streamWeb;

  /** Set by createCjs once Module is built — Node exports the constructor itself. */
  let ModuleExport = null;

  let workerThreads;
  const implemented = {
    process: () => process,
    // One thread: the main one. BroadcastChannel talks within the program;
    // a Worker can't be made yet.
    worker_threads: () =>
      (workerThreads ??= (() => {
        const environmentData = new Map();
        class Worker {
          constructor() {
            const err = new Error("slicc-jsh: worker_threads.Worker is not supported yet");
            err.code = 'ERR_NOT_SUPPORTED';
            throw err;
          }
        }
        return {
          isInternalThread: false,
          isMainThread: true,
          MessagePort: globalThis.MessagePort,
          MessageChannel: globalThis.MessageChannel,
          markAsUncloneable: () => {},
          markAsUntransferable: () => {},
          isMarkedAsUntransferable: () => false,
          moveMessagePortToContext: (port) => port,
          receiveMessageOnPort: () => undefined,
          resourceLimits: {},
          postMessageToThread: async () => {
            throw Object.assign(new Error('slicc-jsh: worker_threads.postMessageToThread is not supported yet'), { code: 'ERR_NOT_SUPPORTED' });
          },
          threadId: 0,
          threadName: '',
          SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
          Worker,
          parentPort: null,
          workerData: null,
          BroadcastChannel: process._broadcastChannel,
          setEnvironmentData: (key, value) => (value === undefined ? environmentData.delete(key) : environmentData.set(key, value)),
          getEnvironmentData: (key) => environmentData.get(key),
        };
      })()),
    buffer: () => (bufferExports ??= bufferModule(Buffer)),
    console: () => console,
    // lib/constants.js (deprecated, DEP0008, documentation only): os's
    // dlopen, errno, priority and signals, fs's and crypto's, frozen.
    constants: () =>
      (constants ??= Object.freeze(
        Object.assign(
          {},
          ...['dlopen', 'errno', 'priority', 'signals'].map((k) => process._nodeLib().os.constants[k] ?? {}),
          fs.constants,
          CRYPTO_CONSTANTS
        )
      )),
    // Node's own lib/path.js, lib/url.js, lib/querystring.js, lib/os.js,
    // lib/punycode.js (src/node-lib).
    path: () => process._nodeLib().path,
    'path/posix': () => process._nodeLib().path.posix,
    'path/win32': () => process._nodeLib().path.win32,
    punycode: () => process._nodeLib().punycode,
    async_hooks: () => (asyncHooks ??= createAsyncHooks()),
    v8: () => (v8 ??= createV8()),
    // Node's own lib/repl.js, lib/domain.js, lib/sys.js,
    // lib/diagnostics_channel.js, lib/stream/consumers.js (src/node-lib).
    repl: () => {
      const repl = process._nodeLib().replModule;
      patchReplServer(repl.REPLServer);
      return repl;
    },
    domain: () => process._nodeLib().domain,
    sys: () => process._nodeLib().sys,
    diagnostics_channel: () => process._nodeLib().diagnosticsChannel,
    'stream/consumers': () => process._nodeLib().streamConsumers,
    perf_hooks: () => (perfHooks ??= createPerfHooks()),
    'stream/web': () => (streamWeb ??= createStreamWeb()),
    vm: () =>
      (vm ??= createVm({
        cwd: () => process.cwd(),
        importFrom: (specifier, referrer, options) => process._importFrom(specifier, referrer, options),
        execArgv: () => process._options ?? process.execArgv ?? [],
        emitWarning: (message, type) => process.emitWarning(message, type),
      })),
    module: () => ModuleExport,
    fs: () => fs,
    zlib: getZlib,
    crypto: getCrypto,
    tty: () => (tty ??= createTty({ process })),
    readline: () => process._nodeLib().readline,
    'readline/promises': () => process._nodeLib().readlinePromises,
    'fs/promises': () => fs.promises,
    events: () => events,
    assert: () => assert,
    'assert/strict': () => assertStrict,
    // Node's own lib/util.js (src/node-lib).
    util: () => process._nodeLib().util,
    'util/types': () => process._nodeLib().util.types,
    os: () => process._nodeLib().os,
    url: () => process._nodeLib().url,
    querystring: () => process._nodeLib().querystring,
    string_decoder: () => stringDecoder,
    stream: () => getStream(),
    'stream/promises': () => streamPromises,
    timers: () => timersMod,
    'timers/promises': () => timersPromises,
    net: () => getNet(),
    http: () => getHttp(),
    https: () => getHttps(),
    child_process: () => getChildProcess(),
  };

  return {
    installModule(Module) {
      Module.builtinModules = [...BUILTIN_LIST];
      ModuleExport = Module;
    },
    util,
    has(id) {
      const bare = id.startsWith('node:') ? id.slice(5) : id;
      return Object.prototype.hasOwnProperty.call(implemented, bare) || NOT_YET.includes(bare);
    },
    load(id) {
      const bare = id.startsWith('node:') ? id.slice(5) : id;
      if (bare.startsWith('internal/') && (process._options ?? process.execArgv).includes('--expose-internals')) {
        const mod = process._nodeLib().internal(bare);
        if (mod !== undefined) return mod;
      }
      if (NOT_YET.includes(bare)) notSupported(bare);
      const factory = implemented[bare];
      if (!factory) {
        const err = new Error(`No such built-in module: node:${bare}`);
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }
      return factory();
    },
  };
}
