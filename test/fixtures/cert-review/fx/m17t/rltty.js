// readline on a real tty; events go to the log file argv[3] (the screen is not compared)
const fs = require('fs'); const readline = require('readline');
const mode = process.argv[2], LOG = process.argv[3];
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
log('start', mode, 'isTTY', !!process.stdin.isTTY, !!process.stdout.isTTY, typeof process.stdin.setRawMode, process.stdout.columns > 0);
if (mode === 'basic') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'P> ', historySize: 5,
    completer: (line) => { const hits = ['apple', 'apricot', 'banana'].filter((c) => c.startsWith(line)); return [hits, line]; } });
  log('terminal', rl.terminal);
  rl.on('line', (l) => { log('line', l, 'history', rl.history); rl.prompt(); });
  rl.on('history', (h) => log('history-event', h));
  rl.on('SIGINT', () => { log('rl SIGINT, line was', rl.line); rl.write(null, { ctrl: true, name: 'u' }); rl.prompt(); });
  rl.on('close', () => { log('close'); process.exit(0); });
  rl.prompt();
} else if (mode === 'nosigint') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => log('close'));
  process.on('exit', (c) => log('exit', c));
  rl.on('line', (l) => log('line', l));
  rl.prompt();
} else if (mode === 'keypress') {
  readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); log('isRaw', process.stdin.isRaw);
  process.stdin.on('keypress', (s, k) => { log('key', s ?? null, k && k.name, !!(k && k.ctrl), !!(k && k.meta), !!(k && k.shift), k && k.sequence); if (k && k.name === 'q') { process.stdin.setRawMode(false); log('isRaw', process.stdin.isRaw); process.exit(0); } });
} else if (mode === 'promises') {
  const rlp = require('readline/promises');
  (async () => {
    const rl = rlp.createInterface({ input: process.stdin, output: process.stdout });
    log('answer', await rl.question('q1? '));
    const ac = new AbortController(); setTimeout(() => ac.abort(), 400);
    try { await rl.question('q2? ', { signal: ac.signal }); log('no abort?'); } catch (e) { log('abort', e.name, e.code); }
    log('answer3', await rl.question('q3? '));
    rl.close(); log('closed');
  })();
} else if (mode === 'question-ctrl-d') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('q? ', (a) => log('answer', a)); rl.on('close', () => log('close'));
}
