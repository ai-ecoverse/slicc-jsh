const { execFile, spawnSync } = require('child_process'); const fs = require('fs');
fs.mkdirSync('w-rc/sub', { recursive: true }); fs.writeFileSync('w-rc/sub/marker', 'here');
const C = (s) => String(s).split(process.cwd()).join('CWD');
execFile('sh', ['-c', 'pwd; cat marker'], { cwd: 'w-rc/sub' }, (e, o, s) => console.log('execFile relative cwd', e ? e.code : '', JSON.stringify(C(o)), JSON.stringify(C(s)).slice(0, 80)));
