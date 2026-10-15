import { a } from './lib/a.mjs';
const x = a;
throw new Error('esm uncaught ' + x);
