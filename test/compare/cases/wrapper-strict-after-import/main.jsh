let mode;
try { undeclaredStrictProbe = 1; mode = 'sloppy'; } catch (e) { mode = 'strict: ' + e.name; }
console.log(mode);
const m = await import('node:path');
console.log(typeof m.join);
