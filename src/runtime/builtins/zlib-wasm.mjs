const SIZE = 4;

function createRuntime(bytes) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const e = instance.exports;
  e._initialize?.();
  const heap = () => new Uint8Array(e.memory.buffer);
  const u32 = () => new Uint32Array(e.memory.buffer);
  const scratch = (state, key, size) => {
    const slot = state[key];
    if (slot && slot.size >= size) return slot.ptr;
    if (slot) e.free(slot.ptr);
    const ptr = e.malloc(Math.max(size, 1));
    if (!ptr) throw new WebAssembly.RuntimeError('memory allocation failed');
    state[key] = { ptr, size: Math.max(size, 1) };
    return ptr;
  };
  const release = (state) => {
    for (const key of ['inBuf', 'outBuf', 'args']) {
      if (state[key]) e.free(state[key].ptr);
      state[key] = null;
    }
  };
  const input = (state, view, inOff, inLen) => {
    const start = view.byteOffset + inOff;
    const held = state.held;
    if (held && held.buffer === view.buffer && held.start === start && held.length === inLen) return held.ptr;
    const ptr = scratch(state, 'inBuf', inLen);
    heap().set(view.subarray(inOff, inOff + inLen), ptr);
    return ptr;
  };
  const hold = (state, view, inOff, inLen, inPtr, consumed) => {
    state.held =
      consumed < inLen
        ? { buffer: view.buffer, start: view.byteOffset + inOff + consumed, length: inLen - consumed, ptr: inPtr + consumed }
        : null;
  };
  const output = (out, outOff, outPtr, produced) => {
    if (produced > 0) out.set(heap().subarray(outPtr, outPtr + produced), outOff);
  };
  return { e, heap, u32, scratch, release, input, hold, output };
}

const finalizer = (free) =>
  typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(free) : { register() {}, unregister() {} };

export function brotliEncoderModule(bytes, dictionary) {
  const rt = createRuntime(bytes);
  const { e } = rt;
  const dict = e.malloc(dictionary.length);
  rt.heap().set(dictionary, dict);
  e.BrotliSetDictionaryData(dict);
  const registry = finalizer((state) => {
    if (state.ptr) e.BrotliEncoderDestroyInstance(state.ptr);
    rt.release(state);
  });

  class BrotliEncoder {
    constructor() {
      const ptr = e.BrotliEncoderCreateInstance(0, 0, 0);
      this.state = { ptr, held: null };
      this.availIn = 0;
      this.availOut = 0;
      if (ptr) registry.register(this, this.state, this);
    }

    get ok() {
      return this.state.ptr !== 0;
    }

    setParameter(key, value) {
      return e.BrotliEncoderSetParameter(this.state.ptr, key, value >>> 0) !== 0;
    }

    compressStream(op, input, inOff, inLen, out, outOff, outLen) {
      const s = this.state;
      const inPtr = rt.input(s, input, inOff, inLen);
      const outPtr = rt.scratch(s, 'outBuf', outLen);
      const args = rt.scratch(s, 'args', 4 * SIZE);
      const u = rt.u32();
      const a = args >>> 2;
      u[a] = inLen;
      u[a + 1] = inPtr;
      u[a + 2] = outLen;
      u[a + 3] = outPtr;
      const result = e.BrotliEncoderCompressStream(s.ptr, op, args, args + SIZE, args + 2 * SIZE, args + 3 * SIZE, 0);
      const v = rt.u32();
      this.availIn = v[a];
      this.availOut = v[a + 2];
      rt.output(out, outOff, outPtr, outLen - this.availOut);
      rt.hold(s, input, inOff, inLen, inPtr, inLen - this.availIn);
      return result !== 0;
    }

    destroy() {
      registry.unregister(this);
      const s = this.state;
      if (s.ptr) e.BrotliEncoderDestroyInstance(s.ptr);
      s.ptr = 0;
      rt.release(s);
    }
  }

  return { BrotliEncoder };
}

export function zstdCompressModule(bytes) {
  const rt = createRuntime(bytes);
  const { e } = rt;
  const registry = finalizer((state) => {
    if (state.ptr) e.ZSTD_freeCCtx(state.ptr);
    rt.release(state);
  });

  class CCtx {
    constructor() {
      const ptr = e.ZSTD_createCCtx();
      this.state = { ptr, held: null };
      this.availIn = 0;
      this.availOut = 0;
      if (ptr) registry.register(this, this.state, this);
    }

    get ok() {
      return this.state.ptr !== 0;
    }

    static error(ret) {
      return e.ZSTD_isError(ret) ? e.ZSTD_getErrorCode(ret) : 0;
    }

    setParameter(key, value) {
      return CCtx.error(e.ZSTD_CCtx_setParameter(this.state.ptr, key, value | 0));
    }

    setPledgedSrcSize(size) {
      return CCtx.error(e.ZSTD_CCtx_setPledgedSrcSize(this.state.ptr, size));
    }

    loadDictionary(dictionary) {
      const s = this.state;
      const ptr = rt.scratch(s, 'inBuf', dictionary.length);
      rt.heap().set(dictionary, ptr);
      return CCtx.error(e.ZSTD_CCtx_loadDictionary(s.ptr, ptr, dictionary.length));
    }

    compressStream2(directive, input, inOff, inLen, out, outOff, outLen) {
      const s = this.state;
      const inPtr = rt.input(s, input, inOff, inLen);
      const outPtr = rt.scratch(s, 'outBuf', outLen);
      const args = rt.scratch(s, 'args', 6 * SIZE);
      const u = rt.u32();
      const a = args >>> 2;
      u[a] = outPtr;
      u[a + 1] = outLen;
      u[a + 2] = 0;
      u[a + 3] = inPtr;
      u[a + 4] = inLen;
      u[a + 5] = 0;
      const ret = e.ZSTD_compressStream2(s.ptr, args, args + 3 * SIZE, directive);
      const v = rt.u32();
      const produced = v[a + 2];
      const consumed = v[a + 5];
      this.availIn = inLen - consumed;
      this.availOut = outLen - produced;
      rt.output(out, outOff, outPtr, produced);
      rt.hold(s, input, inOff, inLen, inPtr, consumed);
      return CCtx.error(ret);
    }

    destroy() {
      registry.unregister(this);
      const s = this.state;
      if (s.ptr) e.ZSTD_freeCCtx(s.ptr);
      s.ptr = 0;
      rt.release(s);
    }
  }

  return { CCtx };
}
