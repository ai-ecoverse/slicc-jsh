import cjs, { named, add } from 'cjspkg';
import { kind } from 'condpkg';
import sub from 'condpkg/sub';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
console.log(JSON.stringify(Object.keys(cjs).sort()), named, add(2, 3), kind, sub, require('condpkg').kind, require('cjspkg').named);
