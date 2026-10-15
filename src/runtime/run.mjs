import { initSourceMaps } from './source-maps.mjs';
import { installProcessMembers } from './process-members.mjs';
import { installCredentials } from './process-credentials.mjs';
import { installJshHandoff } from '../jsh/kernel.mjs';
import { drainLoop, trackPromise } from './async-handles.mjs';
import nodeInspect from 'node-inspect-extracted';
import { createBuffer } from './buffer.mjs';
import { createUtil } from './builtins/util.mjs';
import { createCjs } from './cjs/loader.mjs';
import { inputTypeOf, parseNodeArgv } from './cli.mjs';
import { nodeError } from './node-errors.mjs';
import { createEsm } from './esm/loader.mjs';
import { rewriteDynamicImports, shouldRunAsEsm } from './esm/transform.mjs';
import { formatUncaughtError, formatUnhandledRejection } from './errors-format.mjs';
import { isExitError } from './exit.mjs';
import { realMainPath } from './realpath.mjs';
import { createHandleTable } from './handles.mjs';
import { createNextTick } from './next-tick.mjs';
import { createProcess, NODE_SHIM_VERSION } from './process.mjs';
import { probeStdio } from './stdio.mjs';
import { installFunctionImport } from './function-import.mjs';
import { patchReplServer } from './node-lib.mjs';
import { checkSyntax, syntaxReport } from './syntax-report.mjs';
import { installStackPrepare } from './stack.mjs';
import { createTimers } from './timers.mjs';
import { createFetch } from './web/fetch.mjs';
import { createWebSocket } from './web/websocket.mjs';
import { createBroadcastChannel } from './web/broadcast-channel.mjs';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

let TrackingProxy;
function trackingProxy() {
  if (!TrackingProxy) {
    TrackingProxy = nodeInspect.Proxy;
    Object.defineProperty(TrackingProxy, 'name', { value: 'Proxy' });
  }
  return TrackingProxy;
}

const decoder = new TextDecoder();

/**
 * Install jsh bindings on globalThis (slicc-kernel Node-entry lockdown).
 * Writable slots: process, Buffer, global, setImmediate, clearImmediate, fetch,
 * WebSocket (OPEN_SLOTS since kernel 1.53.0). console / web timers are left alone
 * by the kernel — we still overwrite them for Node-shaped console + ref/unref
 * timers. require/module/exports/__filename/__dirname stay fixed undefined.
 */
function installJshGlobals(bindings) {
  const saved = new Map();
  for (const name of Object.keys(bindings)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  for (const [name, value] of Object.entries(bindings)) {
    try {
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {
      try {
        globalThis[name] = value;
      } catch {
        /* non-configurable lockdown slots (require/module/…) */
      }
    }
  }
  return () => {
    for (const [name, desc] of saved) {
      try {
        if (desc === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, desc);
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Platform promises that settle on work outside JS (WebCrypto, WebAssembly
 * compilation) keep the program alive while pending, as Node's thread-pool
 * requests do. Returns the undo.
 */
function trackPlatformAsync(handles) {
  const undo = [];
  const wrap = (target, names) => {
    if (!target) return;
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      try {
        target[name] = function tracked(...args) {
          return trackPromise(handles, original.apply(this, args));
        };
        undo.push(() => {
          target[name] = original;
        });
      } catch {
        /* read-only: leave it */
      }
    }
  };
  wrap(globalThis.SubtleCrypto?.prototype, [
    'decrypt',
    'deriveBits',
    'deriveKey',
    'digest',
    'encrypt',
    'exportKey',
    'generateKey',
    'importKey',
    'sign',
    'unwrapKey',
    'verify',
    'wrapKey',
  ]);
  wrap(globalThis.WebAssembly, ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']);
  return () => {
    for (const fn of undo.reverse()) fn();
  };
}

/**
 * Run the node CLI against a JsProgramContext. Resolves with an exit status.
 *
 * `options.main`, when given, replaces the script/eval entry: it is called
 * with the runtime (process, console, Buffer, CJS and ESM loaders, fetch)
 * once everything is installed, and the program then ends as a script does
 * (event loop, exit codes, uncaught errors). The kernel `jsh` uses it.
 */
export async function runNode(ctx, options = {}) {
  installStackPrepare();
  const handles = createHandleTable();
  const nextTick = createNextTick();
  let exitStatus;
  let lastEvalCode;
  let restoreGlobals = () => {};
  let removeJshHandoff = () => {};
  const removeCtxHooks = [];
  const util = createUtil();
  // Set while the error being reported comes from an ES module entry.
  let uncaughtFromEsm = false;
  const printUncaught = (err) => {
    const { body } = formatUncaughtError(err, {
      ctx,
      util,
      version: NODE_SHIM_VERSION,
      evalCode: lastEvalCode,
      esmEntry: uncaughtFromEsm,
    });
    // process.report.reportOnUncaughtException: Node writes the report
    // between the error and its `Node.js v…` line.
    const trailer = `\nNode.js v${NODE_SHIM_VERSION}\n`;
    const report = processRef?._reportUncaught;
    if (typeof report !== 'function' || !body.endsWith(trailer)) {
      writeStderr(body);
      return;
    }
    const printed = body.slice(0, -trailer.length);
    writeStderr(printed);
    try {
      report(err, printed);
    } catch {
      /* the report is best effort, as Node's */
    }
    writeStderr(trailer);
  };
  /**
   * `--check` of CommonJS that has module syntax: Node's enrichCJSError
   * warns, synchronously, before the SyntaxError is reported.
   */
  const warnCheckedEsm = (kind, source, filename) => {
    if (kind !== 'commonjs' || !(shouldRunAsEsm(source) || checkSyntax(source, { kind, filename })?.wrapperRedeclare)) return;
    if ((processRef?._options ?? []).includes('--no-warnings')) return;
    writeStderr(
      `(node:${processRef?.pid ?? ctx.pid}) Warning: Failed to load the ES module: ${filename}. ` +
        'Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.\n' +
        '(Use `node --trace-warnings ...` to show where the warning was created)\n'
    );
  };
  /**
   * The program ends on an uncaught error (Node's triggerUncaughtException):
   * the 'exit' listeners run first, with 1, then the report prints — not at
   * all if a listener called process.exit(), whose silence covers it.
   * Returns the status the listeners leave.
   */
  let finishExitRef;
  let nextTickRef;
  const dieUncaught = (report, status = 1) => {
    const code = finishExitRef(status);
    try {
      report();
    } catch {
      /* ignore */
    }
    // The program is over: no tick queued before or during this runs (Node).
    nextTickRef?.stop();
    return code;
  };

  /**
   * An uncaught exception goes to process.setUncaughtExceptionCaptureCallback's
   * callback, else to 'uncaughtException' listeners (the thrown value as is,
   * with origin 'uncaughtException'). False when nothing takes it.
   */
  let processRef;
  // The REPL's domain (see runRepl): what nothing else takes is its error,
  // as Node's domains route a callback's throw to the REPL that started it.
  let replDomain = null;
  const handleUncaught = (err, origin = 'uncaughtException') => {
    const p = processRef;
    const capture = typeof p?._uncaughtCapture === 'function';
    if (!capture && !(p && p.listenerCount('uncaughtException') > 0)) {
      if (!replDomain) return false;
      try {
        replDomain._errorHandler(err);
      } catch (handlerError) {
        if (isExitError(handlerError)) throw handlerError;
        return false;
      }
      return true;
    }
    try {
      if (capture) p._uncaughtCapture(err);
      else p.emit('uncaughtException', err, origin);
    } catch (handlerError) {
      if (isExitError(handlerError)) throw handlerError;
      // Node: a handler that throws is fatal, reported as itself, status 7.
      exitStatus = dieUncaught(() => printUncaught(handlerError), 7);
      try {
        timers.stop();
        ctx.exit?.(exitStatus);
      } catch {
        /* JsExit */
      }
    }
    return true;
  };

  // NODE_OPTIONS first, as Node reads it.
  const parsed = parseNodeArgv([...ctx.argv], { nodeOptions: ctx.env?.NODE_OPTIONS });
  if (parsed.error) {
    await ctx.write(2, `${parsed.error}\n`);
    return parsed.status ?? 9;
  }
  if (parsed.v8Warnings?.length) await ctx.write(2, `${parsed.v8Warnings.join('\n')}\n`);
  if (parsed.mode === 'version') {
    await ctx.write(1, `v${NODE_SHIM_VERSION}\n`);
    return 0;
  }
  if (parsed.mode === 'help') {
    await ctx.write(
      1,
      `Usage: node [options] [ script.js ] [arguments]\n` +
        `       node -e "code" / node -p "expr"\n` +
        `slicc-jsh ${NODE_SHIM_VERSION} (Node-compatible, abi: js)\n`
    );
    return 0;
  }

  const Buffer = createBuffer();
  // Terminal, file or pipe, for process.stdin/stdout/stderr (Node knows it
  // synchronously; the kernel answers asynchronously, so ask up front).
  const [stdio, ppid] = await Promise.all([
    probeStdio(ctx),
    Promise.resolve(typeof ctx.ppid === 'function' ? ctx.ppid() : ctx.ppid).catch(() => undefined),
  ]);

  const {
    process,
    writeStdout,
    writeStderr,
    getExitCode,
    getDidExit,
    emitBeforeExit,
    finishExit,
  } = createProcess({
    ctx,
    argv: parsed.processArgv,
    nextTick,
    handles,
    Buffer,
    stdio,
    ppid,
    onExit: (code) => {
      exitStatus = code;
    },
    // process.exit(): nothing the unwinding code schedules may run.
    onHardExit: () => {
      timers.stop();
      nextTick.stop();
      handles.notify();
    },
  });
  installCredentials(process);
  installProcessMembers(process, {
    flushTicks: () => flushTicks(),
    handleUncaught: (err, origin) => handleUncaught(err, origin),
    preload: parsed.preload ?? [],
  });
  finishExitRef = finishExit;
  nextTickRef = nextTick;
  processRef = process;
  process.execArgv = parsed.execArgv ? [...parsed.execArgv] : [];
  // Node's argv[0] is always its executable's path; argv0 keeps the name it
  // was run as (a spawn's argv0 included). (A .jsh script's argv[0] stays jsh.)
  if (!options.main && process.argv.length > 0) process.argv[0] = process.execPath;
  // The options in effect: NODE_OPTIONS' and the command line's (only these
  // are execArgv). What the runtime reads for its behaviour.
  process._options = Object.freeze([...(parsed.options ?? process.execArgv)]);
  // --report-on-signal / --report-uncaught-exception: process.report from the start.
  if (process._options.some((o) => /^--report-(on-signal|uncaught-exception|signal)(=|$)/.test(o))) void process.report;
  {
    let title;
    for (let i = 0; i < process._options.length; i++) {
      const o = process._options[i];
      if (o === '--title') title = process._options[++i];
      else if (o.startsWith('--title=')) title = o.slice(8);
    }
    if (title !== undefined) process.title = title;
  }
  initSourceMaps(process);
  process._setupWarnings();
  // Node ignores SIGPIPE from the start: a write to a pipe with no reader
  // fails with EPIPE instead of ending the program.
  try {
    Promise.resolve(ctx.signals?.ignore?.('SIGPIPE')).catch(() => {});
  } catch {
    /* no signals */
  }
  // Node takes SIGUSR1 for its inspector, so it never ends the program; there
  // is no inspector here: ignored.
  try {
    Promise.resolve(ctx.signals?.ignore?.('SIGUSR1')).catch(() => {});
  } catch {
    /* no signals */
  }
  if (parsed.mode === 'eval') {
    process._evalCode = parsed.code;
    lastEvalCode = parsed.code;
  }

  // Node's own console (lib/internal/console), on process.stdout / stderr.
  const console = process._nodeLib().consoleFor(process);
  const fetch = createFetch(ctx, { handles, getHttp: () => process._builtin('http') });
  const restorePlatform = trackPlatformAsync(handles);
  const WebSocket = createWebSocket(ctx, { handles, trackPromise, getNet: () => process._builtin('net') });
  // Node's BroadcastChannel, in-process, where the kernel leaves the slot
  // writable and empty (slicc-kernel 1.92.0+). The platform's is never used.
  // (worker_threads exports it on every kernel.)
  const bcSlot = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  const delivering = { active: false, since: 0, overdue: () => timers.overdue() };
  const JshBroadcastChannel = createBroadcastChannel({
    handles,
    schedule: (fn) => timers.setImmediate(fn),
    delivering,
  });
  const BroadcastChannel =
    bcSlot && bcSlot.value === undefined && !bcSlot.get && (bcSlot.writable || bcSlot.configurable) ? JshBroadcastChannel : undefined;
  process._broadcastChannel = JshBroadcastChannel;

  const timers = createTimers(handles, {
    hold: (due) => delivering.active && due > delivering.since,
    afterCallback: () => flushTicks(),
    onCallbackError: (err) => {
      if (isExitError(err) || getDidExit()) {
        exitStatus = getDidExit() ? getExitCode() : err.code;
        timers.clearPending();
        // Wake drainLoop so shouldStop can end the process while servers listen.
        try {
          handles.notify();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        if (handleUncaught(err)) return;
      } catch {
        /* fall through */
      }
      exitStatus = dieUncaught(() => printUncaught(err));
      timers.clearPending();
    },
  });
  // A signal handler runs from the loop, as an immediate (its throw is an
  // uncaught exception, handled as a timer callback's).
  // Like Node's signal handles it doesn't keep the loop alive: a signal
  // still pending when nothing else is left goes unhandled, as there.
  let loopEnded = false;
  process._dispatchSignal = (fn) =>
    timers
      .setImmediate(() => {
        if (!loopEnded) fn();
      })
      .unref();

  // Pre-#297 fallback: host process may still exist before we overwrite globalThis.
  const hostProcess = globalThis.process;

  // Install jsh globals into lockdown writable slots (+ console/timers left alone).
  restoreGlobals = installJshGlobals({
    process,
    Buffer,
    console,
    global: globalThis,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
    fetch,
    WebSocket,
    ...(BroadcastChannel ? { BroadcastChannel } : {}),
    // A Proxy that remembers its target and handler (node-inspect-extracted's),
    // so util.types.isProxy and inspect's showProxy / <Revoked Proxy> are Node's.
    Proxy: trackingProxy(),
  });

  const fatal = (err) => {
    exitStatus = dieUncaught(() => printUncaught(err));
    // Before ctx.exit: the kernel ends the process on a timer of its own.
    timers.stop();
    try {
      ctx.exit?.(exitStatus);
    } catch {
      /* JsExit unwinds */
    }
  };
  const isExit = (err) => isExitError(err) || getDidExit();
  const rejectionHandler = (reason, promise) => {
    // process.exit() from a WebSocket/EventTarget handler throws NodeExitError
    // after _recordExit; treat it as a clean exit (Node: rc from exit(), no dump).
    if (isExit(reason)) {
      exitStatus = getDidExit() ? getExitCode() : Number(reason.code) & 0xff;
      timers.clearPending();
      try {
        handles.notify();
      } catch {
        /* ignore */
      }
      return;
    }
    if (process.listenerCount('unhandledRejection') > 0) {
      process.emit('unhandledRejection', reason, promise ?? Promise.resolve());
      return;
    }
    // Node's default (--unhandled-rejections=throw): the rejection is raised
    // as an uncaught exception first, which a capture callback or an
    // 'uncaughtException' listener (origin 'unhandledRejection') may take.
    if (handleUncaught(rejectionError(reason), 'unhandledRejection')) return;
    const { body } = formatUnhandledRejection(reason, {
      ctx,
      util,
      version: NODE_SHIM_VERSION,
      evalCode: lastEvalCode,
    });
    exitStatus = dieUncaught(() => writeStderr(body));
    timers.stop();
    try {
      ctx.exit?.(exitStatus);
    } catch {
      /* JsExit */
    }
  };
  /** Node's throwUnhandledRejectionsMode: the reason itself if error-like, else an UnhandledPromiseRejection. */
  const rejectionError = (reason) => {
    if (typeof reason === 'object' && reason !== null && Object.prototype.hasOwnProperty.call(reason, 'stack')) return reason;
    let short;
    try {
      short = typeof reason === 'object' && reason !== null ? '#<Object>' : String(reason);
    } catch {
      short = '[object]';
    }
    class UnhandledPromiseRejection extends Error {
      code = 'ERR_UNHANDLED_REJECTION';
    }
    const err = new UnhandledPromiseRejection(
      'This error originated either by throwing inside of an async function without a catch block, ' +
        `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${short}".`
    );
    Object.defineProperty(err, 'name', { value: 'UnhandledPromiseRejection', configurable: true, writable: true });
    err.stack =
      `UnhandledPromiseRejection: ${err.message}\n` +
      '    at throwUnhandledRejectionsMode (node:internal/process/promises:392:7)\n' +
      '    at processPromiseRejections (node:internal/process/promises:475:17)\n' +
      '    at process.processTicksAndRejections (node:internal/process/task_queues:106:32)';
    return err;
  };
  /**
   * Run the queued ticks. One that throws is an uncaught exception; once it is
   * handled, the rest of the queue runs on before any promise job, as in
   * Node (processTicksAndRejections goes on with the queue).
   */
  const flushTicks = () => {
    for (;;) {
      try {
        nextTick.flushSync();
        return;
      } catch (err) {
        if (isExitError(err) || !handleUncaught(err)) throw err;
      }
    }
  };
  const exceptionHandler = (err) => {
    if (isExit(err)) {
      exitStatus = getDidExit() ? getExitCode() : Number(err.code) & 0xff;
      timers.clearPending();
      try {
        handles.notify();
      } catch {
        /* ignore */
      }
      return;
    }
    if (handleUncaught(err)) return;
    fatal(err);
  };  // diagnostics_channel's triggerUncaughtException (node-bindings.mjs): a
  // subscriber's throw, handled as any uncaught exception, at once.
  Object.defineProperty(process, '_triggerUncaught', { value: (err) => exceptionHandler(err), configurable: true });


  // #297: prefer ctx.onUncaught / ctx.onUnhandledRejection. While registered, the
  // kernel skips its default (status 1 + message). Fall back to host process /
  // window events on older kernels.
  if (typeof ctx.onUnhandledRejection === 'function') {
    removeCtxHooks.push(
      ctx.onUnhandledRejection((error, promise) => {
        rejectionHandler(error, promise);
      })
    );
  }
  if (typeof ctx.onUncaught === 'function') {
    removeCtxHooks.push(
      ctx.onUncaught((error) => {
        exceptionHandler(error);
      })
    );
  }
  if (removeCtxHooks.length === 0) {
    if (hostProcess && typeof hostProcess.removeAllListeners === 'function') {
      hostProcess.removeAllListeners('unhandledRejection');
      hostProcess.removeAllListeners('uncaughtException');
      hostProcess.on('unhandledRejection', rejectionHandler);
      hostProcess.on('uncaughtException', exceptionHandler);
    } else if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('unhandledrejection', (ev) => {
        try {
          ev.preventDefault?.();
        } catch {
          /* ignore */
        }
        rejectionHandler(ev.reason);
      });
    }
  }

  const cjs = createCjs({
    ctx,
    process,
    Buffer,
    console,
    timers,
    handles,
    fetch,
    WebSocket,
  });
  const nodeRequire = cjs.makeRequire(`${process.cwd()}/`);
  const esm = createEsm({
    ctx,
    process,
    handles,
    builtins: {
      load: (id) => nodeRequire(`node:${id}`),
    },
    cjs,
    trackPromise,
  });
  // Sync require() of .mjs / "type":"module" — returns the ESM namespace object.
  cjs.setRequireEsmHook((filename, parentFilename) => esm.requireEsm(filename, parentFilename));
  // Dynamic import() inside CommonJS files — resolve relative to the CJS file.
  cjs.setImportModuleHook((specifier, parent, options) => esm.importDynamic(specifier, parent, options));
  // import() inside new Function / AsyncFunction bodies (see function-import.mjs).
  const restoreFunctionImport = installFunctionImport({
    // (importDynamic keeps the program alive while it is pending.)
    importFrom: (specifier, referrer, options) => esm.importDynamic(specifier, referrer, options),
    cwd: () => process.cwd(),
  });
  // The program's loader for vm scripts (USE_MAIN_CONTEXT_DEFAULT_LOADER) and the REPL.
  Object.defineProperty(process, '_importFrom', {
    value: (specifier, referrer, options) => esm.importDynamic(specifier, referrer, options),
    configurable: true,
    writable: true,
  });

  /**
   * Node's internal/main/repl.js: the banner, then lib/internal/repl.js's
   * createInternalRepl (history from NODE_REPL_HISTORY, NODE_REPL_MODE, …);
   * its 'exit' ends the program. A status to return when it can't start.
   */
  const startRepl = () => {
    if (inputTypeOf(process._options)) {
      console.error('Cannot specify --input-type for REPL');
      return 9;
    }
    console.log(`Welcome to Node.js ${process.version}.\nType ".help" for more information.`);
    const cliRepl = process._nodeLib().repl;
    patchReplServer(cliRepl.REPLServer);
    cliRepl.createInternalRepl(process.env, (err, repl) => {
      if (err) throw err;
      repl.on('exit', () => {
        if (repl._flushing) {
          repl.pause();
          return repl.once('flushHistory', () => {
            process.exit();
          });
        }
        process.exit();
      });
    });
    // lib/repl.js keeps the standalone REPL as its `repl` export.
    replDomain = cliRepl.repl?._domain ?? null;
    return undefined;
  };

  /**
   * The entry promise: a `.jsh` body or an ES module's top-level await. It
   * runs alongside the event loop (ticks and timers keep going while it is
   * pending) and, as in Node, does not keep the program alive on its own.
   * A `.jsh` body that never settles ends the program like an empty loop
   * (Node's CommonJS); an ES module's unsettled top-level await exits 13.
   */
  let entry = null;
  const setEntry = (promise, kind) => {
    const current = { kind, pending: true, promise };
    entry = current;
    Promise.resolve(promise).then(
      () => {
        current.pending = false;
        handles.notify();
      },
      (err) => {
        current.pending = false;
        if (kind === 'jsh') rejectionHandler(err, promise);
        else {
          uncaughtFromEsm = kind === 'esm';
          try {
            exceptionHandler(err);
          } finally {
            uncaughtFromEsm = false;
          }
        }
        handles.notify();
      }
    );
  };

  try {
    // What `options.main` and the kernel jsh handoff (see jsh/kernel.mjs) run on.
    const rt = {
      setEntry,
      track: (promise) => trackPromise(handles, promise),
      process,
      console,
      Buffer,
      fetch,
      createRequire: cjs.createRequire,
      importModule: (specifier, parent, options) => esm.importDynamic(specifier, parent, options),
      rewriteDynamicImports,
    };
    removeJshHandoff = installJshHandoff(ctx, rt);
    let skipEntry = false;
    // V8's --stack-trace-limit=N.
    const limit = process._options.findLast?.((a) => a.startsWith('--stack-trace-limit='));
    if (limit) Error.stackTraceLimit = Number(limit.slice(20));
    // node -r / --require: loaded first, in order, as Node's preload modules.
    if (typeof options.main !== 'function') {
      for (const request of parsed.preload ?? []) {
        try {
          cjs.preload(request);
          flushTicks();
        } catch (err) {
          if (isExitError(err)) throw err;
          if (!handleUncaught(err)) return dieUncaught(() => printUncaught(err));
        }
      }
      // --import: ES modules from the working directory, in order, before the
      // entry, with the loop running (as Node's runEntryPointWithESMLoader).
      // One that fails ends startup (the entry doesn't run; a handler that
      // took the error leaves the loop to drain); one whose top-level await
      // never settles leaves the loop to end, and the entry never runs.
      if (parsed.imports?.length) {
        let settled = false;
        let failure;
        (async () => {
          for (const specifier of parsed.imports) await esm.importPreload(specifier);
        })().then(
          () => {
            settled = true;
            handles.notify();
          },
          (err) => {
            settled = true;
            failure = { err };
            handles.notify();
          }
        );
        await drainLoop(handles, nextTick, {
          shouldStop: () => settled || getDidExit() || exitStatus !== undefined,
          weakPending: () => !settled,
          onTickError: (err) => exceptionHandler(err),
        });
        if (!settled || failure) skipEntry = true;
        if (failure) {
          if (isExitError(failure.err)) throw failure.err;
          uncaughtFromEsm = true;
          try {
            if (!handleUncaught(failure.err)) return dieUncaught(() => printUncaught(failure.err));
          } finally {
            uncaughtFromEsm = false;
          }
        }
        if (getDidExit() || exitStatus !== undefined) skipEntry = true;
      }
    }
    if (skipEntry) {
      // --import ended startup: no entry.
    } else if (typeof options.main === 'function') {
      try {
        const result = options.main(rt);
        if (result != null && typeof result.then === 'function') {
          // The tracking promise settles like `result`; its rejection is
          // handled below through `await result`.
          trackPromise(handles, result).catch(() => {});
          await result;
        }
        flushTicks();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (handleUncaught(err)) {
          uncaughtFromEsm = false;
        } else {
          return dieUncaught(() => printUncaught(err));
        }
      }
    } else if (parsed.mode === 'empty' && !parsed.check && !parsed.stdinScript && (parsed.interactive || process.stdin.isTTY)) {
      // Node's REPL: no script, and stdin a terminal (or -i).
      const status = startRepl();
      if (status !== undefined) return status;
    } else if (parsed.mode === 'empty') {
      // Node: `echo '…' | node` runs the piped script as the main module ([stdin]).
      const chunks = [];
      try {
        if (ctx.stdin && typeof ctx.stdin.getReader === 'function') {
          const reader = ctx.stdin.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
          }
        } else if (typeof ctx.read === 'function') {
          for (;;) {
            const chunk = await ctx.read(0);
            if (!chunk || chunk.byteLength === 0) break;
            chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
          }
        }
      } catch {
        /* EOF / no stdin */
      }
      // Nothing piped: no program, but what -r loaded still runs its loop.
      if (chunks.length === 0 && !(parsed.preload?.length > 0) && !(parsed.imports?.length > 0)) return 0;
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const source = decoder.decode(merged);
      lastEvalCode = source;
      process._evalCode = source;
      // `node -` keeps its `-`; piped input with no argument is [stdin].
      if (!parsed.stdinScript) process.argv[1] = '[stdin]';
      const inputType = inputTypeOf(process._options);
      if (parsed.check) {
        // Node checks piped input as CommonJS unless --input-type=module.
        const kind = inputType === 'module' ? 'module' : 'commonjs';
        const error = checkSyntax(source, { kind, filename: '[stdin]' });
        if (error) {
          warnCheckedEsm(kind, source, '[stdin]');
          return dieUncaught(() => printUncaught(error));
        }
        return 0;
      }
      const asEsm = inputType ? inputType === 'module' : shouldRunAsEsm(source);
      try {
        if (asEsm) {
          uncaughtFromEsm = true;
          const result = esm.runEsmEval(source, `${process.cwd().replace(/\/$/, '')}/[eval1]`);
          uncaughtFromEsm = false;
          if (result != null && typeof result.then === 'function') setEntry(result, 'esm');
        } else {
          // Node: __filename is `[stdin]`; require.main is unset for piped scripts.
          cjs.runMain('[stdin]', source, { setMain: false });
        }
        flushTicks();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (handleUncaught(err)) {
          uncaughtFromEsm = false;
        } else {
          return dieUncaught(() => printUncaught(err));
        }
      }
    } else if (parsed.mode === 'eval') {
      // -i with -e / -p: the REPL starts, then the code runs (Node's order).
      if (parsed.interactive) {
        const status = startRepl();
        if (status !== undefined) return status;
      }
      lastEvalCode = parsed.code;
      // --input-type, else Node's detect-module: CJS unless ESM-only syntax
      // (not mere import()).
      const inputType = inputTypeOf(process._options);
      const asEsm = inputType ? inputType === 'module' : shouldRunAsEsm(parsed.code);
      try {
        if (asEsm && parsed.print) {
          throw nodeError(Error, 'ERR_EVAL_ESM_CANNOT_PRINT', '--print cannot be used with ESM input');
        }
        if (asEsm) {
          // Node: ES module input is the module <cwd>/[eval1].
          uncaughtFromEsm = true;
          const result = esm.runEsmEval(
            parsed.print ? `console.log(${parsed.code}\n)` : parsed.code,
            `${process.cwd().replace(/\/$/, '')}/[eval1]`
          );
          uncaughtFromEsm = false;
          if (result != null && typeof result.then === 'function') setEntry(result, 'esm');
          flushTicks();
        } else {
          const evalParent = `${process.cwd()}/[eval]`;
          const require = cjs.makeRequire(evalParent);
          const exports = {};
          const module = { exports, id: '[eval]' };
          // Dynamic import() is valid in CJS; rewrite to the kernel loader
          // (host import() cannot see the in-memory FS).
          const {
            code: cjsCode,
            changed: hasImport,
            binding: importBinding = '__import',
          } = rewriteDynamicImports(parsed.code);
          const dynImport = (spec, options) => esm.importDynamic(spec, evalParent, options);
          const body = parsed.print
            ? `return (${cjsCode}\n)\n//# sourceURL=[eval]`
            : `${cjsCode}\n//# sourceURL=[eval]`;
          const args = ['exports', 'require', 'module', '__filename', '__dirname'];
          const values = [exports, require, module, '[eval]', process.cwd()];
          if (hasImport) {
            args.push(importBinding);
            values.push(dynImport);
          }
          let fn;
          try {
            fn = new Function(...args, body);
          } catch (err) {
            // Node's report: [eval]:line, the line, carets under the token.
            // -p compiled the code as an expression: its own message is V8's for
            // the code itself (not for the `return (…)` around it).
            const report =
              err instanceof SyntaxError &&
              syntaxReport(parsed.code, { kind: 'commonjs', filename: '[eval]', error: parsed.print ? undefined : err });
            if (report) {
              Object.defineProperty(err, '_prettyStack', { value: report.stack, configurable: true, writable: true });
              err.stack = report.stack;
            }
            throw err;
          }
          const result = fn(...values);
          // Keep the loop alive for floating async IIFEs: `(async () => { ... })()`.
          if (result != null && typeof result.then === 'function') {
            trackPromise(handles, result);
          }
          flushTicks();
          // Node -p: console.log semantics (strings unquoted), not util.inspect.
          if (parsed.print) {
            console.log(result);
          }
        }
      } catch (err) {
        if (isExitError(err)) throw err;
        if (handleUncaught(err)) {
          uncaughtFromEsm = false;
        } else {
          return dieUncaught(() => printUncaught(err));
        }
      }
    } else if (parsed.mode === 'file') {
      const filePath = ctx.resolve(parsed.script);
      let source;
      try {
        source = decoder.decode(ctx.sync.fs.readFile(filePath));
      } catch (err) {
        const msg = err?.message ?? String(err);
        await ctx.write(2, `${ctx.argv[0]}: cannot open ${parsed.script}: ${msg}\n`);
        return 1;
      }
      process.argv[1] = filePath;
      // Node runs the entry from its real path (so its own requires, and a
      // require of itself, resolve as for any module); process.argv[1] keeps
      // the path as given. --preserve-symlinks-main keeps the link.
      const mainPath = realMainPath(ctx, filePath, process._options);
      if (parsed.check) {
        // --check: compiled as the module it is, under its real path, never run.
        let kind = esm.isEsmFilename(mainPath, source) ? 'module' : 'commonjs';
        let error = checkSyntax(source, { kind, filename: mainPath });
        // detect-module: a wrapper name declared at the top level makes an
        // ES module, unless the package says "commonjs".
        if (error?.wrapperRedeclare && cjs.findPackageType(mainPath.replace(/\/[^/]*$/, '') || '/')?.type !== 'commonjs') {
          kind = 'module';
          error = checkSyntax(source, { kind, filename: mainPath });
        }
        if (error) {
          warnCheckedEsm(kind, source, mainPath);
          return dieUncaught(() => printUncaught(error));
        }
        return 0;
      }
      try {
        // isEsmFilename covers .mjs, "type":"module", and detect-module for
        // ambiguous .js (not explicit "type":"commonjs").
        const useEsm = esm.isEsmFilename(mainPath, source);
        uncaughtFromEsm = useEsm;
        if (useEsm) {
          const result = esm.runMain(mainPath, source);
          if (result != null && typeof result.then === 'function') setEntry(result, 'esm');
        } else {
          cjs.runMain(mainPath, source);
        }
        uncaughtFromEsm = false;
        flushTicks();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (handleUncaught(err)) {
          uncaughtFromEsm = false;
        } else {
          return dieUncaught(() => printUncaught(err));
        }
      }
    }

    if (getDidExit()) {
      timers.clearPending();
      return getExitCode();
    }

    await drainLoop(handles, nextTick, {
      onBeforeExit: () => {
        emitBeforeExit();
      },
      shouldStop: () => getDidExit() || exitStatus !== undefined,
      weakPending: () => entry?.pending === true,
      onTickError: (err) => exceptionHandler(err),
    });
    loopEnded = true;

    if (entry?.pending && entry.kind === 'esm' && exitStatus === undefined && !getDidExit()) {
      // Node: `Warning: Detected unsettled top-level await at <url>`, exit 13.
      const where =
        parsed.mode === 'file' ? `file://${process.argv[1]}` : `file://${process.cwd().replace(/\/$/, '')}/[eval1]`;
      writeStderr(`Warning: Detected unsettled top-level await at ${where}\n\n\n`);
      exitStatus = 13;
    }

    // #297: unhandled rejections are reported on a later turn. Keep ctx hooks
    // registered through a few macrotasks so the kernel does not see an empty
    // listener set and print its default `node: …` line.
    for (let i = 0; i < 3; i++) {
      if (exitStatus !== undefined || getDidExit()) break;
      await new Promise((resolve) => {
        timers.setTimeout(resolve, 0);
      });
      flushTicks();
    }

    if (exitStatus !== undefined) return finishExit(exitStatus);
    if (getDidExit()) {
      return getExitCode();
    }
    return finishExit(getExitCode());
  } catch (err) {
    if (isExitError(err)) {
      timers.clearPending();
      return getDidExit() ? getExitCode() : err.code;
    }
    return dieUncaught(() => {
      try {
        printUncaught(err);
      } catch {
        writeStderr(`${err}\n`);
      }
    });
  } finally {
    timers.clearPending();
    // Drop hooks only after the turn above; worker teardown follows. After
    // process.exit() keep them: whatever the unwinding code still rejects
    // must not reach the kernel's default report.
    for (const remove of getDidExit() ? [] : removeCtxHooks) {
      try {
        remove?.();
      } catch {
        /* ignore */
      }
    }
    try {
      restoreGlobals();
      restoreFunctionImport();
      restorePlatform();
      removeJshHandoff();
    } catch {
      /* ignore */
    }
    // process.kill(self) with the default action: the kernel ends the
    // process with the signal on a turn of its own; give it the time
    // (else the program ends with 128 + n, as before).
    if (process._signalDeath) {
      await process._signalDeath;
      await new Promise((resolve) => nativeSetTimeout(resolve, 1000));
    }
  }
}
