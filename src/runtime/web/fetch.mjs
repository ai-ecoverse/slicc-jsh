/**
 * globalThis.fetch → ctx.fetch (kernel transport / proxy routes).
 *
 * As in Node, a request in flight keeps the program alive, and so does
 * reading its response's body: the request, the body methods (`text()`,
 * `json()`, …) and reads of `response.body` are tracked handles.
 */
import { trackPromise } from '../async-handles.mjs';

const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'];

function trackBody(response, track) {
  for (const name of BODY_METHODS) {
    const method = response[name];
    if (typeof method !== 'function') continue;
    Object.defineProperty(response, name, {
      value: function tracked(...args) {
        return track(method.apply(response, args));
      },
      configurable: true,
      writable: true,
    });
  }
  const bodyDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(response), 'body');
  if (!bodyDesc?.get) return response;
  let wrapped;
  Object.defineProperty(response, 'body', {
    configurable: true,
    get() {
      if (wrapped !== undefined) return wrapped;
      const original = bodyDesc.get.call(response);
      if (original == null || typeof ReadableStream !== 'function') {
        wrapped = original;
        return wrapped;
      }
      let reader;
      wrapped = new ReadableStream({
        async pull(controller) {
          reader ??= original.getReader();
          const { value, done } = await track(reader.read());
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return (reader ?? original).cancel(reason);
        },
      });
      return wrapped;
    },
  });
  return response;
}

export function createFetch(ctx, { handles } = {}) {
  const track = (p) => (handles ? trackPromise(handles, p) : p);
  async function fetch(input, init) {
    if (typeof ctx.fetch !== 'function') {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error("slicc-jsh: ctx.fetch is not available"), {
        code: 'ENOTSUP',
      });
      throw err;
    }
    const response = await track(ctx.fetch(input, init));
    if (!handles || response == null || typeof response !== 'object') return response;
    try {
      return trackBody(response, track);
    } catch {
      return response;
    }
  }
  return fetch;
}
