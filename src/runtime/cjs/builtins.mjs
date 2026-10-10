/**
 * Builtins available to require() in M1 PR3.
 * fs / assert / events / … land in PR4; unknown Node builtins get a clear error.
 */
export function createBuiltins({ process, Buffer, console, path }) {
  const implemented = {
    process: () => process,
    buffer: () => ({ Buffer, kMaxLength: 0x7fffffff, INSPECT_MAX_BYTES: 50 }),
    console: () => console,
    path: () => path,
    'path/posix': () => path,
  };

  const moduleApi = {
    builtinModules: ['buffer', 'console', 'module', 'path', 'path/posix', 'process'],
    createRequire: null,
    Module: null,
  };
  implemented.module = () => moduleApi;

  return {
    moduleApi,
    has(id) {
      return Object.prototype.hasOwnProperty.call(implemented, id);
    },
    load(id) {
      const factory = implemented[id];
      if (!factory) {
        const err = new Error(
          `No such built-in module: ${id} (not yet implemented in slicc-jsh; see M1 PR4 for fs and friends)`
        );
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }
      return factory();
    },
  };
}
