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
    .replace(/^node: /gm, 'NODE: ')
    // An array of paths breaks across lines by their length (the host's temp
    // directory is longer than the kernel's): one line, as the shorter fits.
    .replace(/\[\n\s+('[^'\n]*'(?:,\n\s+'[^'\n]*')*)\n\s+\]/g, (_, items) => `[ ${items.split(/,\n\s+/).join(', ')} ]`);
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
  await t('context import, a name like the loader\'s', async () => [typeof (await vm.runInContext('const __jsh_vm_import__ = 1; import("node:path")', ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })).join, vm.runInContext('__jsh_vm_import__', ctx)]);
  await t('context: the runner\'s names are not the script\'s', () => vm.runInNewContext('typeof __jsh_vm_scope__ + typeof __jsh_vm_code__'));
  await t('context import, no callback', () => vm.runInContext('import("node:path")', ctx));
  await t('new context import, a callback', () => vm.runInNewContext('import("x")', {}, { importModuleDynamically: () => ({}) }));

  // CLI: -r / --require, `node -`, --stack-trace-limit
  fs.writeFileSync(at('pre.js'), 'globalThis.pre = 1; console.log("pre", require.main === module, module.id.endsWith("pre.js"))\n');
  fs.writeFileSync(at('m.js'), 'console.log("main", globalThis.pre, JSON.stringify(process.execArgv))\n');
  await t('-r', () => node(['-r', './pre.js', 'm.js']));
  await t('--require=', () => node(['--require=./pre.js', '-e', 'console.log(globalThis.pre)']));
  await t('-r missing', () => node(['-r', './nope.js', 'm.js']));
  await t('-r no argument', () => node(['-r']));
  fs.writeFileSync(at('pre-loop.js'), 'console.log("parent", module.parent && module.parent.id, module.parent && module.parent.filename); setTimeout(() => console.log("timer"), 0); process.on("exit", (c) => console.log("exit", c));\n');
  fs.writeFileSync(at('pre-missing.js'), 'require("./gone")\n');
  await t('-r: its parent, and its loop with nothing piped', () => node(['-r', './pre-loop.js', '-'], ''));
  await t('-r: what it requires is missing', () => node(['-r', './pre-missing.js', '-e', '1']));
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
    fs.symlinkSync(at('n.txt'), at('link.txt'));
    const opened = [['link.txt', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW], ['n.txt', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY], ['.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY], ['nope', fs.constants.O_DIRECTORY]].map(([p, f]) => {
      try {
        fs.closeSync(fs.openSync(at(p), f));
        return [p, 'ok'];
      } catch (e) {
        return [p, e.code];
      }
    });
    return [b.toString(), excl, opened];
  });
  // fs.constants and constants: the names both Linux and macOS have
  const names = ['UV_FS_SYMLINK_DIR', 'UV_DIRENT_BLOCK', 'S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFSOCK', 'O_NOFOLLOW', 'O_SYNC', 'O_DIRECTORY', 'O_NOCTTY', 'O_DSYNC', 'O_NONBLOCK', 'S_IRWXU', 'S_IRUSR', 'S_IXOTH', 'UV_FS_COPYFILE_EXCL', 'UV_FS_COPYFILE_FICLONE_FORCE', 'UV_FS_O_FILEMAP'];
  await t('fs.constants', () => names.map((n) => [n, typeof fs.constants[n], typeof require('constants')[n]]));
  await t('fs.constants (same everywhere)', () => ['S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFSOCK', 'S_IRWXU', 'S_IRUSR', 'S_IXOTH', 'UV_DIRENT_BLOCK', 'UV_FS_COPYFILE_FICLONE_FORCE'].map((n) => fs.constants[n]));

  // a stream's unknown encoding; fromWeb / toWeb
  await t('createReadStream bad encoding', () => fs.createReadStream(at('n.txt'), 'nope'));
  await t('createWriteStream bad encoding', () => fs.createWriteStream(at('w.txt'), { encoding: 'bad' }));
  const { Readable, Writable, Duplex } = require('stream');
  await t('Readable.fromWeb', async () => { let s = ''; for await (const c of Readable.fromWeb(new ReadableStream({ start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); } }), { encoding: 'utf8' })) s += c; return s; });
  await t('Readable.toWeb', async () => { const r = Readable.toWeb(Readable.from(['x', 'y'])).getReader(); const out = []; for (;;) { const { value, done } = await r.read(); if (done) return out; out.push(String(value)); } });
  await t('Writable.fromWeb', async () => { const got = []; const w = Writable.fromWeb(new WritableStream({ write(c) { got.push(new TextDecoder().decode(c)); } })); await new Promise((res) => w.end('hi', res)); return got; });
  await t('Writable.toWeb', async () => { const sink = []; const w = Writable.toWeb(new Writable({ write(c, e, cb) { sink.push(c.toString()); cb(); } })).getWriter(); await w.write(new TextEncoder().encode('z')); await w.close(); return sink; });
  await t('Duplex.fromWeb / toWeb', async () => { let s = ''; for await (const c of Duplex.fromWeb({ readable: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('dup')); c.close(); } }), writable: new WritableStream({}) }, { encoding: 'utf8' })) s += c; const pair = Duplex.toWeb(new Duplex({ read() { this.push(null); }, write(c, e, cb) { cb(); } })); return [s, typeof pair.readable.getReader, typeof pair.writable.getWriter]; });
  await t('Readable.fromWeb not a stream', () => Readable.fromWeb({}));

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
