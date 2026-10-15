const fs = require('fs'); const { execFile } = require('child_process'); const { promisify } = require('util'); const ef = promisify(execFile); const h = require('./h.cjs');
const d = require('path').resolve(h.fresh('w-binx')); const C = (s) => String(s).split(process.cwd()).join('CWD');
fs.mkdirSync(`${d}/pkg/node_modules/p2`, { recursive: true }); fs.mkdirSync(`${d}/bin`);
fs.writeFileSync(`${d}/pkg/node_modules/p2/index.js`, 'module.exports = "p2-ok"');
fs.writeFileSync(`${d}/pkg/tool.js`, "#!/usr/bin/env node\nconst C=(s)=>String(s).split(process.cwd()).join('CWD'); console.log('TOOL argv1', C(process.argv[1]), 'args', process.argv.slice(2).join(','), 'file', C(__filename), require('p2'));");
fs.chmodSync(`${d}/pkg/tool.js`, 0o755); fs.symlinkSync('../pkg/tool.js', `${d}/bin/tool`);
(async () => { for (const [f, a] of [[`${d}/bin/tool`, ['q']], ['sh', ['-c', 'PATH="$1:$PATH" tool z', 'x', `${d}/bin`]]]) { try { console.log(C((await ef(f, a, { encoding: 'utf8', cwd: d })).stdout).trim()); } catch (e) { console.log('ERR', e.code, C(e.stderr).slice(0, 300)); } } })();
