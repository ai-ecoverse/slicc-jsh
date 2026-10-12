// esbuild `inject`: the lib files' free `primordials` and `internalBinding`
// are this module's exports (internalBinding is the runtime's,
// src/runtime/node-bindings.mjs).
import primordials from './primordials.cjs';
import { internalBinding } from '__jsh/internal-binding';

export { primordials, internalBinding };
