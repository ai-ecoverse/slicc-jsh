import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// readline on a kernel terminal (openTerminal): raw mode, line editing,
// history, completion, ^C and ^D. The readline-node22 golden pins the bytes
// against Node 22.22.0 over a fake TTY.
describe('readline on a terminal (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  async function session(script, keys) {
    await jsh.kernel.writeFile('/os/rl-case.js', script);
    let out = '';
    const term = await jsh.kernel.openTerminal(['node', 'rl-case.js'], {
      cwd: '/os',
      onData: (d) => {
        // console colours a terminal's output, as Node: tests read it plain.
        out += decoder.decode(d).replace(/\x1b\[[0-9;]*m/g, '');
      },
    });
    for (const [after, key] of keys) {
      for (let i = 0; i < 200 && !after.test(out); i++) await new Promise((r) => setTimeout(r, 25));
      // The kernel applies raw mode a moment after setRawMode returns.
      await new Promise((r) => setTimeout(r, 150));
      term.write(key);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    if (status === 'timeout') term.close();
    return { out, status };
  }

  const repl = [
    "const readline = require('readline');",
    'const rl = readline.createInterface({',
    '  input: process.stdin,',
    '  output: process.stdout,',
    "  prompt: 'jsh> ',",
    "  completer: (line) => [['help', 'hello'].filter((c) => c.startsWith(line)), line],",
    '});',
    "console.log('terminal', rl.terminal, process.stdin.isRaw);",
    'rl.prompt();',
    "rl.on('line', (line) => { console.log(`got [${line}]`); rl.prompt(); });",
    "rl.on('SIGINT', () => { console.log('SIGINT'); rl.close(); });",
    "rl.on('close', () => console.log('closed', JSON.stringify(rl.history), process.stdin.isRaw));",
    '',
  ].join('\n');

  it('edits, recalls history, completes, and closes on ^C', async () => {
    const { out, status } = await session(repl, [
      [/jsh> /, 'hello\r'],
      [/got \[hello\]/, 'ab\x1b[Dc\r'], // left arrow: c goes before the cursor's char
      [/got \[abc\]/, '\x1b[A\x1b[A\r'], // up twice: "hello"
      // Keys in one chunk are a paste (Node turns completion off): type
      // the tabs on their own.
      [/got \[hello\][\s\S]*got \[hello\]/, 'hel'],
      [/hel$/, '\t'],
      [/hel$/, '\t'], // two candidates: listed
      [/help\s+hello/, 'p\r'],
      [/got \[help\]/, '\x03'], // ^C: readline's SIGINT, not the process's
    ]);
    assert.equal(status, 0, out);
    assert.match(out, /terminal true true/);
    assert.match(out, /got \[hello\]/);
    assert.match(out, /got \[abc\]/);
    assert.equal((out.match(/got \[hello\]/g) ?? []).length, 2, out);
    assert.match(out, /help\s+hello/);
    assert.match(out, /got \[help\]/);
    assert.match(out, /SIGINT/);
    assert.match(out, /closed \["help","hello","abc","hello"\] false/);
  });

  it('closes on ^D at an empty line', async () => {
    const { out, status } = await session(repl, [[/jsh> /, 'x\x7f\x04']]);
    assert.equal(status, 0, out);
    assert.match(out, /closed \[\] false/);
  });

  it('readline/promises question() on the terminal', async () => {
    const { out, status } = await session(
      [
        "const { createInterface } = require('readline/promises');",
        '(async () => {',
        '  const rl = createInterface({ input: process.stdin, output: process.stdout });',
        "  const a = await rl.question('name? ');",
        '  console.log(`hi ${a}`);',
        '  rl.close();',
        '})();',
        '',
      ].join('\n'),
      [[/name\? /, 'Ada\r']]
    );
    assert.equal(status, 0, out);
    assert.match(out, /hi Ada/);
  });
});
