const r = (n, cmd) => ({ name: n, cmd });
const rep = 'rm -rf /tmp/m48r; mkdir -p /tmp/m48r; ';
const cnt = '; echo "rc=$?"; ls /tmp/m48r | wc -l | tr -d " "; node -e "for (const f of require(\x27fs\x27).readdirSync(\x27/tmp/m48r\x27)) { const h = JSON.parse(require(\x27fs\x27).readFileSync(\x27/tmp/m48r/\x27 + f)).header; console.log(h.event, h.trigger) }"';
export default [
  r('report-uncaught-cli', `${rep}node --report-uncaught-exception --report-directory=/tmp/m48r -e "throw new Error('ru')" 2>/dev/null${cnt}`),
  r('report-uncaught-nodeopts', `${rep}NODE_OPTIONS="--report-uncaught-exception --report-directory=/tmp/m48r" node -e "throw new Error('ru2')" 2>/dev/null${cnt}`),
  r('report-flags-read', 'node --report-on-signal --report-signal=SIGUSR1 --report-compact --report-filename=x.json --report-exclude-network -p "[process.report.reportOnSignal, process.report.signal, process.report.compact, process.report.filename, process.report.excludeNetwork].join(\' \')"'),
  r('report-on-signal-cli', `${rep}node --report-on-signal --report-directory=/tmp/m48r -e "process.kill(process.pid, 'SIGUSR2'); setTimeout(() => {}, 300)" 2>/dev/null${cnt}`),
  r('report-nodeopts-read', 'NODE_OPTIONS="--report-on-fatalerror --report-uncaught-exception" node -p "[process.report.reportOnFatalError, process.report.reportOnUncaughtException].join(\' \')"'),
  r('report-bad-signal', 'node --report-signal=SIGNOPE -e 1 2>&1 | head -2; echo "rc=${PIPESTATUS[0]}"'),
  r('title-cli', 'node --title=m48title -p process.title'),
  r('title-nodeopts', 'NODE_OPTIONS=--title=m48opt node -p process.title'),
  r('nodeopts-require', 'NODE_OPTIONS="--require ./req.js" node -e "console.log(\'main\')"'),
  r('nodeopts-quoted-space', 'NODE_OPTIONS="--require \\"./sp ace/r.js\\"" node -e "console.log(\'main\')"'),
  r('nodeopts-escaped-quote', 'NODE_OPTIONS="--title=\\"a\\\\\\"b\\"" node -p process.title'),
  r('nodeopts-disallowed-eval', 'NODE_OPTIONS="--eval=1" node -e 0 2>&1; echo "rc=$?"'),
  r('nodeopts-unknown', 'NODE_OPTIONS="--nope-flag" node -e 0 2>&1; echo "rc=$?"'),
  r('nodeopts-cli-wins', 'NODE_OPTIONS="--stack-trace-limit=1" node --stack-trace-limit=3 -p "Error.stackTraceLimit"'),
  r('nodeopts-unterminated', 'NODE_OPTIONS="--require \\"./x" node -e 0 2>&1; echo "rc=$?"'),
  r('nodeopts-not-in-execargv', 'NODE_OPTIONS="--title=t1" node -p "JSON.stringify(process.execArgv)"'),
  r('child-argv0', 'node -e "const cp=require(\'child_process\'); console.log(cp.spawnSync(process.execPath, [\'-p\', \'process.argv0\'], { argv0: \'zork-node\', encoding: \'utf8\' }).stdout.trim()); console.log(cp.execFileSync(process.execPath, [\'-p\', \'process.argv0\'], { argv0: \'zork2\', encoding: \'utf8\' }).trim())"'),
  r('argv0-default', 'node -p "process.argv0"'),
  r('argv0-ro-strict', 'node -e "\'use strict\'; try { process.argv0 = 1; console.log(\'set\') } catch (e) { console.log(e.name) }"'),
  r('argv0-execpath', 'node -p "process.argv[0] === process.execPath"'),
  r('ax-exclusive', 'echo x > /tmp/m48ax; node -e "const fs=require(\'fs\'); for (const fl of [\'ax\', \'ax+\', \'xa\', \'xa+\']) { try { fs.writeFileSync(\'/tmp/m48ax\', \'q\', { flag: fl }); console.log(fl, \'wrote\') } catch (e) { console.log(fl, e.code) } } fs.promises.writeFile(\'/tmp/m48ax\', \'q\', { flag: \'ax\' }).catch((e) => console.log(\'promises ax\', e.code)).then(() => fs.writeFile(\'/tmp/m48ax\', \'q\', { flag: \'ax+\' }, (e) => console.log(\'cb ax+\', e && e.code)))"; cat /tmp/m48ax; rm -f /tmp/m48ax; node -e "require(\'fs\').writeFileSync(\'/tmp/m48ax\', \'new\', { flag: \'ax\' })"; cat /tmp/m48ax'),
  r('trace-sigint', 'node --trace-sigint -e "console.log(\'ts ok\')"; echo "rc=$?"'),
];
