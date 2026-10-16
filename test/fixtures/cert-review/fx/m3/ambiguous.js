import path from 'path';
console.log('ambiguous .js with import →', typeof path.join, typeof require, typeof module);
