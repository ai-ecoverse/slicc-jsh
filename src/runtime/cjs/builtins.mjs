import { createAssert, createAssertStrict } from '../builtins/assert.mjs';
import { createChildProcess } from '../builtins/child-process.mjs';
import { createEvents } from '../builtins/events.mjs';
import { createFs } from '../builtins/fs.mjs';
import { createHttp } from '../builtins/http.mjs';
import { createHttps } from '../builtins/https.mjs';
import { createNet } from '../builtins/net.mjs';
import { createStream, createStreamPromises } from '../builtins/stream.mjs';
import { createStringDecoder } from '../builtins/string-decoder.mjs';
import { createTimersModule, createTimersPromises } from '../builtins/timers-module.mjs';
import { createUtil } from '../builtins/util.mjs';
import { createAsyncHooks } from '../builtins/async-hooks.mjs';
import { createV8 } from '../builtins/v8.mjs';
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
  'crypto',
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
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'zlib',
];

const NOT_YET = [
  'http2',
  'worker_threads',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'vm',
  'perf_hooks',
  'inspector',
  'trace_events',
  'was',
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
  const getHttp = () => {
    if (!http) http = createHttp({ ctx, process, Buffer, handles, getStream, net: getNet() });
    return http;
  };
  let https;
  const getHttps = () => {
    if (!https) https = createHttps({ ctx, Buffer, http: getHttp(), handles });
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

  /** Set by createCjs once Module is built — Node exports the constructor itself. */
  let ModuleExport = null;

  const implemented = {
    process: () => process,
    buffer: () => (bufferExports ??= bufferModule(Buffer)),
    console: () => console,
    // Node's own lib/path.js, lib/url.js, lib/querystring.js, lib/os.js,
    // lib/punycode.js (src/node-lib).
    path: () => process._nodeLib().path,
    'path/posix': () => process._nodeLib().path.posix,
    'path/win32': () => process._nodeLib().path.win32,
    punycode: () => process._nodeLib().punycode,
    async_hooks: () => (asyncHooks ??= createAsyncHooks()),
    v8: () => (v8 ??= createV8()),
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
      if (bare.startsWith('internal/') && process.execArgv.includes('--expose-internals')) {
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
