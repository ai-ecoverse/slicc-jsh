// esbuild `inject`: the lib files' free `primordials`, `internalBinding` and `process`
// are this module's exports (internalBinding is the runtime's,
// src/runtime/node-bindings.mjs).
import primordials from './primordials.cjs';
import { internalBinding, process } from '__jsh/internal-binding';

// `process` too: the program's, also before run.mjs makes it the global.
export { primordials, internalBinding, process };
