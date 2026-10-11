import { createAssert, createAssertStrict } from '../builtins/assert.mjs';
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
  'child_process',
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
    if (!https) https = createHttps({ ctx, Buffer, http: getHttp() });
    return https;
  };

  /** Set by createCjs once Module is built — Node exports the constructor itself. */
  let ModuleExport = null;

  const implemented = {
    process: () => process,
    buffer: () => ({ Buffer, kMaxLength: 0x7fffffff, INSPECT_MAX_BYTES: 50 }),
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
