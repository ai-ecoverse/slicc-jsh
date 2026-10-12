const { execFile } = require('child_process');
const fs = require('fs');

fs.mkdirSync('w-rc/sub', { recursive: true });
fs.writeFileSync('w-rc/sub/marker', 'here');

const mask = (s) => String(s).split(process.cwd()).join('CWD');

execFile(
  'node',
  ['-e', 'process.stdout.write(process.cwd()+"\\n"+require("fs").readFileSync("marker","utf8"))'],
  { cwd: 'w-rc/sub' },
  (err, stdout, stderr) => {
    console.log(
      'execFile relative cwd',
      err ? err.code : '',
      JSON.stringify(mask(stdout)),
      JSON.stringify(mask(stderr)).slice(0, 80)
    );
  }
);
