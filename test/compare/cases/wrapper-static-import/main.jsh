import path from 'node:path';
import { readFileSync } from 'fs';
console.log(path.basename('/a/b.txt'), typeof readFileSync);
console.log('typeof __filename', typeof __filename);
