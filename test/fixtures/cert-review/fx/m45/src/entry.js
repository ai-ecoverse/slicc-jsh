import { run } from './orig.js';
try { run(); } catch (e) { console.log(e.stack.split('\n').slice(0, 3).map((l) => l.replace(/\(.*[\\/]/, '(').trim()).join(' | ')); }
run();
