import { runNode } from './runtime/run.mjs';

/**
 * `jsh` command entry. PR2: same runtime as node; .jsh wrapper comes later.
 * @param {object} ctx JsProgramContext from slicc-kernel
 */
export default async function main(ctx) {
  return runNode(ctx);
}
