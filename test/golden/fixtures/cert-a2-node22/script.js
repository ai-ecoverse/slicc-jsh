// cert A2 findings (0.16.1→0.17.0) and the gap report's statfs and
// String(process), against host Node.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const t = async (l, f) => {
  try {
    console.log(l, JSON.stringify(await f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code, clean(e.message));
  }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-'));
const at = (f) => path.join(dir, f);
const clean = (s) =>
  String(s).split(fs.realpathSync(dir)).join('DIR').split(dir).join('DIR').split(process.execPath).join('NODE').split(__filename).join('SCRIPT')
    // argv[0] as the child got it (the kernel's spawn hands over the command's name).
    .replace(/^node: /gm, 'NODE: ');
const node = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', input });
  // Frames are Node's internals (the line holding an error's ` {` among them).
  return [r.status, clean(r.stdout), clean(r.stderr.split('\n').filter((l) => !/^\s+at /.test(l) && l !== '{').join('\n'))];
};
const warnings = [];
process.on('warning', (w) => warnings.push([w.name, w.message]));
(async () => {
  // import() in a vm context
  const ctx = vm.createContext({});
  await t('context import, main loader', async () => typeof (await vm.runInContext('import("node:path")', ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })).join);
  await t('context import, no callback', () => vm.runInContext('import("node:path")', ctx));
  await t('new context import, a callback', () => vm.runInNewContext('import("x")', {}, { importModuleDynamically: () => ({}) }));

  // CLI: -r / --require, `node -`, --stack-trace-limit
  fs.writeFileSync(at('pre.js'), 'globalThis.pre = 1; console.log("pre", require.main === module, module.id.endsWith("pre.js"))\n');
  fs.writeFileSync(at('m.js'), 'console.log("main", globalThis.pre, JSON.stringify(process.execArgv))\n');
  await t('-r', () => node(['-r', './pre.js', 'm.js']));
  await t('--require=', () => node(['--require=./pre.js', '-e', 'console.log(globalThis.pre)']));
  await t('-r missing', () => node(['-r', './nope.js', 'm.js']));
  await t('-r no argument', () => node(['-r']));
  await t('node -', () => node(['-', 'a', 'b'], 'console.log(JSON.stringify([process.argv.slice(2), __filename, require.main === module]))\n'));
  await t('--stack-trace-limit=2', () => node(['--stack-trace-limit=2', '-e', 'function a(){b()} function b(){c()} function c(){throw new Error("x")} try{a()}catch(e){console.log(e.stack.split("\\n").length, Error.stackTraceLimit)}']));
  await t('--stack-trace-limit 3', () => { const [status, , err] = node(['--stack-trace-limit', '3', '-e', '1']); return [status, err.split('\n').slice(0, 2)]; });

  // createWriteStream(p, 'latin1'); numeric open flags
  await t('write stream encoding', () => new Promise((r) => fs.createWriteStream(at('l1.txt'), 'latin1').end('é', () => r([...fs.readFileSync(at('l1.txt'))]))));
  await t('write stream encoding option', () => new Promise((r) => fs.createWriteStream(at('h.txt'), { encoding: 'hex' }).end('6869', () => r(fs.readFileSync(at('h.txt'), 'utf8')))));
  const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_RDONLY, O_EXCL } = fs.constants;
  await t('numeric flags', () => {
    let fd = fs.openSync(at('n.txt'), O_WRONLY | O_CREAT | O_TRUNC);
    fs.writeSync(fd, 'ab');
    fs.closeSync(fd);
    fd = fs.openSync(at('n.txt'), O_WRONLY | O_APPEND);
    fs.writeSync(fd, 'c');
    fs.closeSync(fd);
    fd = fs.openSync(at('n.txt'), O_RDONLY);
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    fs.closeSync(fd);
    let excl;
    try {
      fs.openSync(at('n.txt'), O_WRONLY | O_CREAT | O_EXCL);
    } catch (e) {
      excl = e.code;
    }
    return [b.toString(), excl];
  });
  // fs.constants and constants: the names both Linux and macOS have
  const names = ['UV_FS_SYMLINK_DIR', 'UV_DIRENT_BLOCK', 'S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFSOCK', 'O_NOFOLLOW', 'O_SYNC', 'O_DIRECTORY', 'O_NOCTTY', 'O_DSYNC', 'O_NONBLOCK', 'S_IRWXU', 'S_IRUSR', 'S_IXOTH', 'UV_FS_COPYFILE_EXCL', 'UV_FS_COPYFILE_FICLONE_FORCE', 'UV_FS_O_FILEMAP'];
  await t('fs.constants', () => names.map((n) => [n, typeof fs.constants[n], typeof require('constants')[n]]));
  await t('fs.constants (same everywhere)', () => ['S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFSOCK', 'S_IRWXU', 'S_IRUSR', 'S_IXOTH', 'UV_DIRENT_BLOCK', 'UV_FS_COPYFILE_FICLONE_FORCE'].map((n) => fs.constants[n]));

  // statfs
  await t('statfsSync', () => { const s = fs.statfsSync(dir); return [s.constructor.name, Object.keys(s), Object.values(s).every((v) => typeof v === 'number'), s.bavail <= s.blocks, s.bfree <= s.blocks, typeof fs.statfsSync(dir, { bigint: true }).blocks]; });
  await t('statfsSync missing', () => fs.statfsSync(at('nope')));
  await t('statfs callback / promise', async () => [await new Promise((r) => fs.statfs(dir, (e, s) => r([!!e, typeof s.bsize]))), typeof (await fs.promises.statfs(dir)).bsize]);

  // String(process), and a require stack of more than one file
  await t('process', () => [String(process), Object.prototype.toString.call(process), process.constructor.name, require('util').inspect(process).split('\n')[0]]);
  fs.writeFileSync(at('r1.js'), "require('./r2')\n");
  fs.writeFileSync(at('r2.js'), "require('./missing')\n");
  await t('require stack', () => { try { require(at('r1.js')); } catch (e) { return [e.code, e.requireStack.map(clean), clean(e.message)]; } });

  await t('warnings', () => warnings);
  fs.rmSync(dir, { recursive: true, force: true });
})();
