export default [
  { name: 'yargs-cmd', cmd: 'node ycli.mjs greet bob -l; echo rc=$?' },
  { name: 'yargs-help', cmd: 'node ycli.mjs --help; echo rc=$?' },
  { name: 'yargs-strict', cmd: 'node ycli.mjs greet bob --bogus 2>&1; echo rc=$?' },
  { name: 'yargs-none', cmd: 'node ycli.mjs 2>&1; echo rc=$?' },
];
