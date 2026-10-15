const readline = require('readline'); const { PassThrough } = require('stream');
console.log('exports', Object.keys(readline).sort().join(','));
const input = new PassThrough(), output = new PassThrough(); let o = ''; output.on('data', (d) => (o += d));
const rl = readline.createInterface({ input, output, terminal: false, historySize: 3 });
const lines = []; rl.on('line', (l) => lines.push(l));
input.write('a\nb\r\nc'); input.end('\n');
rl.on('close', () => {
  console.log('lines', JSON.stringify(lines), 'out', JSON.stringify(o));
  console.log('cursorTo', readline.cursorTo(output, 3), 'moveCursor', readline.moveCursor(output, 1, -1), 'clearLine', readline.clearLine(output, 0), 'clearScreenDown', readline.clearScreenDown(output));
  setImmediate(() => console.log('escapes', JSON.stringify(o)));
  // emitKeypressEvents on a non-tty stream
  const ks = new PassThrough(); readline.emitKeypressEvents(ks); const keys = [];
  ks.on('keypress', (s, k) => keys.push(`${JSON.stringify(s)}:${k && k.name}${k && k.ctrl ? '+ctrl' : ''}${k && k.shift ? '+shift' : ''}${k && k.meta ? '+meta' : ''}`));
  ks.write('aB\x1b[A\x1b[D\r\x7f\x03\x1bx\x1b[1;5C\t'); setImmediate(() => console.log('keys', keys.join(' ')));
  // completer through a terminal:true interface on fake streams
  const ci = new PassThrough(); const co = new PassThrough(); let cout = ''; co.on('data', (d) => (cout += d));
  const rl2 = readline.createInterface({ input: ci, output: co, terminal: true, completer: (line) => { const hits = ['apple', 'apricot', 'banana'].filter((c) => c.startsWith(line)); return [hits.length ? hits : [], line]; } });
  const got = []; rl2.on('line', (l) => got.push(l)); rl2.on('history', (h) => got.push('history:' + h.join('|')));
  ci.write('ban\t\r'); ci.write('ap\t'); setTimeout(() => { ci.write('r\t\r'); ci.write('\x1b[A\r'); setTimeout(() => { console.log('completer lines', JSON.stringify(got), 'line', JSON.stringify(rl2.line)); rl2.close(); }, 50); }, 50);
});
