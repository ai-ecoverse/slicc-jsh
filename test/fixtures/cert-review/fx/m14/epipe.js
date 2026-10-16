// writer into a closed pipe: Node gets EPIPE on stdout (error event); default = exit
let n = 0; process.stdout.on('error', (e) => { process.stderr.write(`stdout error ${e.code} after ${n > 0}\n`); process.exit(3); });
function w() { while (process.stdout.write('y'.repeat(1000) + '\n')) n++; process.stdout.once('drain', w); } w();
