#!/usr/bin/env node
// The package's `bin` (dist/host/jsh.mjs). No static imports: inside
// slicc-kernel this file can end up running under jsh's own `node` runtime
// (a global pnpm/npm install puts this bin on PATH ahead of the kernel's
// `jsh` command), where the host CLI's Node builtins are not available. That
// runtime advertises the kernel jsh under this symbol (src/jsh/kernel.mjs);
// nothing else sets it, so a real host always gets the host CLI.
const kernel = globalThis[Symbol.for('slicc-jsh.kernel')];
if (kernel) await kernel.runJsh(process.argv.slice(2));
else await import('./main.mjs');
