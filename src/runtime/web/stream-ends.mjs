/**
 * Node's web streams carry two hooks that its stream module reads
 * (lib/internal/webstreams/readablestream.js and writablestream.js):
 *
 * - `Symbol.for('nodejs.webstream.isClosedPromise')`: a `{ promise, resolve,
 *   reject }` that settles when the stream closes or errors. stream.finished()
 *   waits on it (eosWeb in lib/internal/streams/end-of-stream.js).
 * - `Symbol.for('nodejs.webstream.controllerErrorFunction')`: the controller's
 *   error(), which addAbortSignal() calls.
 *
 * A browser's streams have neither, so finished() on one threw `Cannot read
 * properties of undefined (reading 'promise')`. undici's fetch calls it on
 * every response body (fetchFinale) and terminates the fetch when it throws,
 * so a body that hadn't fully arrived never ended. The program then exited 13
 * on an unsettled top-level await, as `cf auth login` did in its poll loop
 * (#1270).
 *
 * Here the program's ReadableStream and WritableStream get both hooks, as
 * Node's have them. The constructors are still the platform's, behind a
 * wrapper that shares the platform's prototype, so instanceof holds for every
 * stream the platform makes too. Where the platform's streams already have
 * the hooks (Node), nothing is installed.
 *
 * What it can't see: streams the platform makes itself (a Blob's, a
 * TransformStream's sides) still have no hooks. A readable's promise resolves
 * when its source closes it, not once the last queued chunk has been read,
 * which is when Node's resolves.
 */

const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = Symbol.for('nodejs.webstream.controllerErrorFunction');

const isThenable = (value) => value instanceof Promise;

/** A stream's end: Node's PromiseWithResolvers, settled once. */
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
      // Node: setPromiseHandled, then reject.
      promise.catch(() => {});
      reject(error);
    },
  };
}

/**
 * The callbacks of an underlying source or sink, read once and in the order
 * WebIDL reads a dictionary (its members sorted by name), or null when one
 * isn't a function: the platform then rejects the original with its own error.
 */
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

/** `fn` called on `init`, with `fail` told of a throw or a rejection. */
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

/**
 * Node's hooks on `stream`. Node's are enumerable, but its streams' custom
 * inspect hides them; the platform's inspect would print them, so they're not.
 */
function hook(stream, closed, errorFunction) {
  for (const [key, value] of [
    [kIsClosedPromise, closed],
    [kControllerErrorFunction, errorFunction],
  ]) {
    Object.defineProperty(stream, key, { value, writable: true, configurable: true, enumerable: false });
  }
}

/** The platform's constructor behind one that shares its prototype and statics. */
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

/**
 * Give the program's ReadableStream and WritableStream Node's end hooks.
 * Returns the undo.
 */
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
  /** The ends of the streams this program made, by their controllers. */
  const ends = new WeakMap();

  // A controller's close, error and enqueue: a throw that errored the stream
  // (desiredSize null) ends it too, as a close request or an error() does.
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
      // Node closes the stream before it calls the source's cancel.
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
      // Closed once the sink's close is done (Node: writableStreamFinishInFlightClose).
      close() {
        if (!cb.close) return end.close();
        const result = watched(cb.close, sink, end.fail, []);
        if (isThenable(result)) return result.then(() => end.close());
        end.close();
        return result;
      },
      // Errored with the abort's reason once the sink's abort is done.
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
