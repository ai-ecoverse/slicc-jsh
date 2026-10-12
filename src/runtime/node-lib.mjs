/**
 * Loads dist/vendor/node-lib.cjs (Node v22.22.0's own lib files, see
 * src/node-lib/README.md) with the runtime's versions of the modules they
 * require.
 */
import { loadVendorCjs } from './vendor-load.mjs';
import * as errors from './node-errors.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

export function loadNodeLib({ ctx, process, Buffer, os }) {
  return loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'node-lib',
    globals: { process, Buffer },
    process,
    requires: {
      'internal/errors': { codes: errors.errorCodes(), AbortError: errors.AbortError },
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
