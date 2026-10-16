const N = ' 2>&1 | head -40; echo "rc=${PIPESTATUS[0]}"';
export default [
  { name: 'resolve', cmd: 'node resolve.mjs' + N },
  { name: 'frames', cmd: 'node frames.mjs' + N },
  { name: 'uncaught', cmd: 'node uncaught.mjs' + N },
  { name: 'uncaught-prim', cmd: 'node uncaught-prim.mjs' + N },
  { name: 'bad-import', cmd: 'node bad-import.mjs' + N },
  { name: 'bad-named', cmd: 'node bad-named.mjs' + N },
  { name: 'meta-default', cmd: 'node meta-default.mjs' + N },
  { name: 'eval-module', cmd: 'node --input-type=module -e "console.log(import.meta.url.replace(/.*\\//, \'\'), typeof import.meta.dirname); const m = await import(\'./lib/a.mjs\'); console.log(m.a); throw new Error(\'eval-esm\')"' + N },
  { name: 'stdin-module', cmd: 'echo "import { a } from \'./lib/a.mjs\'; console.log(a, import.meta.url.replace(/.*\\//, \'\'))" | node --input-type=module' + N },
  { name: 'cjs-require-ext', cmd: 'node -e "console.log(require(\'./lib/c\').c, require(\'plain\').p, require(\'plain/other\').q)"' + N },
  { name: 'import-sliccy-plain-node', cmd: 'node --input-type=module -e "await import(\'sliccy:fmt\')"' + N },
];
