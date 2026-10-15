const r = (n, cmd, timeout) => ({ name: n, cmd: `${cmd} > /tmp/m41.out 2>&1; echo "rc=$?"; head -8 /tmp/m41.out`, ...(timeout ? { timeout } : {}) });
export default [
  r('require-preload', 'node -r ./pre.js main.js'),
  r('require-long', 'node --require ./pre.js main.js'),
  r('require-e', 'node -r ./pre.js -e "console.log(typeof __preCaps)"'),
  r('require-missing', 'node -r ./nope-zz.js main.js'),
  r('require-empty-stdin', 'timeout 10 node -r ./pre.js < /dev/null', 30000),
  r('require-stdin-prog', 'echo "console.log(\'from stdin\', typeof __preCaps)" | node -r ./pre.js'),
  r('dash', 'echo "console.log(process.argv.slice(1).join(\'|\'))" | node - a b'),
  r('dash-empty', 'node - < /dev/null'),
  r('stack-limit', 'node --stack-trace-limit=2 -e "function f(n){ if(!n) throw new Error(\'deep\'); f(n-1) } try { f(10) } catch (e) { console.log(e.stack.split(\'\\n\').length) }"'),
  r('stack-limit-0', 'node --stack-trace-limit=0 -e "console.log(new Error(\'x\').stack)"'),
  r('stack-limit-space', 'node --stack-trace-limit 3 -e 1'),
  r('reqstack-uncaught', 'node lib/a.js'),
];
