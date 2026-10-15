// no error listener: what happens on EPIPE
function w() { while (process.stdout.write('z'.repeat(1000) + '\n')); process.stdout.once('drain', w); } w();
setTimeout(() => process.stderr.write('still alive after 3s\n'), 3000);
