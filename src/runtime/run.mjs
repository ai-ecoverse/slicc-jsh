import { drainLoop, trackPromise } from './async-handles.mjs';
import { createBuffer } from './buffer.mjs';
import { createUtil } from './builtins/util.mjs';
import { createCjs } from './cjs/loader.mjs';
import { parseNodeArgv } from './cli.mjs';
import { createConsole } from './console.mjs';
import { createEsm } from './esm/loader.mjs';
import { sourceLooksLikeEsm } from './esm/transform.mjs';
import { formatUncaughtError, formatUnhandledRejection } from './errors-format.mjs';
import { NodeExitError } from './exit.mjs';
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
 * Run the node CLI against a JsProgramContext. Resolves with an exit status.
 */
export async function runNode(ctx) {
  installStackPrepare();
  const handles = createHandleTable();
  const nextTick = createNextTick();
  let exitStatus;
  let lastEvalCode;
  let restoreGlobals = () => {};
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
  });
  process.execArgv = parsed.execArgv ? [...parsed.execArgv] : [];
  if (parsed.mode === 'eval') {
    process._evalCode = parsed.code;
    lastEvalCode = parsed.code;
  }

  const console = createConsole(writeStdout, writeStderr, util);
  const fetch = createFetch(ctx);
  const WebSocket = createWebSocket(ctx);

  const timers = createTimers(handles, {
    onCallbackError: (err) => {
      if (err instanceof NodeExitError) {
        exitStatus = err.code;
        timers.clearPending();
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
    timers.clearPending();
    try {
      ctx.exit?.(1);
    } catch {
      /* JsExit unwinds */
    }
  };
  const rejectionHandler = (reason, promise) => {
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
    try {
      ctx.exit?.(1);
    } catch {
      /* JsExit */
    }
    exitStatus = 1;
    timers.clearPending();
  };
  const exceptionHandler = (err) => {
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

  try {
    if (parsed.mode === 'empty') {
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
        if (err instanceof NodeExitError) throw err;
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
      const asEsm =
        sourceLooksLikeEsm(parsed.code) ||
        /\bimport\s*\(/.test(parsed.code) ||
        /\bimport\.meta\b/.test(parsed.code);
      try {
        if (asEsm) {
          const result = esm.runEsmEval(
            parsed.print ? `console.log(${parsed.code}\n)` : parsed.code,
            '[eval]'
          );
          if (result != null && typeof result.then === 'function') {
            trackPromise(handles, result);
            await result;
          }
          nextTick.flushSync();
        } else {
          const require = cjs.makeRequire(`${process.cwd()}/[eval]`);
          const exports = {};
          const module = { exports, id: '[eval]' };
          // Same 5-arg Node wrapper as CJS files — process/Buffer/console are globals.
          const body = parsed.print
            ? `return (${parsed.code}\n)\n//# sourceURL=[eval]`
            : `${parsed.code}\n//# sourceURL=[eval]`;
          const fn = new Function(
            'exports',
            'require',
            'module',
            '__filename',
            '__dirname',
            body
          );
          const result = fn(exports, require, module, '[eval]', process.cwd());
          // Keep the loop alive for floating async IIFEs: `(async () => { ... })()`.
          if (result != null && typeof result.then === 'function') {
            trackPromise(handles, result);
          }
          nextTick.flushSync();
          if (parsed.print) writeStdout(`${util.inspect(result, { colors: false })}\n`);
        }
      } catch (err) {
        if (err instanceof NodeExitError) throw err;
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
      try {
        const useEsm =
          filePath.endsWith('.mjs') ||
          esm.isEsmFilename(filePath, source) ||
          sourceLooksLikeEsm(source);
        if (useEsm) {
          const result = esm.runMain(filePath, source);
          if (result != null && typeof result.then === 'function') {
            trackPromise(handles, result);
            await result;
          }
        } else {
          cjs.runMain(filePath, source);
        }
        nextTick.flushSync();
      } catch (err) {
        if (err instanceof NodeExitError) throw err;
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
    });

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
    if (err instanceof NodeExitError) {
      timers.clearPending();
      return err.code;
    }
    try {
      printUncaught(err);
    } catch {
      await ctx.write(2, `${err}\n`);
    }
    return 1;
  } finally {
    timers.clearPending();
    // Drop hooks only after the turn above; worker teardown follows.
    for (const remove of removeCtxHooks) {
      try {
        remove?.();
      } catch {
        /* ignore */
      }
    }
    try {
      restoreGlobals();
    } catch {
      /* ignore */
    }
  }
}
