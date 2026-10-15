export default [
  { name: 'use', cmd: 'node use.mjs 2>&1' },
  { name: 'prettier-cli', cmd: 'echo "const  a = {b:1}" > /tmp/p.js; node node_modules/prettier/bin/prettier.cjs /tmp/p.js 2>&1; echo rc=$?' },
  { name: 'marked-cli', cmd: 'echo "# T" | node node_modules/marked/bin/marked.js 2>&1; echo rc=$?' },
  { name: 'yaml-cli', cmd: 'echo "a: 1" | node node_modules/yaml/bin.mjs --json 2>&1 | head -3; echo rc=$?' },
  { name: 'nanoid-cli', cmd: 'node node_modules/nanoid/bin/nanoid.js --size 5 2>&1 | wc -c; echo rc=$?' },
];
