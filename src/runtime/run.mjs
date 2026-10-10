import { createBuffer } from './buffer.mjs';
import { createCjs } from './cjs/loader.mjs';
import { parseNodeArgv } from './cli.mjs';
import { createConsole } from './console.mjs';
import { NodeExitError } from './exit.mjs';
import { createHandleTable } from './handles.mjs';
import { createNextTick } from './next-tick.mjs';
import { createProcess } from './process.mjs';
import { createTimers } from './timers.mjs';

const decoder = new TextDecoder();

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

  const cjs = createCjs({ ctx, process, Buffer, console, timers });

  try {
    if (parsed.mode === 'empty') {
      return 0;
    }

    if (parsed.mode === 'eval') {
      const require = cjs.makeRequire(`${process.cwd()}/[eval]`);
      const exports = {};
      const module = { exports };
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
        `"use strict";\n${parsed.print ? `return (${parsed.code}\n)` : parsed.code}\n//# sourceURL=[eval]`
      );
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
        globalThis.queueMicrotask.bind(globalThis)
      );
      nextTick.flushSync();
      if (parsed.print) writeStdout(`${result}\n`);
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
      cjs.runMain(filePath, source);
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
