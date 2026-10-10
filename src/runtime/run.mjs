import { drainLoop } from './async-handles.mjs';
import { createBuffer } from './buffer.mjs';
import { createUtil } from './builtins/util.mjs';
import { createCjs } from './cjs/loader.mjs';
import { parseNodeArgv } from './cli.mjs';
import { createConsole } from './console.mjs';
import { formatUncaughtError } from './errors-format.mjs';
import { NodeExitError } from './exit.mjs';
import { createHandleTable } from './handles.mjs';
import { createNextTick } from './next-tick.mjs';
import { createProcess, NODE_SHIM_VERSION } from './process.mjs';
import { installStackPrepare } from './stack.mjs';
import { createTimers } from './timers.mjs';

const decoder = new TextDecoder();

/**
 * Run the node CLI against a JsProgramContext. Resolves with an exit status.
 */
export async function runNode(ctx) {
  installStackPrepare();
  const handles = createHandleTable();
  const nextTick = createNextTick();
  let exitStatus;
  let lastEvalCode;
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

  // M1 gap: present for typeof checks; call throws ERR_NOT_SUPPORTED (M2: ctx.fetch).
  async function fetchStub() {
    const err = new Error("slicc-jsh: 'fetch' is not supported yet");
    err.code = 'ERR_NOT_SUPPORTED';
    throw err;
  }
  class WebSocketStub {
    constructor() {
      const err = new Error("slicc-jsh: 'WebSocket' is not supported yet");
      err.code = 'ERR_NOT_SUPPORTED';
      throw err;
    }
  }
  for (const [name, value] of [
    ['fetch', fetchStub],
    ['WebSocket', WebSocketStub],
  ]) {
    try {
      const desc = Object.getOwnPropertyDescriptor(globalThis, name);
      if (desc && desc.configurable === false && desc.writable === false) continue;
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      /* kernel may freeze the name; bindings are also injected into user Function scopes */
    }
  }

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

  // The kernel installs trapStrays on the host process before main(). Replace
  // those listeners so user process.on('unhandledRejection'|'uncaughtException')
  // can run; otherwise the host prints "node: …" and exits 1.
  const hostProcess = globalThis.process;
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
    fatal(reason instanceof Error ? reason : new Error(String(reason)));
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

  const cjs = createCjs({
    ctx,
    process,
    Buffer,
    console,
    timers,
    handles,
    fetch: fetchStub,
    WebSocket: WebSocketStub,
  });

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
      const require = cjs.makeRequire(`${process.cwd()}/[eval]`);
      const exports = {};
      const module = { exports, id: '[eval]' };
      const body = parsed.print ? `return (${parsed.code}\n)` : parsed.code;
      const fn = new Function(
        'process',
        'console',
        'Buffer',
        'require',
        'exports',
        'module',
        '__filename',
        '__dirname',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
        'fetch',
        'WebSocket',
        `${body}\n//# sourceURL=[eval]`
      );
      try {
        const result = fn(
          process,
          console,
          Buffer,
          require,
          exports,
          module,
          '[eval]',
          process.cwd(),
          timers.setTimeout,
          timers.clearTimeout,
          timers.setInterval,
          timers.clearInterval,
          (cb, ...args) => timers.setTimeout(cb, 0, ...args),
          timers.clearTimeout,
          globalThis.queueMicrotask.bind(globalThis),
          fetchStub,
          WebSocketStub
        );
        nextTick.flushSync();
        if (parsed.print) writeStdout(`${util.inspect(result, { colors: false })}\n`);
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
      if (parsed.script.endsWith('.mjs')) {
        await ctx.write(
          2,
          `${ctx.argv[0]}: ESM modules (.mjs / "type":"module") are not supported yet (planned for M2)\n`
        );
        return 1;
      }
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
        cjs.runMain(filePath, source);
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

    if (exitStatus !== undefined) {
      try {
        emitExit(exitStatus);
      } catch {
        /* ignore */
      }
      return exitStatus;
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
  }
}
