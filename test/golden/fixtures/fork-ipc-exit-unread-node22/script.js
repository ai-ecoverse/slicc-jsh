// A program that exits with IPC data queued for a peer that never reads the
// channel, and waits for the program to end: Node's exit doesn't wait for
// the queue (it's lost), so both end. middle.js queues 4 MiB to a shell
// whose stdin is middle's pipe, then exits; the shell ends on that pipe's
// end of file. 'close' comes once the shell, which shares middle's stdout,
// is gone too.
const { spawn } = require('child_process');
const path = require('path');
const middle = spawn(process.execPath, [path.join(__dirname, 'middle.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
middle.stdout.on('data', (d) => (out += d));
middle.on('exit', (code, signal) => console.log('middle exit', code, signal));
middle.on('close', () => process.stdout.write(out));
