import { runInResource } from './async-context.mjs';

let depth = 0;

export function makeCallback(process, holder, fn, thisArg, args = []) {
  depth++;
  let result;
  try {
    result = holder ? runInResource(holder, fn, thisArg, args) : Reflect.apply(fn, thisArg, args);
  } finally {
    depth--;
  }
  if (depth === 0) {
    try {
      process._tickCallback?.();
    } catch (err) {
      process._triggerUncaught(err);
    }
  }
  return result;
}
