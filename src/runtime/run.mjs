import { createBuffer } from './buffer.mjs';
import { parseNodeArgv } from './cli.mjs';
import { createConsole } from './console.mjs';
import { NodeExitError } from './exit.mjs';
import { createHandleTable } from './handles.mjs';
import { createNextTick } from './next-tick.mjs';
import { createProcess } from './process.mjs';
import { createTimers } from './timers.mjs';

const decoder = new TextDecoder();

function runInScope(code, filename, scope) {
  const names = Object.keys(scope);
  const values = names.map((k) => scope[k]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=${filename}`);
  return fn(...values);
}

async function drain(handles, nextTick) {
  for (;;) {
    nextTick.flushSync();
    if (handles.refCount === 0) return;
    await handles.waitForProgress();
  }
}

/**
 * Run the node CLI against a JsProgramContext. Resolves with an exit status.
 */
export async function runNode(ctx) {
  const handles = createHandleTable();
  const nextTick = createNextTick();
  let exitStatus;

  const parsed = parseNodeArgv([...ctx.argv]);
  if (parsed.error) {
    await ctx.write(2, `${parsed.error}\n`);
    return parsed.status ?? 9;
  }

  const { process, writeStdout, writeStderr, getExitCode, getDidExit } = createProcess({
    ctx,
    argv: parsed.processArgv,
    nextTick,
    onExit: (code) => {
      exitStatus = code;
    },
  });

  const Buffer = createBuffer();
  const console = createConsole(writeStdout, writeStderr);
  const timers = createTimers(handles, {
    onCallbackError: (err) => {
      if (err instanceof NodeExitError) {
        exitStatus = err.code;
        timers.clearPending();
        return;
      }
      try {
        writeStderr(`${err?.stack ?? err}\n`);
      } catch {
        /* ignore */
      }
      exitStatus = 1;
      timers.clearPending();
    },
  });

  const scope = {
    process,
    console,
    Buffer,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setImmediate: (fn, ...args) => timers.setTimeout(fn, 0, ...args),
    clearImmediate: timers.clearTimeout,
    queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
  };

  try {
    if (parsed.mode === 'empty') {
      return 0;
    }

    if (parsed.mode === 'eval') {
      // -p must return the completion value; wrap so ExpressionStatement works.
      const body = parsed.print ? `return (${parsed.code}\n)` : parsed.code;
      const result = runInScope(body, '[eval]', scope);
      nextTick.flushSync();
      if (parsed.print) {
        writeStdout(`${result}\n`);
      }
    } else if (parsed.mode === 'file') {
      const path = ctx.resolve(parsed.script);
      let source;
      try {
        source = decoder.decode(ctx.sync.fs.readFile(path));
      } catch (err) {
        const msg = err?.message ?? String(err);
        await ctx.write(2, `${ctx.argv[0]}: cannot open ${parsed.script}: ${msg}\n`);
        return 1;
      }
      // process.argv[1] should be the resolved path (Node uses the absolute path).
      process.argv[1] = path;
      runInScope(source, path, {
        ...scope,
        __filename: path,
        __dirname: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.',
        exports: {},
        module: { exports: {} },
        require: () => {
          throw new Error('require is not implemented yet (M1 PR3)');
        },
      });
      nextTick.flushSync();
    }

    if (getDidExit()) {
      timers.clearPending();
      return getExitCode();
    }

    await drain(handles, nextTick);

    if (exitStatus !== undefined) return exitStatus;
    return getExitCode();
  } catch (err) {
    if (err instanceof NodeExitError) {
      timers.clearPending();
      return err.code;
    }
    try {
      writeStderr(`${err?.stack ?? err}\n`);
    } catch {
      await ctx.write(2, `${err}\n`);
    }
    return 1;
  } finally {
    timers.clearPending();
  }
}
