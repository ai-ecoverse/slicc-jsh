// cert A2 findings on 0.17.2, against host Node: 'ax' append flags' O_EXCL,
// --import, --trace-uncaught, --max-old-space-size, V8's report for a bad
// V8 flag value.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c172-'));
const at = (f) => path.join(dir, f);
const clean = (s) =>
  String(s)
    .split(fs.realpathSync(dir)).join('DIR')
    .split(dir).join('DIR')
    .split(process.execPath).join('NODE')
    .replace(/^node: /gm, 'NODE: ');
const node = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  return [r.status, clean(r.stdout), clean(r.stderr.split('\n').filter((l) => !/^\s+at /.test(l)).join('\n'))];
};
const t = async (l, f) => {
  try {
    console.log(l, JSON.stringify(await f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code, clean(e.message));
  }
};
(async () => {
  fs.writeFileSync(at('ex.txt'), 'a');
  for (const flag of ['ax', 'ax+', 'wx', 'wx+']) await t(`open ${flag}`, () => fs.closeSync(fs.openSync(at('ex.txt'), flag)));
  await t('appendFileSync ax', () => fs.appendFileSync(at('ex.txt'), 'b', { flag: 'ax' }));
  await t('appendFileSync ax, a new file', () => { fs.appendFileSync(at('new.txt'), 'n', { flag: 'ax' }); return fs.readFileSync(at('new.txt'), 'utf8'); });
  await t('promises.appendFile ax', () => fs.promises.appendFile(at('ex.txt'), 'c', { flag: 'ax' }));
  await t('appendFile ax', () => new Promise((r) => fs.appendFile(at('ex.txt'), 'c', { flag: 'ax' }, (e) => r(e && e.code))));
  await t('ex.txt is still', () => fs.readFileSync(at('ex.txt'), 'utf8'));

  fs.writeFileSync(at('imp.mjs'), 'console.log("imp", import.meta.url.endsWith("imp.mjs"), typeof require); globalThis.imp = 1; await null; console.log("imp after await")\n');
  fs.writeFileSync(at('pr.js'), 'console.log("pre-r")\n');
  fs.writeFileSync(at('m.js'), 'console.log("main", globalThis.imp, JSON.stringify(process.execArgv))\n');
  await t('-r then --import', () => node(['-r', './pr.js', '--import', './imp.mjs', 'm.js']));
  await t('--import=', () => node(['--import=./imp.mjs', '-e', 'console.log("eval", globalThis.imp)']));
  await t('--import a builtin', () => node(['--import', 'node:path', 'm.js']));
  await t('--import missing', () => { const [status, , err] = node(['--import', './nope.mjs', 'm.js']); return [status, err.split('\n').find((l) => l.startsWith('Error')).replace(/ \{$/, '')]; });
  await t('--import no argument', () => node(['--import']));
  await t('--max-old-space-size, --trace-uncaught', () => node(['--max-old-space-size=100', '--trace-uncaught', '-e', 'console.log(JSON.stringify(process.execArgv))']));
  for (const a of [['--max-old-space-size', '100'], ['--max-old-space-size=-5'], ['--max-old-space-size=abc'], ['--stack-trace-limit', '3'], ['--stack-trace-limit=abc']]) {
    await t(`bad V8 flag ${a.join(' ')}`, () => node([...a, '-e', '1']));
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
