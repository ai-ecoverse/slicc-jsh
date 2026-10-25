import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

const pack = mkdtempSync(join(tmpdir(), 'jsh-tty-raw-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

const session = (k, argv, steps) =>
  k.page.evaluate(
    async (argv, steps) => {
      const decoder = new TextDecoder();
      const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const want = steps.map(([after, key]) => [new RegExp(after), key]);
      let out = '';
      let sent = 0;
      let term;
      let last = Date.now();
      const feed = () => {
        if (term && sent < want.length && want[sent][0].test(plain(out))) term.write(want[sent++][1]);
      };
      term = await window.kernel.openTerminal(argv, {
        cwd: '/home/t',
        env: { HOME: '/home/t' },
        onData: (d) => {
          out += decoder.decode(d, { stream: true });
          last = Date.now();
          feed();
        },
      });
      feed();
      const started = Date.now();
      let watchdog;
      const stalled = new Promise((resolve) => {
        watchdog = setInterval(() => {
          if (Date.now() - last > 20_000 || Date.now() - started > 120_000) resolve('stalled');
        }, 250);
      });
      const status = await Promise.race([term.exited, stalled]);
      clearInterval(watchdog);
      if (status === 'stalled') term.close();
      return { raw: out, out: plain(out), status, sent };
    },
    argv,
    steps.map(([after, key]) => [after.source, key])
  );

test('setRawMode is in force when it returns: the next key comes at once, unechoed; a REPL line is echoed once', { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  await k.write(
    '/home/t/raw.js',
    [
      'process.stdin.setRawMode(true);',
      "console.log('raw', process.stdin.isRaw);",
      "console.log('ready');",
      "process.stdin.once('data', (d) => {",
      "  console.log('key', JSON.stringify(d.toString()));",
      '  process.stdin.setRawMode(false);',
      '  process.stdin.pause();',
      '});',
      '',
    ].join('\n')
  );

  const raw = await session(k, ['node', 'raw.js'], [[/ready\r?\n$/, 'q']]);
  assert.equal(raw.status, 0, JSON.stringify(raw));
  assert.equal(raw.sent, 1, JSON.stringify(raw));
  assert.equal(raw.out.replace(/\r\n/g, '\n'), 'raw true\nready\nkey "q"\n');

  const repl = await session(k, ['node'], [
    [/> $/, '1 + 2\r'],
    [/\n3\r\n> $/, '.exit\r'],
  ]);
  assert.equal(repl.status, 0, JSON.stringify(repl));
  assert.equal(repl.sent, 2, JSON.stringify(repl));
  assert.match(repl.out, /\r\n> 1 \+ 2\r\r?\n3\r\n> \.exit\r\r?\n$/);
  assert.equal(repl.out.split('1 + 2').length, 2, JSON.stringify(repl.out));
  assert.deepEqual(k.page.errors, []);
});
