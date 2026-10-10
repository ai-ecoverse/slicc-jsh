import { runNode } from './runtime/run.mjs';

/**
 * `node` command entry for slicc-kernel (abi: "js").
 * @param {object} ctx JsProgramContext from slicc-kernel
 */
export default async function main(ctx) {
  return runNode(ctx);
}
