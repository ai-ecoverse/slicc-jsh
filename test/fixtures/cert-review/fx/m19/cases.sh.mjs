export default [
  { name: 'exitcode-listener', cmd: 'node exitcode.js; echo rc=$?' },
  { name: 'exitcode-listener2', cmd: 'node exitcode2.js; echo rc=$?' },
  { name: 'exitcode-listener3', cmd: 'node exitcode3.js; echo rc=$?' },
  { name: 'input-type-module', cmd: 'echo "import { sep } from \'node:path\'; console.log(sep, typeof import.meta, await Promise.resolve(5))" | node --input-type=module; echo rc=$?' },
  { name: 'input-type-module-eval', cmd: 'node --input-type=module -e "import os from \'node:os\'; console.log(typeof os.EOL, import.meta.url.slice(0, 5))"; echo rc=$?' },
  { name: 'input-type-commonjs', cmd: 'node --input-type=commonjs -e "console.log(typeof require, typeof module)"' },
  { name: 'input-type-bogus', cmd: 'node --input-type=bogus -e "1" 2>&1 | head -2; echo rc=${PIPESTATUS[0]}' },
  { name: 'eval-esm-syntax', cmd: 'node -e "import(\'node:fs\').then((m) => console.log(typeof m.readFileSync))"' },
  { name: 'trace-stderr', cmd: 'node -e "console.trace(\'t\')" 2>&1 | head -1' },
  { name: 'colors-tty-env', cmd: 'FORCE_COLOR=1 node -e "console.log({a:1}, \'s\')" | od -c | head -3' },
  { name: 'no-color', cmd: 'NO_COLOR=1 FORCE_COLOR=1 node -e "console.log({a:1})"' },
];
