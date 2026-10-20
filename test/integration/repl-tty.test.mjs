import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJsh } from './helpers.mjs';

const needs = kernelAtLeast('1.126.0') ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.sync.tty.setRaw (1.126.0): a key typed at the prompt can beat raw mode` };

// `node` with no script on a kernel terminal: Node's REPL (lib/repl.js).
// The repl-piped-node22 golden pins what it prints against Node 22.22.0
// (node -i over a pipe); here, the terminal: the prompt, line editing,
// multi-line input, ^C / ^D / .exit, errors (also from a timer), history.
describe('the REPL on a terminal (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  const plainOf = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  async function session(keys, { argv = ['node'], env = {}, home = '/os' } = {}) {
    let out = '';
    const term = await jsh.kernel.openTerminal(argv, {
      cwd: '/os',
      env: { HOME: home, ...env },
      onData: (d) => {
        out += decoder.decode(d);
      },
    });
    for (const [after, key] of keys) {
      for (let i = 0; i < 200 && !after.test(plainOf(out)); i++) await new Promise((r) => setTimeout(r, 25));
      term.write(key);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    if (status === 'timeout') term.close();
    return { raw: out, out: plainOf(out), status };
  }

  it('prompts, prints results (coloured), takes multi-line input, ends on .exit', needs, async () => {
    const { raw, out, status } = await session([
      [/> $/, '1 + 2\r'],
      [/\n3\r\n> $/, 'function f() {\r'],
      [/\.\.\. $/, '  return 42\r'],
      [/\.\.\. $/, '}\r'],
      [/undefined\r\n> $/, 'f()\r'],
      [/42\r\n> $/, "'s'\r"],
      [/'s'\r\n> $/, '.exit\r'],
    ]);
    assert.equal(status, 0);
    assert.match(out, /^Welcome to Node\.js v22\.22\.0\.\r\nType "\.help" for more information\.\r\n> /);
    assert.match(out, /> 1 \+ 2\r\r?\n3\r\n> function f\(\) \{\r\r?\n\.\.\. {3}return 42\r\r?\n\.\.\. \}\r\r?\nundefined\r\n> f\(\)\r\r?\n42\r\n/);
    // inspect's colours, as Node's REPL on a terminal: a number yellow, a string green.
    assert.match(raw, /\x1b\[33m3\x1b\[39m/);
    assert.match(raw, /\x1b\[32m's'\x1b\[39m/);
  });

  it('^C clears the line; on an empty one it warns, and a second ends it; ^D ends it too', needs, async () => {
    const first = await session([
      [/> $/, '1 +'],
      [/1 \+$/, '\x03'],
      [/1 \+\r\r?\n> $/, '\x03'],
      [/\.exit\)\r\n> $/, '\x03'],
    ]);
    assert.equal(first.status, 0);
    assert.match(first.out, /> 1 \+\r\r?\n> \r\r?\n\(To exit, press Ctrl\+C again or Ctrl\+D or type \.exit\)\r\n> /);
    const second = await session([[/> $/, '\x04']]);
    assert.equal(second.status, 0);
  });

  it('reports errors as Uncaught (also a timer’s and a rejection’s) and goes on', needs, async () => {
    const { out, status } = await session([
      [/> $/, 'throw new Error("tty")\r'],
      [/Uncaught Error: tty\r\n> $/, 'setTimeout(() => { throw new Error("async") }, 10); 1\r'],
      [/Uncaught Error: async\r\n> $/, 'Promise.reject(new Error("rj")); 2\r'],
      [/Uncaught Error: rj\r\n> $/, 'foo bar\r'],
      [/Uncaught SyntaxError: Unexpected identifier 'bar'\r\n> $/, '_error.message\r'],
      [/"Unexpected identifier 'bar'"\r\n> $/, '.exit\r'],
    ]);
    assert.equal(status, 0);
    assert.match(out, /foo bar\r\n {4}\^\^\^\r\n\r\nUncaught SyntaxError/);
  });

  it('completes on Tab and keeps history in ~/.node_repl_history, recalled next time', needs, async () => {
    await jsh.kernel.writeFile('/os/home-h/.keep', '');
    const home = '/os/home-h';
    const { out, status } = await session(
      [
        [/> $/, 'const arr = [1]\r'],
        [/undefined\r\n> $/, 'process.ver'],
        [/process\.ver$/, '\t'],
        [/process\.version$/, '\r'],
        [/'v22\.22\.0'\r\n> $/, '.exit\r'],
      ],
      { home }
    );
    assert.equal(status, 0);
    assert.match(out, /> process\.version\r\r?\n'v22\.22\.0'/);
    const history = decoder.decode(await jsh.kernel.readFile('/os/home-h/.node_repl_history'));
    // Newest first, as Node writes it.
    assert.equal(history, '.exit\nprocess.version\nconst arr = [1]');
    const next = await session(
      [
        [/> $/, '\x1b[A'],
        [/> \.exit$/, '\x1b[A'],
        [/> process\.version$/, '\r'],
        [/'v22\.22\.0'\r\n> $/, '\x04'],
      ],
      { home }
    );
    assert.equal(next.status, 0);
  });

  it('a pipe on stdin is still the program (no REPL)', async () => {
    const r = await jsh.run(['node'], { stdin: 'console.log(typeof require, 6 * 7)\n' });
    assert.equal(r.stdout, 'function 42\n');
    assert.equal(r.status, 0);
  });
});
