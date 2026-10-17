/**
 * node:inspector and node:inspector/promises — Node 22.22.0's surface
 * (lib/inspector.js, lib/inspector/promises.js), so a package that requires
 * the inspector at load (playwright-core, @vitest/coverage-v8) loads. The
 * kernel has no V8 inspector for a program's own isolate, so jsh is a Node
 * whose inspector is never active: url() is undefined, waitForDebugger is
 * ERR_INSPECTOR_NOT_ACTIVE, a Session that was never connected posts
 * ERR_INSPECTOR_NOT_CONNECTED, and what would start one (open(),
 * Session#connect()) throws ERR_NOT_SUPPORTED when it is called.
 */
import { EventEmitter } from './events.mjs';
import {
  nodeError,
  validateFunction,
  validateInt32,
  validateObject,
  validateString,
} from '../node-errors.mjs';

function notSupported(what) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (no inspector in the kernel)`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

const CONSOLE_METHODS = [
  'debug', 'error', 'info', 'log', 'warn', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed',
  'groupEnd', 'clear', 'count', 'countReset', 'assert', 'profile', 'profileEnd', 'time', 'timeLog', 'timeEnd',
  'timeStamp', 'context',
];

// internal/net isLoopback.
const isLoopback = (host) => {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h.startsWith('127.') || h.startsWith('[::1]') || h.startsWith('[0:0:0:0:0:0:0:1]');
};

export function createInspector({ process, promisify }) {
  class Session extends EventEmitter {
    #connected = false;

    /** Connects the session to the inspector back-end: there's none in the kernel. */
    connect() {
      if (this.#connected) {
        throw nodeError(Error, 'ERR_INSPECTOR_ALREADY_CONNECTED', 'The inspector session is already connected');
      }
      throw notSupported('inspector.Session.connect');
    }

    connectToMainThread() {
      // jsh runs on the main thread only.
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    }

    post(method, params, callback) {
      validateString(method, 'method');
      if (!callback && typeof params === 'function') {
        callback = params;
        params = null;
      }
      if (params) validateObject(params, 'params');
      if (callback) validateFunction(callback, 'callback');
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');
    }

    disconnect() {}
  }

  function inspectorOpen(port, host, wait) {
    void wait;
    if (Number.isInteger(port) && port >= 0 && port <= 0xffffffff) validateInt32(port, 'port', 0, 65535);
    if (host && !isLoopback(host)) {
      process?.emitWarning?.(
        'Binding the inspector to a public IP with an open port is insecure, ' +
          'as it allows external hosts to connect to the inspector ' +
          'and perform a remote code execution attack. ' +
          'Documentation can be found at ' +
          'https://nodejs.org/api/cli.html#--inspecthostport',
        'SecurityWarning'
      );
    }
    throw notSupported('inspector.open');
  }

  function inspectorWaitForDebugger() {
    throw nodeError(Error, 'ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
  }

  // No frontend: the inspector's console and protocol events go nowhere.
  const inspectorConsole = {};
  for (const name of CONSOLE_METHODS) inspectorConsole[name] = { [name]() {} }[name];

  function broadcastToFrontend(eventName, params = {}) {
    validateString(eventName, 'eventName');
    validateObject(params, 'params');
  }
  const Network = {};
  for (const name of ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed', 'dataSent', 'dataReceived']) {
    Network[name] = { [name]: (params) => broadcastToFrontend(`Network.${name}`, params) }[name];
  }

  const NetworkResources = {
    put(url, data) {
      const argv = process?._options ?? process?.execArgv ?? [];
      if (!argv.includes('--experimental-inspector-network-resource')) {
        process?.emitWarning?.(
          'The --experimental-inspector-network-resource option is not enabled. ' +
            'Please enable it to use the putNetworkResource function'
        );
        return;
      }
      validateString(url, 'url');
      validateString(data, 'data');
    },
  };

  const inspector = {
    open: inspectorOpen,
    close: function _debugEnd() {},
    url: function url() {
      return undefined;
    },
    waitForDebugger: inspectorWaitForDebugger,
    console: inspectorConsole,
    Session,
    Network,
    NetworkResources,
  };

  class PromiseSession extends Session {}
  Object.defineProperty(PromiseSession, 'name', { value: 'Session' });
  Object.defineProperty(PromiseSession.prototype, 'post', {
    value: promisify(Session.prototype.post),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const promises = { ...inspector, Session: PromiseSession };
  return { inspector, promises };
}
