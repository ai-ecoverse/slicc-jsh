import { installJshHandoff } from '../jsh/kernel.mjs';
import { drainLoop, trackPromise } from './async-handles.mjs';
import { createBuffer } from './buffer.mjs';
import { createUtil } from './builtins/util.mjs';
import { createCjs } from './cjs/loader.mjs';
import { parseNodeArgv } from './cli.mjs';
import { createConsole } from './console.mjs';
import { createEsm } from './esm/loader.mjs';
import { rewriteDynamicImports, shouldRunAsEsm } from './esm/transform.mjs';
import { formatUncaughtError, formatUnhandledRejection } from './errors-format.mjs';
import { isExitError } from './exit.mjs';
import { realMainPath } from './realpath.mjs';
import { createHandleTable } from './handles.mjs';
import { createNextTick } from './next-tick.mjs';
import { createProcess, NODE_SHIM_VERSION } from './process.mjs';
import { installStackPrepare } from './stack.mjs';
import { createTimers } from './timers.mjs';
import { createFetch } from './web/fetch.mjs';
import { createWebSocket } from './web/websocket.mjs';

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
  const printUncaught = (err) => {
    const { body } = formatUncaughtError(err, {
      ctx,
      util,
      version: NODE_SHIM_VERSION,
      evalCode: lastEvalCode,
    });
    writeStderr(body);
  };

  const parsed = parseNodeArgv([...ctx.argv]);
  if (parsed.error) {
    await ctx.write(2, `${parsed.error}\n`);
    return parsed.status ?? 9;
  }
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

  const {
    process,
    writeStdout,
    writeStderr,
    getExitCode,
    getDidExit,
    emitBeforeExit,
    emitExit,
  } = createProcess({
    ctx,
    argv: parsed.processArgv,
    nextTick,
    handles,
    Buffer,
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
  process.execArgv = parsed.execArgv ? [...parsed.execArgv] : [];
  if (parsed.mode === 'eval') {
    process._evalCode = parsed.code;
    lastEvalCode = parsed.code;
  }

  const console = createConsole(writeStdout, writeStderr, util);
  const fetch = createFetch(ctx, { handles });
  const restorePlatform = trackPlatformAsync(handles);
  const WebSocket = createWebSocket(ctx, { handles, trackPromise });

  const timers = createTimers(handles, {
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
      if (process.listenerCount('uncaughtException') > 0) {
        try {
          process.emit(
            'uncaughtException',
            err instanceof Error ? err : new Error(String(err)),
            'uncaughtException'
          );
          return;
        } catch {
          /* fall through */
        }
      }
      try {
        printUncaught(err);
      } catch {
        /* ignore */
      }
      exitStatus = 1;
      timers.clearPending();
    },
  });

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
  });

  const fatal = (err) => {
    try {
      printUncaught(err);
    } catch {
      /* ignore */
    }
    exitStatus = 1;
    // Before ctx.exit: the kernel ends the process on a timer of its own.
    timers.stop();
    try {
      ctx.exit?.(1);
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
    const { body } = formatUnhandledRejection(reason, {
      ctx,
      util,
      version: NODE_SHIM_VERSION,
      evalCode: lastEvalCode,
    });
    writeStderr(body);
    exitStatus = 1;
    timers.stop();
    try {
      ctx.exit?.(1);
    } catch {
      /* JsExit */
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
    if (process.listenerCount('uncaughtException') > 0) {
      process.emit(
        'uncaughtException',
        err instanceof Error ? err : new Error(String(err)),
        'uncaughtException'
      );
      return;
    }
    fatal(err);
  };

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
      load: (id) => nodeRequire(id),
    },
    cjs,
    trackPromise,
  });
  // Sync require() of .mjs / "type":"module" — returns the ESM namespace object.
  cjs.setRequireEsmHook((filename) => esm.requireEsm(filename));
  // Dynamic import() inside CommonJS files — resolve relative to the CJS file.
  cjs.setImportModuleHook((specifier, parent) => esm.importModule(specifier, parent));

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
        else exceptionHandler(err);
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
      importModule: (specifier, parent) => esm.importModule(specifier, parent),
      rewriteDynamicImports,
    };
    removeJshHandoff = installJshHandoff(ctx, rt);
    if (typeof options.main === 'function') {
      try {
        const result = options.main(rt);
        if (result != null && typeof result.then === 'function') {
          // The tracking promise settles like `result`; its rejection is
          // handled below through `await result`.
          trackPromise(handles, result).catch(() => {});
          await result;
        }
        nextTick.flushSync();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (process.listenerCount('uncaughtException') > 0) {
          process.emit(
            'uncaughtException',
            err instanceof Error ? err : new Error(String(err)),
            'uncaughtException'
          );
        } else {
          printUncaught(err);
          return 1;
        }
      }
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
      if (chunks.length === 0) return 0;
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
      process.argv[1] = '[stdin]';
      try {
        // Node: __filename is `[stdin]`; require.main is unset for piped scripts.
        cjs.runMain('[stdin]', source, { setMain: false });
        nextTick.flushSync();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (process.listenerCount('uncaughtException') > 0) {
          process.emit(
            'uncaughtException',
            err instanceof Error ? err : new Error(String(err)),
            'uncaughtException'
          );
        } else {
          printUncaught(err);
          return 1;
        }
      }
    } else if (parsed.mode === 'eval') {
      lastEvalCode = parsed.code;
      // Node detect-module: CJS unless ESM-only syntax (not mere import()).
      const asEsm = shouldRunAsEsm(parsed.code);
      try {
        if (asEsm) {
          const result = esm.runEsmEval(
            parsed.print ? `console.log(${parsed.code}\n)` : parsed.code,
            '[eval]'
          );
          if (result != null && typeof result.then === 'function') setEntry(result, 'esm');
          nextTick.flushSync();
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
          const dynImport = (spec) => esm.importModule(spec, evalParent);
          const body = parsed.print
            ? `return (${cjsCode}\n)\n//# sourceURL=[eval]`
            : `${cjsCode}\n//# sourceURL=[eval]`;
          const args = ['exports', 'require', 'module', '__filename', '__dirname'];
          const values = [exports, require, module, '[eval]', process.cwd()];
          if (hasImport) {
            args.push(importBinding);
            values.push(dynImport);
          }
          const fn = new Function(...args, body);
          const result = fn(...values);
          // Keep the loop alive for floating async IIFEs: `(async () => { ... })()`.
          if (result != null && typeof result.then === 'function') {
            trackPromise(handles, result);
          }
          nextTick.flushSync();
          // Node -p: console.log semantics (strings unquoted), not util.inspect.
          if (parsed.print) {
            console.log(result);
          }
        }
      } catch (err) {
        if (isExitError(err)) throw err;
        if (process.listenerCount('uncaughtException') > 0) {
          process.emit(
            'uncaughtException',
            err instanceof Error ? err : new Error(String(err)),
            'uncaughtException'
          );
        } else {
          printUncaught(err);
          return 1;
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
      const mainPath = realMainPath(ctx, filePath, process.execArgv);
      try {
        // isEsmFilename covers .mjs, "type":"module", and detect-module for
        // ambiguous .js (not explicit "type":"commonjs").
        const useEsm = esm.isEsmFilename(mainPath, source);
        if (useEsm) {
          const result = esm.runMain(mainPath, source);
          if (result != null && typeof result.then === 'function') setEntry(result, 'esm');
        } else {
          cjs.runMain(mainPath, source);
        }
        nextTick.flushSync();
      } catch (err) {
        if (isExitError(err)) throw err;
        if (process.listenerCount('uncaughtException') > 0) {
          process.emit(
            'uncaughtException',
            err instanceof Error ? err : new Error(String(err)),
            'uncaughtException'
          );
        } else {
          printUncaught(err);
          return 1;
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
    });

    if (entry?.pending && entry.kind === 'esm' && exitStatus === undefined && !getDidExit()) {
      // Node: `Warning: Detected unsettled top-level await at <url>`, exit 13.
      const where = parsed.mode === 'file' ? `file://${process.argv[1]}` : '[eval1]';
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
      nextTick.flushSync();
    }

    if (exitStatus !== undefined) {
      try {
        emitExit(exitStatus);
      } catch {
        /* ignore */
      }
      return exitStatus;
    }
    if (getDidExit()) {
      return getExitCode();
    }
    const code = getExitCode();
    try {
      emitExit(code);
    } catch {
      /* ignore */
    }
    return code;
  } catch (err) {
    if (isExitError(err)) {
      timers.clearPending();
      return getDidExit() ? getExitCode() : err.code;
    }
    try {
      printUncaught(err);
    } catch {
      await ctx.write(2, `${err}\n`);
    }
    return 1;
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
      restorePlatform();
      removeJshHandoff();
    } catch {
      /* ignore */
    }
  }
}
