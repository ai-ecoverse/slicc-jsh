/**
 * Package `bin` entry (`dist/host/jsh.mjs`).
 *
 * On a real host Node, loads the host implementation (child_process, vm, …).
 * When pnpm's global bin shadows the kernel's `slicc.commands.jsh` and this
 * file is executed by jsh's own `node`, hand off in-process to the in-kernel
 * jsh entry (`../jsh.mjs`) — same argv/env/stdio, no spawn, no PATH edits.
 *
 * Relative imports (not file: URLs): the kernel's node ESM loader resolves
 * package paths on the memory root; file: URLs do not.
 *
 * Do not call `process.exit` after handoff: inside slicc-jsh, `process.exit`
 * throws `NodeExitError` (it does not terminate like host Node). Set
 * `process.exitCode` and return so the running node drains cleanly.
 */
import { createRequire } from 'node:module';

/** True when this process is slicc-jsh's Node-entry runtime (not host Node). */
export function insideSliccKernel() {
  const ep = globalThis.process?.execPath ?? '';
  if (
    typeof ep === 'string' &&
    ep.includes('@ai-ecoverse/slicc-jsh') &&
    /[/\\]dist[/\\]node\.mjs$/.test(ep)
  ) {
    return true;
  }
  // Fallback: jsh stubs child_process with ERR_NOT_SUPPORTED / ACCESS_DENIED.
  try {
    createRequire(import.meta.url)('node:child_process');
    return false;
  } catch (err) {
    return err?.code === 'ERR_NOT_SUPPORTED' || err?.code === 'ERR_ACCESS_DENIED';
  }
}

/**
 * Import dist/jsh.mjs (slicc.commands.jsh) and run it on process._ctx.
 * @returns {Promise<number>}
 */
export async function handoffToKernelJsh() {
  const ctx = globalThis.process?._ctx;
  if (!ctx || typeof ctx.write !== 'function') {
    throw new Error(
      "slicc-jsh: host bin is on jsh's node but process._ctx is missing; cannot hand off to in-kernel jsh"
    );
  }
  const { default: kernelJsh } = await import('../jsh.mjs');
  if (typeof kernelJsh !== 'function') {
    throw new Error('slicc-jsh: in-kernel jsh entry has no default export');
  }
  // Same env/stdio as this process (shared ctx). Only argv is the jsh CLI shape.
  const jshCtx = Object.create(ctx, {
    argv: { value: ['jsh', ...process.argv.slice(2)], enumerable: true },
  });
  return kernelJsh(jshCtx);
}

function isNodeExitError(err) {
  return err?.name === 'NodeExitError' || err?.constructor?.name === 'NodeExitError';
}

async function main() {
  if (insideSliccKernel()) {
    const status = await handoffToKernelJsh();
    process.exitCode = status ?? 0;
    return;
  }
  // Host Node: load the implementation that uses child_process / vm.
  await import('./jsh-host.mjs');
}

main().catch((err) => {
  // Nested runNode (script handoff) may surface NodeExitError; honor its code.
  if (isNodeExitError(err)) {
    process.exitCode = typeof err.code === 'number' ? err.code : process.exitCode ?? 0;
    return;
  }
  const msg = err?.stack ?? String(err);
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    console.error(msg);
  }
  process.exitCode = 1;
  // Host Node: terminate; kernel: exitCode is enough (exit() would throw).
  if (!insideSliccKernel()) {
    process.exit(1);
  }
});
