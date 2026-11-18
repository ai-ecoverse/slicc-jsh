const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = Symbol.for('nodejs.webstream.controllerErrorFunction');

const isThenable = (value) => value instanceof Promise;

function streamEnd() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let settled = false;
  return {
    hooks: { promise, resolve, reject },
    close() {
      if (settled) return;
      settled = true;
      resolve();
    },
    fail(error) {
      if (settled) return;
      settled = true;
      promise.catch(() => {});
      reject(error);
    },
  };
}

function callbacksOf(init, names) {
  if (init === undefined) return {};
  if (init === null || (typeof init !== 'object' && typeof init !== 'function')) return null;
  const out = {};
  for (const name of names) {
    const value = init[name];
    if (value !== undefined && typeof value !== 'function' && name !== 'type' && name !== 'autoAllocateChunkSize') {
      return null;
    }
    out[name] = value;
  }
  return out;
}

function watched(fn, init, fail, args) {
  let result;
  try {
    result = Reflect.apply(fn, init, args);
  } catch (error) {
    fail(error);
    throw error;
  }
  if (isThenable(result)) result.then(undefined, fail);
  return result;
}

function hook(stream, closed, errorFunction) {
  for (const [key, value] of [
    [kIsClosedPromise, closed],
    [kControllerErrorFunction, errorFunction],
  ]) {
    Object.defineProperty(stream, key, { value, writable: true, configurable: true, enumerable: false });
  }
}

function wrapConstructor(Platform, name, construct) {
  const Wrapper = {
    [name]: function (...args) {
      if (new.target === undefined) return Reflect.apply(Platform, this, args);
      return construct(args, new.target === Wrapper ? Platform : new.target);
    },
  }[name];
  for (const key of Reflect.ownKeys(Platform)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    Object.defineProperty(Wrapper, key, Object.getOwnPropertyDescriptor(Platform, key));
  }
  Object.defineProperty(Wrapper, 'length', { value: Platform.length, configurable: true });
  Object.defineProperty(Wrapper, 'prototype', { value: Platform.prototype, writable: false });
  return Wrapper;
}

export function installWebStreamEnds(scope = globalThis) {
  const PlatformReadable = scope.ReadableStream;
  const PlatformWritable = scope.WritableStream;
  if (typeof PlatformReadable !== 'function' || typeof PlatformWritable !== 'function') return () => {};
  try {
    if (new PlatformReadable()[kIsClosedPromise] !== undefined) return () => {};
  } catch {
    return () => {};
  }
  const undo = [];
  const ends = new WeakMap();

  const patch = (proto, method, after) => {
    const original = proto?.[method];
    if (typeof original !== 'function') return;
    const patched = {
      [method](...args) {
        const end = ends.get(this);
        if (!end) return Reflect.apply(original, this, args);
        let result;
        try {
          result = Reflect.apply(original, this, args);
        } catch (error) {
          if (after && this.desiredSize === null) end.fail(error);
          throw error;
        }
        after?.(end, args);
        return result;
      },
    }[method];
    Object.defineProperty(proto, method, { ...Object.getOwnPropertyDescriptor(proto, method), value: patched });
    undo.push(() => Object.defineProperty(proto, method, { ...Object.getOwnPropertyDescriptor(proto, method), value: original }));
  };
  for (const Controller of [scope.ReadableStreamDefaultController, scope.ReadableByteStreamController]) {
    patch(Controller?.prototype, 'close', (end) => end.close());
    patch(Controller?.prototype, 'error', (end, [error]) => end.fail(error));
    patch(Controller?.prototype, 'enqueue', () => {});
  }
  patch(scope.WritableStreamDefaultController?.prototype, 'error', (end, [error]) => end.fail(error));

  const Readable = wrapConstructor(PlatformReadable, 'ReadableStream', (args, newTarget) => {
    const [source] = args;
    const cb = callbacksOf(source, ['autoAllocateChunkSize', 'cancel', 'pull', 'start', 'type']);
    if (!cb) return Reflect.construct(PlatformReadable, args, newTarget);
    const end = streamEnd();
    let errorFunction;
    const tracked = {
      start(controller) {
        ends.set(controller, end);
        errorFunction = (error) => controller.error(error);
        return cb.start ? watched(cb.start, source, end.fail, [controller]) : undefined;
      },
      cancel(reason) {
        end.close();
        return cb.cancel ? Reflect.apply(cb.cancel, source, [reason]) : undefined;
      },
    };
    if (cb.pull) tracked.pull = (controller) => watched(cb.pull, source, end.fail, [controller]);
    if (cb.type !== undefined) tracked.type = cb.type;
    if (cb.autoAllocateChunkSize !== undefined) tracked.autoAllocateChunkSize = cb.autoAllocateChunkSize;
    const stream = Reflect.construct(PlatformReadable, [tracked, ...args.slice(1)], newTarget);
    hook(stream, end.hooks, errorFunction);
    return stream;
  });

  const Writable = wrapConstructor(PlatformWritable, 'WritableStream', (args, newTarget) => {
    const [sink] = args;
    const cb = callbacksOf(sink, ['abort', 'close', 'start', 'type', 'write']);
    if (!cb) return Reflect.construct(PlatformWritable, args, newTarget);
    const end = streamEnd();
    let errorFunction;
    const tracked = {
      start(controller) {
        ends.set(controller, end);
        errorFunction = (error) => controller.error(error);
        return cb.start ? watched(cb.start, sink, end.fail, [controller]) : undefined;
      },
      close() {
        if (!cb.close) return end.close();
        const result = watched(cb.close, sink, end.fail, []);
        if (isThenable(result)) return result.then(() => end.close());
        end.close();
        return result;
      },
      abort(reason) {
        if (!cb.abort) return end.fail(reason);
        const fail = () => end.fail(reason);
        const result = watched(cb.abort, sink, fail, [reason]);
        if (isThenable(result)) return result.then((value) => (fail(), value));
        fail();
        return result;
      },
    };
    if (cb.write) tracked.write = (chunk, controller) => watched(cb.write, sink, end.fail, [chunk, controller]);
    if (cb.type !== undefined) tracked.type = cb.type;
    const stream = Reflect.construct(PlatformWritable, [tracked, ...args.slice(1)], newTarget);
    hook(stream, end.hooks, errorFunction);
    return stream;
  });

  const install = (name, Wrapper, Platform) => {
    const desc = Object.getOwnPropertyDescriptor(scope, name);
    if (!desc || !('value' in desc)) return;
    const ctorDesc = Object.getOwnPropertyDescriptor(Platform.prototype, 'constructor');
    try {
      Object.defineProperty(scope, name, { ...desc, value: Wrapper });
    } catch {
      return;
    }
    undo.push(() => Object.defineProperty(scope, name, desc));
    if (ctorDesc?.configurable || ctorDesc?.writable) {
      Object.defineProperty(Platform.prototype, 'constructor', { ...ctorDesc, value: Wrapper });
      undo.push(() => Object.defineProperty(Platform.prototype, 'constructor', ctorDesc));
    }
  };
  install('ReadableStream', Readable, PlatformReadable);
  install('WritableStream', Writable, PlatformWritable);
  return () => {
    for (const fn of undo.reverse()) fn();
  };
}
