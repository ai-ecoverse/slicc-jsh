import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJsh } from './helpers.mjs';

const needs = kernelAtLeast('1.126.0') ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.sync.tty.setRaw (1.126.0): a key typed at the prompt can beat raw mode` };

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
        out += decoder.decode(d);
      },
    });
    // console colours a terminal's output, as Node: read it plain (stripped
    // whole, so a sequence split across chunks goes too).
    const plain = () => out.replace(/\x1b\[[0-9;]*m/g, '');
    for (const [after, key] of keys) {
      const seen = async () => (typeof after === 'function' ? after() : after.test(plain()));
      for (let i = 0; i < 200 && !(await seen()); i++) await new Promise((r) => setTimeout(r, 25));
      term.write(key);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    if (status === 'timeout') term.close();
    return { out: plain(), status };
  }

  const tabsSeen = (n) => async () => Number(decoder.decode(await jsh.kernel.readFile('/os/rl-tabs').catch(() => new Uint8Array()))) >= n;

  const repl = [
    "const readline = require('readline');",
    'let tabs = 0;',
    'const rl = readline.createInterface({',
    '  input: process.stdin,',
    '  output: process.stdout,',
    "  prompt: 'jsh> ',",
    "  completer: (line) => { require('fs').writeFileSync('/os/rl-tabs', String(++tabs)); return [['help', 'hello'].filter((c) => c.startsWith(line)), line]; },",
    '});',
    "console.log('terminal', rl.terminal, process.stdin.isRaw);",
    'rl.prompt();',
    "rl.on('line', (line) => { console.log(`got [${line}]`); rl.prompt(); });",
    "rl.on('SIGINT', () => { console.log('SIGINT'); rl.close(); });",
    "rl.on('close', () => console.log('closed', JSON.stringify(rl.history), process.stdin.isRaw));",
    '',
  ].join('\n');

  it('edits, recalls history, completes, and closes on ^C', needs, async () => {
    const { out, status } = await session(repl, [
      [/jsh> /, 'hello\r'],
      [/got \[hello\]/, 'ab\x1b[Dc\r'], // left arrow: c goes before the cursor's char
      [/got \[abc\]/, '\x1b[A\x1b[A\r'], // up twice: "hello"
      // Keys in one chunk are a paste (Node turns completion off): type
      // the tabs on their own.
      [/got \[hello\][\s\S]*got \[hello\]/, 'hel'],
      [/hel$/, '\t'],
      [tabsSeen(1), '\t'], // two candidates: listed
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

  it('closes on ^D at an empty line', needs, async () => {
    const { out, status } = await session(repl, [[/jsh> /, 'x\x7f\x04']]);
    assert.equal(status, 0, out);
    assert.match(out, /closed \[\] false/);
  });

  it('readline/promises question() on the terminal', needs, async () => {
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
