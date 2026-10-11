import { runKernelJsh } from './jsh/kernel.mjs';
import { JSH_USAGE, JSH_VERSION, parseJshArgv } from './jsh/run.mjs';
import { runNode } from './runtime/run.mjs';

/**
 * `jsh` command entry for slicc-kernel (abi: "js"): `jsh <script.jsh> [args]`,
 * also what the `.jsh` binfmt rule and `#!/usr/bin/env jsh` run. The script
 * runs on the `node` runtime (process, timers, event loop, CJS and ESM) with
 * the shared `.jsh` layer.
 * @param {object} ctx JsProgramContext from slicc-kernel
 */
export default async function main(ctx) {
  const parsed = parseJshArgv([...ctx.argv].slice(1));
  if (parsed.action === 'version') {
    await ctx.write(1, `${JSH_VERSION}\n`);
    return 0;
  }
  if (parsed.action === 'help') {
    await ctx.write(1, JSH_USAGE);
    return 0;
  }
  if (parsed.action === 'usage') {
    await ctx.write(2, JSH_USAGE);
    return 2;
  }
  if (parsed.action === 'error') {
    await ctx.write(2, `${parsed.message}\n${JSH_USAGE}`);
    return parsed.status;
  }
  const filename = ctx.resolve(parsed.script);
  const argv0 = ctx.argv[0] ?? 'jsh';
  const nodeCtx = Object.create(ctx, {
    argv: { value: [argv0, filename, ...parsed.args], enumerable: true },
  });
  return runNode(nodeCtx, { main: (rt) => runKernelJsh(ctx, rt, filename) });
}
