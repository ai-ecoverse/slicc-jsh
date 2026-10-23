import { queueMicrotask, runInResource } from './async-context.mjs';

let depth = 0;
let enterIo = null;
let poll = null;

export function onIo(fn, { inCheck, schedule } = {}) {
  enterIo = fn;
  poll = inCheck && schedule ? { inCheck, schedule } : null;
}

const pollLater = () => poll !== null && poll.inCheck();

export function ioMicrotask(fn) {
  if (pollLater()) {
    poll.schedule(fn);
    return;
  }
  queueMicrotask(() => {
    enterIo?.();
    fn();
  });
}

export function ioSettled(promise) {
  if (pollLater()) {
    const { schedule } = poll;
    return new Promise((resolve, reject) =>
      promise.then(
        (value) => schedule(() => resolve(value)),
        (err) => schedule(() => reject(err))
      )
    );
  }
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
