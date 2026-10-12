/**
 * Loads dist/vendor/node-lib.cjs (Node v22.22.0's own lib files, see
 * src/node-lib/README.md) with the runtime's versions of the modules they
 * require.
 */
import { loadVendorCjs } from './vendor-load.mjs';
import * as errors from './node-errors.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

/** internal/options getOptionValue, over process.execArgv (`--x=v` or `--x v`). */
function optionGetter(process) {
  return function getOptionValue(name) {
    const argv = process.execArgv ?? [];
    const values = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === name) values.push(VALUED.has(name) ? argv[++i] : true);
      else if (a.startsWith(`${name}=`)) values.push(a.slice(name.length + 1));
    }
    if (name === '--disable-warning') return values.filter((v) => typeof v === 'string');
    if (VALUED.has(name)) return values.length ? String(values[values.length - 1]) : '';
    return values.length > 0;
  };
}
const VALUED = new Set(['--disable-warning', '--redirect-warnings', '--diagnostic-dir']);

/**
 * @param {object} o
 * @param {() => object} o.os the os module (lazily)
 * @param {(id: string) => any} o.builtin a builtin module by id (fs, path, console)
 */
export function loadNodeLib({ ctx, process, Buffer, os, builtin }) {
  return loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'node-lib',
    globals: { process, Buffer },
    process,
    requires: {
      'internal/errors': {
        codes: errors.errorCodes(),
        AbortError: errors.AbortError,
        isErrorStackTraceLimitWritable: () => true,
      },
      'internal/options': { getOptionValue: optionGetter(process) },
      'internal/assert': function assert(value, message) {
        if (!value) throw new Error(message ?? 'Assertion failed');
      },
      'internal/console/global': Object.assign(() => builtin('console'), { lazyRequire: true }),
      fs: Object.assign(() => builtin('fs'), { lazyRequire: true }),
      path: Object.assign(() => builtin('path'), { lazyRequire: true }),
      'internal/validators': {
        validateBoolean: errors.validateBoolean,
        validateFunction: errors.validateFunction,
        validateInteger: errors.validateInteger,
        validateInt32: errors.validateInt32,
        validateNumber: errors.validateNumber,
        validateObject: errors.validateObject,
        validateString: errors.validateString,
        validateUint32: errors.validateUint32,
      },
      // Read lazily (win32 only in internal/tty).
      os: Object.assign(() => os(), { lazyRequire: true }),
    },
  });
}
