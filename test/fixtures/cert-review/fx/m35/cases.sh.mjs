const u = (m) => ({ name: `unh-${m}`, cmd: `node unh.js ${m} > /tmp/unh.out 2>&1; echo "rc=$?"; head -12 /tmp/unh.out` });
export default [
  ...['listener', 'both', 'monitor', 'nonerror', 'capture', 'none', 'late', 'throwing-listener', 'async-fn'].map(u),
  { name: 'cli-e-then-opts', cmd: 'node -e "console.log(JSON.stringify(process.execArgv), JSON.stringify(process.argv.slice(1)))" --no-warnings a b; echo "rc=$?"' },
  { name: 'cli-p-then-opts', cmd: 'node -p "process.execArgv.join(\' \') + \'|\' + process.argv.slice(1).join(\' \')" --no-deprecation x --trace-warnings; echo "rc=$?"' },
  { name: 'cli-opts-order', cmd: 'node --no-warnings --stack-trace-limit=5 --trace-uncaught cli.js q --r; echo "rc=$?"' },
  { name: 'cli-e-dashdash', cmd: 'node -e "console.log(process.argv.slice(1).join(\',\'))" -- --no-warnings z; echo "rc=$?"' },
  { name: 'cli-e-require', cmd: 'node -e "console.log(typeof require(\'vm\').Script)" -r ./cli.js; echo "rc=$?"' },
  { name: 'cli-bad-after-e', cmd: 'node -e 1 --bogus-flag 2>&1 | head -2; echo "rc=${PIPESTATUS[0]}"' },
  { name: 'cli-input-type', cmd: 'node --input-type=module -e "console.log(typeof import.meta)" --no-warnings; echo "rc=$?"' },
  { name: 'repl-pipe', cmd: 'printf "1+1\\nconsole.log(\\"piped\\", typeof require)\\n" | node; echo "rc=$?"' },
  { name: 'repl-pipe-dash', cmd: 'printf "console.log(40+2)\\n" | node -; echo "rc=$?"' },
  { name: 'repl-i-pipe', cmd: 'printf "21*2\\n.exit\\n" | node -i 2>&1 | tr -d "\\r"; echo "rc=${PIPESTATUS[1]}"' },
  { name: 'repl-input-type', cmd: 'printf "1\\n" | node -i --input-type=module 2>&1 | head -2; echo "rc=${PIPESTATUS[1]}"' },
  { name: 'repl-module-builtins', cmd: 'node -p "require(\'repl\').builtinModules.length > 30 && typeof require(\'repl\').start"' },
  { name: 'cli-r', cmd: 'node -r ./cli.js -e 1; echo "rc=$?"; node --require ./cli.js -e 1 | head -1; node --import ./vm2.mjs -e 1 | head -1' },
  { name: 'cli-v8-opts', cmd: 'node --stack-trace-limit=2 -e "console.log(1)"; echo "rc=$?"; node --max-old-space-size=100 -e "console.log(2)"; echo "rc=$?"' },
  { name: 'require-repl', cmd: 'node -e "const r = require(\'node:repl\'); console.log(typeof r.start, typeof r.REPLServer)"; echo "rc=$?"' },
];
