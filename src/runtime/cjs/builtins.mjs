import { createAssert, createAssertStrict } from '../builtins/assert.mjs';
import { createEvents } from '../builtins/events.mjs';
import { createFs } from '../builtins/fs.mjs';
import { createOs } from '../builtins/os.mjs';
import { createQuerystring } from '../builtins/querystring.mjs';
import { createStream } from '../builtins/stream.mjs';
import { createStringDecoder } from '../builtins/string-decoder.mjs';
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
  'module',
  'os',
  'path',
  'path/posix',
  'process',
  'querystring',
  'stream',
  'string_decoder',
  'url',
  'util',
  'util/types',
];

/**
 * Builtins available to require() in M1.
 */
export function createBuiltins({ ctx, process, Buffer, console, path }) {
  const fs = createFs({ ctx, path, process, Buffer });
  const util = createUtil();
  const events = createEvents();
  const assert = createAssert();
  const assertStrict = createAssertStrict();
  const os = createOs(process.env);
  const url = createUrl();
  const querystring = createQuerystring();
  const stringDecoder = createStringDecoder();
  const stream = createStream();

  const moduleApi = {
    builtinModules: [...BUILTIN_LIST],
    createRequire: null,
    Module: null,
  };

  const implemented = {
    process: () => process,
    buffer: () => ({ Buffer, kMaxLength: 0x7fffffff, INSPECT_MAX_BYTES: 50 }),
    console: () => console,
    path: () => path,
    'path/posix': () => path,
    module: () => moduleApi,
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
    stream: () => stream,
  };

  return {
    moduleApi,
    has(id) {
      return Object.prototype.hasOwnProperty.call(implemented, id);
    },
    load(id) {
      const factory = implemented[id];
      if (!factory) {
        const err = new Error(`No such built-in module: ${id}`);
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }
      return factory();
    },
  };
}
