/**
 * globalThis.fetch → ctx.fetch (kernel transport / proxy routes).
 */
export function createFetch(ctx) {
  async function fetch(input, init) {
    if (typeof ctx.fetch !== 'function') {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error("slicc-jsh: ctx.fetch is not available"), {
        code: 'ENOTSUP',
      });
      throw err;
    }
    return ctx.fetch(input, init);
  }
  return fetch;
}
