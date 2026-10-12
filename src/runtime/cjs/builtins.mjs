import { createAssert, createAssertStrict } from '../builtins/assert.mjs';
import { createChildProcess } from '../builtins/child-process.mjs';
import { createEvents } from '../builtins/events.mjs';
import { createFs } from '../builtins/fs.mjs';
import { createHttp } from '../builtins/http.mjs';
import { createHttps } from '../builtins/https.mjs';
import { createNet } from '../builtins/net.mjs';
import { createOs } from '../builtins/os.mjs';
import { createQuerystring } from '../builtins/querystring.mjs';
import { createStream, createStreamPromises } from '../builtins/stream.mjs';
import { createStringDecoder } from '../builtins/string-decoder.mjs';
import { createTimersModule, createTimersPromises } from '../builtins/timers-module.mjs';
import { createUrl } from '../builtins/url.mjs';
import { createUtil } from '../builtins/util.mjs';

const BUILTIN_LIST = [
  'assert',
  'assert/strict',
  'buffer',
  'child_process',
  'console',
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
  'process',
  'querystring',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
];

const NOT_YET = [
  'http2',
  'crypto',
  'zlib',
  'readline',
  'tty',
  'worker_threads',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'vm',
  'perf_hooks',
  'async_hooks',
  'inspector',
  'trace_events',
  'v8',
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
/** require('buffer'): Node 22's exports around our Buffer. */
function bufferModule(Buffer) {
  const MAX_LENGTH = 2 ** 53 - 1;
  const MAX_STRING_LENGTH = 536870888;
  const fatal = new TextDecoder('utf-8', { fatal: true });
  const bytesOf = (input) => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const err = new TypeError(
      'The "input" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.'
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  };
  function SlowBuffer(size) {
    return Buffer.allocUnsafeSlow(size);
  }
  return {
    Buffer,
    SlowBuffer,
    transcode(source, fromEnc, toEnc) {
      return Buffer.from(Buffer.from(bytesOf(source)).toString(fromEnc), toEnc);
    },
    isUtf8(input) {
      try {
        fatal.decode(bytesOf(input));
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
  const os = createOs(process.env);
  const url = createUrl();
  const querystring = createQuerystring();
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
  let childProcess;
  const getChildProcess = () => {
    if (!childProcess) {
      childProcess = createChildProcess({ ctx, process, Buffer, handles, getStream });
    }
    return childProcess;
  };

  let bufferExports;

  /** Set by createCjs once Module is built — Node exports the constructor itself. */
  let ModuleExport = null;

  const implemented = {
    process: () => process,
    buffer: () => (bufferExports ??= bufferModule(Buffer)),
    console: () => console,
    path: () => path,
    'path/posix': () => path,
    module: () => ModuleExport,
    fs: () => fs,
    'fs/promises': () => fs.promises,
    events: () => events,
    assert: () => assert,
    'assert/strict': () => assertStrict,
    util: () => util,
    'util/types': () => util.types,
    os: () => os,
    url: () => url,
    querystring: () => querystring,
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
      if (NOT_YET.includes(bare)) notSupported(bare);
      const factory = implemented[bare];
      if (!factory) {
        const err = new Error(`No such built-in module: ${id}`);
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }
      return factory();
    },
  };
}
