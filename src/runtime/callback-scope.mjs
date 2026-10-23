import { queueMicrotask, runInResource } from './async-context.mjs';

let depth = 0;
let enterIo = null;

export function onIo(fn) {
  enterIo = fn;
}

export function ioMicrotask(fn) {
  queueMicrotask(() => {
    enterIo?.();
    fn();
  });
}

export function ioSettled(promise) {
  promise.then(
    () => enterIo?.(),
    () => enterIo?.()
  );
  return promise;
}

export function makeCallback(process, holder, fn, thisArg, args = []) {
  if (depth === 0) enterIo?.();
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
