const r = (n, cmd) => ({ name: n, cmd: `${cmd} > /tmp/m45.out 2>&1; echo "rc=$?"; head -8 /tmp/m45.out` });
export default [
  r('execve', 'node -e "process.on(\'exit\', () => console.log(\'exit listener\')); console.log(\'before\'); process.execve(\'/bin/sh\', [\'sh\', \'-c\', \'echo replaced \\$0 \\$FOO\'], { FOO: \'bar\' }); console.log(\'after\')"'),
  r('execve-missing', 'node -e "try { process.execve(\'/nope/zz\', [\'zz\']) } catch (e) { console.log(e.code, e.syscall) }"'),
  r('reallyExit', 'node -e "process.on(\'exit\', () => console.log(\'exit listener\')); process.reallyExit(3)"'),
  { name: 'report-uncaught', cmd: 'rm -rf /tmp/rpt && mkdir /tmp/rpt && cd /tmp/rpt && node --report-uncaught-exception -e "throw new Error(\'boom\')" > out.txt 2>&1; echo "rc=$?"; for f in report.*.json; do [ -e "$f" ] && node -e "const r = require(\'/tmp/rpt/\' + process.argv[1]); console.log(\'report\', r.header.event, r.header.trigger, typeof r.javascriptStack, r.javascriptStack && r.javascriptStack.message)" "$f"; done; head -c 300 out.txt | tr -d "\\r" | head -3' },
  { name: 'report-signal', cmd: 'rm -rf /tmp/rps && mkdir /tmp/rps && cd /tmp/rps && node --report-on-signal -e "process.kill(process.pid, \'SIGUSR2\'); setTimeout(() => console.log(\'alive\'), 500)"; echo "rc=$?"; for f in report.*.json; do [ -e "$f" ] && node -e "const r = require(\'/tmp/rps/\' + process.argv[1]); console.log(\'report\', r.header.event, r.header.trigger)" "$f"; done; true' },
  r('writeReport', 'cd /tmp && node -e "const f = process.report.writeReport(\'/tmp/wr.json\'); const r = require(f); console.log(\'wrote\', require(\'path\').basename(f), r.header.trigger, r.header.event)"'),
  r('sourcemap-cjs-on', 'node --enable-source-maps bundle.cjs'),
  r('sourcemap-cjs-off', 'node bundle.cjs'),
  r('sourcemap-esm-on', 'node --enable-source-maps bundle.mjs'),
  r('setSourceMapsEnabled', 'node -e "process.setSourceMapsEnabled(true); require(\'./bundle.cjs\')"'),
  r('findSourceMap', 'node -e "const m = require(\'module\'); require(\'./bundle.cjs\')" ; node --enable-source-maps -e "const m = require(\'module\'); try { require(\'./bundle.cjs\') } catch {} const sm = m.findSourceMap(require.resolve(\'./bundle.cjs\')); console.log(typeof sm, sm && sm.payload.sources.map((s) => s.replace(/.*\\//, \'\')).join(\',\'), sm && JSON.stringify(sm.findEntry(2, 10)).slice(0, 80))"'),
  { name: 'report-uncaught-prop', cmd: 'rm -rf /tmp/rpu && mkdir /tmp/rpu && cd /tmp/rpu && node -e "process.report.reportOnUncaughtException = true; throw new Error(\'boom2\')" > out.txt 2>&1; echo "rc=$?"; for f in report.*.json; do [ -e "$f" ] && node -e "const r = require(\'/tmp/rpu/\' + process.argv[1]); console.log(\'report\', r.header.event, r.header.trigger, r.javascriptStack.message)" "$f"; done; head -3 out.txt' },
  { name: 'report-signal-prop', cmd: 'rm -rf /tmp/rpq && mkdir /tmp/rpq && cd /tmp/rpq && node -e "process.report.reportOnSignal = true; process.kill(process.pid, \'SIGUSR2\'); setTimeout(() => console.log(\'alive\'), 500)" 2>/dev/null; echo "rc=$?"; for f in report.*.json; do [ -e "$f" ] && node -e "const r = require(\'/tmp/rpq/\' + process.argv[1]); console.log(\'report\', r.header.event, r.header.trigger)" "$f"; done; true' },
  r('report-env-flags', 'NODE_OPTIONS=--report-uncaught-exception node -e "console.log(process.report.reportOnUncaughtException)"'),
];
