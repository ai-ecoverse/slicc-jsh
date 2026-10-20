const { spawn, fork } = require('child_process');
const [, , role, name] = process.argv;
const self = __filename;

if (role === 'idle') {
  process.stdin.on('end', () => process.exit(0)).resume();
  process.on('disconnect', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (role === 'case') {
  setTimeout(() => {
    console.log(name, 'held');
    process.exit(3);
  }, 1000).unref();
  let child;
  if (name === 'fork') {
    child = fork(self, ['idle'], { stdio: 'pipe' });
    child.channel.unref();
    child.stdout.unref();
    child.stderr.unref();
  } else {
    const out = name.startsWith('pipe') ? 'pipe' : 'ignore';
    child = spawn(process.execPath, [self, 'idle'], { stdio: ['pipe', out, 'ignore'] });
    if (name === 'pipe-unref') child.stdout.unref();
  }
  child.stdin.unref();
  child.unref();
  if (name === 'ref-again') child.ref();
  console.log(name, typeof child.pid, JSON.stringify(process.getActiveResourcesInfo()));
} else {
  const names = ['ignore', 'pipe-unref', 'pipe-ref', 'fork', 'ref-again'];
  (async () => {
    for (const n of names) {
      const code = await new Promise((resolve) => spawn(process.execPath, [self, 'case', n], { stdio: ['ignore', 'inherit', 'inherit'] }).on('exit', resolve));
      console.log(n, 'exit', code);
    }
  })();
}
