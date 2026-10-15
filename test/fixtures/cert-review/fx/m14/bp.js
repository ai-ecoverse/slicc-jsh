// backpressure: write until false, wait for drain, count drains; total must arrive
const N = Number(process.argv[2] ?? 2000), chunk = 'x'.repeat(1023) + '\n'; let i = 0, drains = 0, falses = 0;
function go() { while (i < N) { i++; if (!process.stdout.write(chunk)) { falses++; process.stdout.once('drain', () => { drains++; go(); }); return; } } process.stderr.write(`done falses>0=${falses > 0} drains==falses=${drains === falses}\n`); }
go();
