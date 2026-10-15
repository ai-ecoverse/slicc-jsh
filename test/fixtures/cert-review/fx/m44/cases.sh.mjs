const r = (n, cmd) => ({ name: n, cmd: `${cmd} > /tmp/m44.out 2>&1; echo "rc=$?"; head -6 /tmp/m44.out` });
export default [
  r('import-ok', 'node --import ./ok.mjs main.js'),
  r('import-fail', 'node --import ./fail.mjs main.js'),
  r('import-fail-handled', 'node --import ./fail.mjs -e "process.on(\'uncaughtException\', () => console.log(\'handled\'))" main.js'),
  r('import-never', 'node --import ./never.mjs main.js'),
  r('import-empty', 'node --import= main.js'),
  r('import-after-r', 'node -r ./main.js --import ./ok.mjs -e "console.log(globalThis.__imp)"'),
  r('trace-uncaught', 'node --trace-uncaught -e "throw new Error(\'tu\')"'),
  r('max-old-space', 'node --max-old-space-size=100 -e "console.log(\'mos ok\')"'),
  r('max-old-space-bad', 'node --max-old-space-size=abc -e 1'),
  r('stack-limit-bad', 'node --stack-trace-limit=abc -e 1'),
  r('ax-exclusive', 'echo x > /tmp/m44ax; node -e "try { require(\'fs\').writeFileSync(\'/tmp/m44ax\', \'q\', { flag: \'ax\' }); console.log(\'ax wrote\') } catch (e) { console.log(\'ax\', e.code) } try { require(\'fs\').appendFileSync(\'/tmp/m44ax\', \'q\', { flag: \'ax+\' }); console.log(\'ax+ wrote\') } catch (e) { console.log(\'ax+\', e.code) }"'),
];
