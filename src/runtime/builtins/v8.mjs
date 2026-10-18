/**
 * v8: what a program can ask of the engine without its C++ bindings — heap
 * and code statistics (approximate: the platform's performance.memory when
 * it has one), cachedDataVersionTag, setFlagsFromString (no flags change),
 * startupSnapshot (never building one; prettier asks), coverage and
 * snapshot no-ops, isStringOneByteRepresentation, and Serializer /
 * Deserializer with V8's ValueSerializer wire format (./v8-serdes.mjs), and
 * on them lib/v8.js's DefaultSerializer / DefaultDeserializer, serialize and
 * deserialize. Heap snapshots and queryObjects throw ERR_NOT_SUPPORTED.
 */
import { nodeError, validateString } from '../node-errors.mjs';
import { createSerdes } from './v8-serdes.mjs';

const notBuilding = () =>
  nodeError(Error, 'ERR_NOT_BUILDING_SNAPSHOT', 'Operation cannot be invoked when not building startup snapshot');

const notSupported = (what) =>
  nodeError(Error, 'ERR_NOT_SUPPORTED', `slicc-jsh: v8.${what} is not supported (no V8 bindings)`);

export function createV8({ Buffer } = {}) {
  const mem = () => globalThis.performance?.memory ?? {};
  const getHeapStatistics = () => {
    const m = mem();
    const used = m.usedJSHeapSize ?? 0;
    const total = m.totalJSHeapSize ?? used;
    const limit = m.jsHeapSizeLimit ?? 4 * 1024 * 1024 * 1024;
    return {
      total_heap_size: total,
      total_heap_size_executable: 0,
      total_physical_size: total,
      total_available_size: Math.max(0, limit - used),
      used_heap_size: used,
      heap_size_limit: limit,
      malloced_memory: 0,
      peak_malloced_memory: 0,
      does_zap_garbage: 0,
      number_of_native_contexts: 1,
      number_of_detached_contexts: 0,
      total_global_handles_size: 0,
      used_global_handles_size: 0,
      external_memory: 0,
    };
  };
  const SPACES = ['read_only_space', 'new_space', 'old_space', 'code_space', 'shared_space', 'trusted_space', 'new_large_object_space', 'large_object_space', 'code_large_object_space', 'shared_large_object_space', 'trusted_large_object_space'];

  const { Serializer, Deserializer } = createSerdes({ Buffer });

  // lib/v8.js (Node 22.22.0): the JS half of the serdes API.
  Serializer.prototype._getDataCloneError = Error;
  Deserializer.prototype.readRawBytes = function readRawBytes(length) {
    const offset = this._readRawBytes(length);
    // `this.buffer` can be a Buffer or a plain Uint8Array.
    return Buffer.from(this.buffer.buffer, this.buffer.byteOffset + offset, length);
  };

  const VIEW_TYPES = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    DataView,
    null, // 10: FastBuffer
    BigInt64Array,
    BigUint64Array,
    globalThis.Float16Array ?? null,
  ];
  const viewTypeToIndex = (view) => {
    const type = Object.prototype.toString.call(view);
    return VIEW_TYPES.findIndex((ctor) => ctor !== null && type === `[object ${ctor.name}]`);
  };
  const viewIndexToType = (index) => (index === 10 ? Buffer : VIEW_TYPES[index] ?? undefined);

  class DefaultSerializer extends Serializer {
    constructor() {
      super();
      this._setTreatArrayBufferViewsAsHostObjects(true);
    }

    // Buffers are written as their own bytes: their pooled ArrayBuffer may
    // hold other data, and is often much larger.
    _writeHostObject(abView) {
      let i = 10; // FastBuffer
      if (abView.constructor !== Buffer) {
        i = viewTypeToIndex(abView);
        if (i === -1) {
          throw new this._getDataCloneError(`Unserializable host object: ${String(abView)}`);
        }
      }
      this.writeUint32(i);
      this.writeUint32(abView.byteLength);
      this.writeRawBytes(new Uint8Array(abView.buffer, abView.byteOffset, abView.byteLength));
    }
  }

  class DefaultDeserializer extends Deserializer {
    _readHostObject() {
      const typeIndex = this.readUint32();
      const ctor = viewIndexToType(typeIndex);
      const byteLength = this.readUint32();
      const byteOffset = this._readRawBytes(byteLength);
      const BYTES_PER_ELEMENT = ctor.BYTES_PER_ELEMENT || 1;

      const offset = this.buffer.byteOffset + byteOffset;
      if (offset % BYTES_PER_ELEMENT === 0) {
        return ctor === Buffer
          ? Buffer.from(this.buffer.buffer, offset, byteLength)
          : new ctor(this.buffer.buffer, offset, byteLength / BYTES_PER_ELEMENT);
      }
      // Copy to an aligned buffer first.
      const copy = Buffer.allocUnsafe(byteLength);
      copy.set(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + byteOffset, byteLength));
      return ctor === Buffer
        ? copy
        : new ctor(copy.buffer, copy.byteOffset, byteLength / BYTES_PER_ELEMENT);
    }
  }

  function serialize(value) {
    const ser = new DefaultSerializer();
    ser.writeHeader();
    ser.writeValue(value);
    return ser.releaseBuffer();
  }

  function deserialize(buffer) {
    const der = new DefaultDeserializer(buffer);
    der.readHeader();
    return der.readValue();
  }

  class GCProfiler {
    start() {}
    stop() {
      return undefined;
    }
  }

  return {
    cachedDataVersionTag: () => 0x5ee55ee5,
    getHeapStatistics,
    getHeapSpaceStatistics: () =>
      SPACES.map((space_name) => ({ space_name, space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 })),
    getHeapCodeStatistics: () => ({
      code_and_metadata_size: 0,
      bytecode_and_metadata_size: 0,
      external_script_source_size: 0,
      cpu_profiler_metadata_size: 0,
    }),
    getCppHeapStatistics: () => ({
      committed_size_bytes: 0,
      resident_size_bytes: 0,
      used_size_bytes: 0,
      space_statistics: [],
      type_names: [],
      detail_level: 'brief',
    }),
    setFlagsFromString(flags) {
      validateString(flags, 'flags');
    },
    setHeapSnapshotNearHeapLimit() {},
    isStringOneByteRepresentation(content) {
      validateString(content, 'content');
      // eslint-disable-next-line no-control-regex
      return /^[\u0000-\u00ff]*$/.test(content);
    },
    takeCoverage() {},
    stopCoverage() {},
    getHeapSnapshot() {
      throw notSupported('getHeapSnapshot');
    },
    writeHeapSnapshot() {
      throw notSupported('writeHeapSnapshot');
    },
    queryObjects() {
      throw notSupported('queryObjects');
    },
    serialize,
    deserialize,
    Serializer,
    Deserializer,
    DefaultSerializer,
    DefaultDeserializer,
    GCProfiler,
    promiseHooks: {
      onInit: () => () => {},
      onSettled: () => () => {},
      onBefore: () => () => {},
      onAfter: () => () => {},
      createHook: () => () => {},
    },
    startupSnapshot: {
      // Node's key order; isBuildingSnapshot() is its flag (0) as is.
      addDeserializeCallback() {
        throw notBuilding();
      },
      addSerializeCallback() {
        throw notBuilding();
      },
      setDeserializeMainFunction() {
        throw notBuilding();
      },
      isBuildingSnapshot: () => 0,
    },
  };
}
