const readline = require('readline');
const rlp = require('readline/promises');
const { PassThrough, Readable } = require('stream');
const log = (...a) => console.log(...a);

(async () => {
  // stdin, line by line.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  log('stdin lines', JSON.stringify(lines));

  // Chunks that split a \r\n, and empty lines.
  const split = readline.createInterface({ input: Readable.from(['a\r', '\nb\n\n', 'c']), crlfDelay: Infinity });
  const got = [];
  split.on('line', (l) => got.push(l));
  await new Promise((r) => split.on('close', r));
  log('split chunks', JSON.stringify(got));

  // question() on a non-terminal interface, and readline/promises.
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => (written += d));
  const q = readline.createInterface({ input, output, terminal: false });
  const answer = new Promise((r) => q.question('name? ', r));
  input.write('Ada\n');
  log('question', await answer, JSON.stringify(written));
  q.close();
  const pin = new PassThrough();
  const pq = rlp.createInterface({ input: pin, output: new PassThrough(), terminal: false });
  setTimeout(() => pin.write('Grace\n'), 5);
  log('promises question', await pq.question('who? '));
  const ac = new AbortController();
  const pending = pq.question('never? ', { signal: ac.signal });
  ac.abort();
  try {
    await pending;
  } catch (e) {
    log('aborted', e.name, e.code);
  }
  pq.close();
  try {
    await pq.question('closed? ');
  } catch (e) {
    log('after close', e.code, e.message);
  }

  // Keypress parsing.
  const keys = new PassThrough();
  readline.emitKeypressEvents(keys);
  const seen = [];
  keys.on('keypress', (s, k) => seen.push([s, k && k.name, k && k.ctrl, k && k.meta, k && k.shift, k && k.sequence]));
  keys.write('a\x1b[A\x1b[1;5C\x03\r\x1bb\x1b[3~\x7f\t');
  await new Promise((r) => setTimeout(r, 20));
  log('keypress', JSON.stringify(seen));

  // Terminal-mode editing over a fake TTY: what Node writes, byte for byte.
  const tin = new PassThrough();
  const tout = new PassThrough();
  tout.columns = 40;
  tout.rows = 10;
  tout.isTTY = true;
  let screen = '';
  tout.on('data', (d) => (screen += d));
  const t = readline.createInterface({ input: tin, output: tout, terminal: true, prompt: '> ', historySize: 5 });
  const tl = [];
  t.on('line', (l) => tl.push(l));
  t.prompt();
  tin.write('hello\r');
  tin.write('ab\x1b[Dc\r'); // left arrow, insert
  tin.write('\x1b[A\x1b[A\r'); // history up twice
  tin.write('word one\x17\r'); // ^W deletes a word
  tin.write('xyz\x01\x0b!\r'); // ^A, ^K, type
  await new Promise((r) => setTimeout(r, 20));
  log('terminal lines', JSON.stringify(tl), JSON.stringify(t.history), t.line, t.cursor);
  log('terminal output', JSON.stringify(screen));
  log('getCursorPos', JSON.stringify(t.getCursorPos()));
  t.close();

  // Cursor helpers and their errors.
  const out = [];
  const fake = { write: (s) => (out.push(s), true) };
  readline.cursorTo(fake, 2, 3);
  readline.moveCursor(fake, -1, 1);
  readline.clearLine(fake, 0);
  readline.clearScreenDown(fake);
  log('helpers', JSON.stringify(out));
  for (const f of [() => readline.cursorTo(fake, 'x'), () => readline.createInterface({ input, history: 1 }), () => readline.createInterface({ input, tabSize: 0 }), () => readline.createInterface({ input, completer: 1 })]) {
    try {
      f();
      log('no throw');
    } catch (e) {
      log('throw', e.name, e.code, e.message);
    }
  }
  log('exports', Object.keys(readline).sort().join(' '));
  log('promises exports', Object.keys(rlp).sort().join(' '));
})();
