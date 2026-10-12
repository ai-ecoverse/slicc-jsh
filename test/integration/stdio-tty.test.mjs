import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// process.stdin/stdout on a kernel terminal (kernel.openTerminal): tty.ReadStream
// and tty.WriteStream. Off a terminal, the stdio-* and tty-pure goldens compare
// with Node 22.22.0; a pty can't be driven from the golden harness.
describe('stdio on a terminal (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  async function onTerminal(script, { cols = 100, rows = 30, steps = [] } = {}) {
    await jsh.kernel.writeFile('/os/tty-case.js', script);
    let out = '';
    const term = await jsh.kernel.openTerminal(['node', 'tty-case.js'], {
      cwd: '/os',
      cols,
      rows,
      onData: (d) => {
        out += decoder.decode(d);
      },
    });
    const until = async (re) => {
      for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 25));
    };
    for (const step of steps) {
      await until(step.after);
      step.do(term);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    if (status === 'timeout') term.close();
    return { out: out.replace(/\r\n/g, '\n'), status };
  }

  it('is a tty.ReadStream / tty.WriteStream with the terminal size and colors', async () => {
    const { out, status } = await onTerminal(
      [
        "const tty = require('tty');",
        "const { Readable, Writable } = require('stream');",
        'const o = process.stdout;',
        "console.log('isTTY', o.isTTY, process.stdin.isTTY, process.stderr.isTTY);",
        "console.log('classes', o.constructor.name, process.stdin.constructor.name, o instanceof tty.WriteStream, process.stdin instanceof tty.ReadStream, o instanceof Writable, process.stdin instanceof Readable);",
        "console.log('isatty', tty.isatty(0), tty.isatty(1), tty.isatty(2), tty.isatty(7));",
        "console.log('size', o.columns, o.rows, JSON.stringify(o.getWindowSize()));",
        "console.log('colors', o.getColorDepth(), o.hasColors(256));",
        "console.log('raw', process.stdin.isRaw);",
        '',
      ].join('\n'),
      { cols: 91, rows: 17 }
    );
    assert.equal(status, 0, out);
    assert.match(out, /^isTTY true true true$/m);
    assert.match(out, /^classes WriteStream ReadStream true true true true$/m);
    assert.match(out, /^isatty true true true false$/m);
    assert.match(out, /^size 91 17 \[91,17\]$/m);
    // openTerminal sets TERM=xterm-256color and COLORTERM=truecolor.
    assert.match(out, /^colors 24 true$/m);
    assert.match(out, /^raw false$/m);
  });

  it('setRawMode delivers each key at once; cursorTo/clearLine write escapes', async () => {
    const { out, status } = await onTerminal(
      [
        'process.stdin.setRawMode(true);',
        "console.log('raw', process.stdin.isRaw);",
        "process.stdout.cursorTo(4); process.stdout.clearLine(1); process.stdout.write('|\\n');",
        // The kernel applies raw mode asynchronously (Node: synchronously).
        "setTimeout(() => console.log('ready'), 300);",
        "process.stdin.once('data', (d) => {",
        "  console.log('key', JSON.stringify(d.toString()));",
        '  process.stdin.setRawMode(false);',
        '  process.stdin.pause();',
        '});',
        '',
      ].join('\n'),
      { steps: [{ after: /ready/, do: (t) => t.write('q') }] }
    );
    assert.equal(status, 0, out);
    assert.match(out, /^raw true$/m);
    assert.ok(out.includes('\x1b[5G\x1b[0K|'), JSON.stringify(out));
    // Raw: no echo, no waiting for Enter.
    assert.match(out, /^key "q"$/m);
  });

  it("emits 'resize' with the new size after SIGWINCH", async () => {
    const { out, status } = await onTerminal(
      [
        'const o = process.stdout;',
        "console.log('start', o.columns, o.rows, process.listenerCount('SIGWINCH'));",
        "o.on('resize', () => { console.log('resize', o.columns, o.rows); process.exit(0); });",
        "setTimeout(() => console.log('no resize'), 8000);",
        '',
      ].join('\n'),
      { steps: [{ after: /start/, do: (t) => t.resize(120, 40) }] }
    );
    assert.equal(status, 0, out);
    assert.match(out, /^start 100 30 1$/m);
    assert.match(out, /^resize 120 40$/m);
  });

  it('process.on(SIGINT) catches ^C; the default comes back when the listener is removed', async () => {
    const { out, status } = await onTerminal(
      [
        "const onInt = (sig, n) => { console.log('caught', sig, n); process.off('SIGINT', onInt); console.log('again'); };",
        "process.on('SIGINT', onInt);",
        // The kernel handler is installed asynchronously (Node's is not).
        "setTimeout(() => console.log('ready'), 300);",
        'setTimeout(() => {}, 10000);',
        '',
      ].join('\n'),
      {
        steps: [
          { after: /ready/, do: (t) => t.signal('SIGINT') },
          { after: /again/, do: (t) => setTimeout(() => t.signal('SIGINT'), 300) },
        ],
      }
    );
    assert.match(out, /^caught SIGINT 2$/m);
    // The second ^C has no listener: the default action ends the program.
    assert.equal(status, 130, out);
  });

  it('reads lines typed in canonical mode until ^D', async () => {
    const { out, status } = await onTerminal(
      [
        "process.stdin.setEncoding('utf8');",
        "let all = '';",
        "process.stdin.on('data', (c) => { all += c; });",
        "process.stdin.on('end', () => console.log('got', JSON.stringify(all)));",
        "console.log('ready');",
        '',
      ].join('\n'),
      {
        steps: [
          { after: /ready/, do: (t) => t.write('one\r') },
          { after: /one/, do: (t) => t.write('two\r\x04') },
        ],
      }
    );
    assert.equal(status, 0, out);
    assert.match(out, /^got "one\\ntwo\\n"$/m);
  });
});
