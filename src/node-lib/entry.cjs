'use strict';
/**
 * Node v22.22.0's own lib files that slicc-jsh runs as they are (see
 * README.md), bundled to dist/vendor/node-lib.cjs. `events` is evaluated
 * with the bundle, at start; the rest on first use (their top-level
 * requires of builtins need the module loader to exist).
 * `internal/errors`, `internal/validators`, `os`, … come from the runtime
 * (src/runtime/node-lib.mjs).
 */
let consoleReady = false;

module.exports = {
  events: require('events'),
  get tty() {
    return require('internal/tty');
  },
  get readlineCallbacks() {
    return require('internal/readline/callbacks');
  },
  get warning() {
    return require('internal/process/warning');
  },
  get readline() {
    return require('readline');
  },
  get path() {
    return require('path');
  },
  get url() {
    return require('url');
  },
  get querystring() {
    return require('querystring');
  },
  get os() {
    return require('os');
  },
  get punycode() {
    return require('punycode');
  },
  get util() {
    return require('util');
  },
  /** The global console (Node's), its streams the program's process.stdout / stderr, bound lazily. */
  consoleFor(proc) {
    const globalConsole = require('internal/console/global');
    if (!consoleReady) {
      consoleReady = true;
      // Node's bootstrap: NODE_DEBUG for util.debuglog.
      require('internal/util/debuglog').initializeDebugEnv(proc.env.NODE_DEBUG);
      globalConsole[require('internal/console/constructor').kBindStreamsLazy](proc);
      // What V8's own console adds to Node's (the inspector's methods; no
      // inspector here, so they do nothing).
      const noop = () => {};
      for (const name of ['profile', 'profileEnd', 'timeStamp']) {
        if (!(name in globalConsole)) {
          Object.defineProperty(globalConsole, name, { value: { [name]() {} }[name], writable: true, enumerable: true, configurable: true });
        }
      }
      if (!('context' in globalConsole)) {
        Object.defineProperty(globalConsole, 'context', {
          value: function context() {
            const c = {};
            for (const k of Object.keys(globalConsole)) if (typeof globalConsole[k] === 'function' && k !== 'Console') c[k] = noop;
            return c;
          },
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (!('createTask' in globalConsole)) {
        Object.defineProperty(globalConsole, 'createTask', {
          value: function createTask() {
            return { run: (fn) => fn() };
          },
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return globalConsole;
  },
  get readlinePromises() {
    return require('readline/promises');
  },
  /**
   * node --expose-internals: an internal module by id — one of the lib
   * files carried here, else what the runtime hands in (internal/util/inspect,
   * internal/errors, …), else undefined.
   */
  internal(id) {
    switch (id) {
      case 'internal/tty':
        return require('internal/tty');
      case 'internal/readline/callbacks':
        return require('internal/readline/callbacks');
      case 'internal/readline/utils':
        return require('internal/readline/utils');
      case 'internal/readline/interface':
        return require('internal/readline/interface');
      case 'internal/readline/emitKeypressEvents':
        return require('internal/readline/emitKeypressEvents');
      case 'internal/readline/promises':
        return require('internal/readline/promises');
      case 'internal/process/warning':
        return require('internal/process/warning');
      case 'internal/events/abort_listener':
        return require('internal/events/abort_listener');
      case 'internal/events/symbols':
        return require('internal/events/symbols');
      case 'internal/fixed_queue':
        return require('internal/fixed_queue');
      case 'internal/util/parse_args/parse_args':
        return require('internal/util/parse_args/parse_args');
      case 'internal/mime':
        return require('internal/mime');
      case 'internal/util/diff':
        return require('internal/util/diff');
      case 'internal/util/types':
        return require('internal/util/types');
      case 'internal/util/colors':
        return require('internal/util/colors');
      case 'internal/util/debuglog':
        return require('internal/util/debuglog');
      case 'internal/cli_table':
        return require('internal/cli_table');
      case 'internal/console/constructor':
        return require('internal/console/constructor');
      case 'internal/querystring':
        return require('internal/querystring');
      case 'internal/constants':
        return require('internal/constants');
      default:
        try {
          return runtimeRequire(id);
        } catch {
          return undefined;
        }
    }
  },
};

// The bundle's own require (left to the runtime's map for unknown ids).
function runtimeRequire(id) {
  return require(id);
}
