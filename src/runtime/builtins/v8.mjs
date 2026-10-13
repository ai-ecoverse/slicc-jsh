/**
 * v8: what a program can ask of the engine without its C++ bindings — heap
 * and code statistics (approximate: the platform's performance.memory when
 * it has one), cachedDataVersionTag, setFlagsFromString (no flags change),
 * startupSnapshot (never building one; prettier asks), coverage and
 * snapshot no-ops, isStringOneByteRepresentation, and Node's
 * Serializer/Deserializer names. serialize / deserialize need V8's
 * ValueSerializer wire format: they throw ERR_NOT_SUPPORTED, as do heap
 * snapshots and queryObjects.
 */
import { nodeError, validateString } from '../node-errors.mjs';

const notBuilding = () =>
  nodeError(Error, 'ERR_NOT_BUILDING_SNAPSHOT', 'Operation cannot be invoked when not building startup snapshot');

const notSupported = (what) =>
  nodeError(Error, 'ERR_NOT_SUPPORTED', `slicc-jsh: v8.${what} is not supported (no V8 bindings)`);

export function createV8() {
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

  class Serializer {
    constructor() {
      throw notSupported('Serializer');
    }
  }
  class Deserializer {
    constructor() {
      throw notSupported('Deserializer');
    }
  }
  class DefaultSerializer extends Serializer {}
  class DefaultDeserializer extends Deserializer {}
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
    serialize() {
      throw notSupported('serialize');
    },
    deserialize() {
      throw notSupported('deserialize');
    },
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
