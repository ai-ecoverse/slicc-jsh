// esbuild `inject`: the lib files' free `primordials` is this module's export.
import primordials from './primordials.cjs';

export { primordials };
