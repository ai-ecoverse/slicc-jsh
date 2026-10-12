'use strict';
/**
 * Node v22.22.0's own lib files that slicc-jsh runs as they are (see
 * README.md), bundled to dist/vendor/node-lib.cjs and evaluated on first use.
 * `internal/errors`, `internal/validators`, `os`, … come from the runtime
 * (src/runtime/node-lib.mjs).
 */
module.exports = {
  tty: require('internal/tty'),
  readlineCallbacks: require('internal/readline/callbacks'),
  warning: require('internal/process/warning'),
};
