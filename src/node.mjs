import { runNode } from './runtime/run.mjs';
import { workerContext, workerDataOf } from './runtime/builtins/worker-threads.mjs';

/**
 * `node` command entry for slicc-kernel (abi: "js"). In a thread the kernel
 * started for a worker_threads Worker (ctx.thread), the worker's program.
 * @param {object} ctx JsProgramContext from slicc-kernel
 */
export default async function main(ctx) {
  const data = workerDataOf(ctx);
  if (!data) return runNode(ctx);
  const io = workerContext(ctx, data);
  let status = 1;
  try {
    status = await runNode(io.ctx, { worker: { data, io } });
  } finally {
    io.bye(status);
  }
  return status;
}
