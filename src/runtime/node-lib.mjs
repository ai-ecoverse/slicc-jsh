/**
 * Loads dist/vendor/node-lib.cjs (Node v22.22.0's own lib files, see
 * src/node-lib/README.md) with the runtime's versions of the modules they
 * require. Loaded once per realm, eagerly (`events` is Node's) — so what the
 * files need at run time (process, a builtin, the options) is looked up on
 * the program's `process` when they ask.
 */
import { inspect, stripVTControlCharacters } from 'node-inspect-extracted';
import nodeInspect from 'node-inspect-extracted';
import { loadVendorCjs } from './vendor-load.mjs';
import * as errors from './node-errors.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

const proc = () => globalThis.process;

/** internal/options getOptionValue, over process.execArgv (`--x=v` or `--x v`). */
function getOptionValue(name) {
  const argv = proc()?.execArgv ?? [];
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

export function loadNodeLib({ ctx } = {}) {
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
        genericNodeError(message, errorProperties) {
          return Object.assign(new Error(message), errorProperties);
        },
        kEnhanceStackBeforeInspector,
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
        validateString: errors.validateString,
        validateUint32: errors.validateUint32,
      },
      'internal/util': {
        kEmptyObject: Object.freeze({ __proto__: null }),
        SymbolDispose: Symbol.dispose || Symbol.for('nodejs.dispose'),
        SymbolAsyncDispose: Symbol.asyncDispose || Symbol.for('nodejs.asyncDispose'),
        // util.promisify, read when called (util is a builtin).
        get promisify() {
          return builtin('util').promisify;
        },
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
        spliceOne(list, index) {
          for (; index + 1 < list.length; index++) list[index] = list[index + 1];
          list.pop();
        },
      },
      'internal/util/inspect': {
        inspect,
        identicalSequenceRange: nodeInspect.identicalSequenceRange,
        getStringWidth: nodeInspect.getStringWidth,
        stripVTControlCharacters,
      },
      // The platform's EventTarget has none of Node's internals (listener
      // lists, max listeners): events' EventTarget paths see only Node's own.
      'internal/event_target': {
        isEventTarget: (obj) => obj?.constructor?.[kIsEventTarget] === true,
        kEvents,
        kResistStopPropagation: Symbol('kResistStopPropagation'),
      },
      'internal/process/task_queues': { queueMicrotask: (fn) => queueMicrotask(fn) },
      'internal/options': { getOptionValue },
      'internal/streams/utils': lazy(() => ({ isWritable: builtin('stream').isWritable })),
      string_decoder: lazy(() => builtin('string_decoder')),
      timers: lazy(() => builtin('timers')),
      'internal/assert': function assert(value, message) {
        if (!value) throw new Error(message ?? 'Assertion failed');
      },
      'internal/console/global': lazy(() => builtin('console')),
      async_hooks: lazy(() => builtin('async_hooks')),
      os: lazy(() => builtin('os')),
      fs: lazy(() => builtin('fs')),
      path: lazy(() => builtin('path')),
    },
  });
}
