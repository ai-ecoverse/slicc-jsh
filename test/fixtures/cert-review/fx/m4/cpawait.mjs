import { execFile, spawn } from 'node:child_process'; import { promisify } from 'node:util'; import { once } from 'node:events';
const ef = promisify(execFile);
const { stdout } = await ef('sh', ['-c', 'echo awaited-exec']);
console.log('promisified execFile', JSON.stringify(stdout));
const c = spawn('sh', ['-c', 'echo spawned; exit 3']); let o = ''; c.stdout.on('data', (x) => (o += x)); const [code] = await once(c, 'close'); console.log('spawn awaited', JSON.stringify(o), code);
