const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fspaths-')));
process.chdir(work);
const plat = (s) => String(s).replaceAll(work, '/W').replaceAll(`on ${process.platform}`, 'on PLATFORM');
const FORMS = {
  str: (p) => p,
  buf: (p) => Buffer.from(p),
  u8: (p) => new Uint8Array(Buffer.from(p)),
  url: (p) => pathToFileURL(path.resolve(p)),
};
const show = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Buffer.isBuffer(v)) return `Buffer(${plat(v.toString())})`;
  if (v instanceof Uint8Array) return `Uint8Array(${plat(Buffer.from(v).toString())})`;
  if (typeof v === 'string') return JSON.stringify(plat(v));
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(show).join(',')}]`;
  if (v instanceof fs.Dirent) return `Dirent(${show(v.name)} ${v.isFile() ? 'file' : v.isDirectory() ? 'dir' : 'other'} ${show(v.parentPath)})`;
  if (v instanceof fs.Stats) return `Stats(${v.isFile() ? 'file' : v.isDirectory() ? 'dir' : v.isSymbolicLink() ? 'link' : 'other'} ${v.size})`;
  if (v instanceof fs.Dir) return `Dir(${show(v.path)})`;
  if (v instanceof Promise) return 'Promise';
  return `${v.constructor?.name ?? 'Object'}`;
};
const err = (e) => `${e.name} ${e.code} ${JSON.stringify(plat(e.message))}${e.path !== undefined ? ` path:${show(e.path)}` : ''}${e.dest !== undefined ? ` dest:${show(e.dest)}` : ''}`;
const out = (...a) => console.log(...a);
const reset = () => {
  for (const n of fs.readdirSync('.')) fs.rmSync(n, { recursive: true, force: true });
  fs.writeFileSync('f', 'abc');
  fs.mkdirSync('d');
  fs.writeFileSync('d/x', 'x');
  fs.symlinkSync('f', 'l');
};
const mkTemp = (v) => (typeof v === 'string' ? `tmp(${v.startsWith(path.join(work, 't-')) || v.startsWith('t-') ? 'ok' : v})` : Buffer.isBuffer(v) ? `Buffer(${mkTemp(v.toString())})` : show(v));

const OPS = [
  ['access', (P) => [P('f')]],
  ['appendFile', (P) => [P('f'), 'y']],
  ['chmod', (P) => [P('f'), 0o644]],
  ['chown', (P) => [P('f'), -1, -1]],
  ['copyFile', (P) => [P('f'), P('g')]],
  ['cp', (P) => [P('d'), P('d2'), { recursive: true }]],
  ['lchown', (P) => [P('l'), -1, -1]],
  ['lstat', (P) => [P('l')]],
  ['lutimes', (P) => [P('l'), 1, 2]],
  ['mkdir', (P) => [P('m')]],
  ['mkdir', (P) => [P('m/n'), { recursive: true }]],
  ['mkdtemp', (P) => [P('t-')], mkTemp],
  ['mkdtemp', (P) => [P('t-'), 'buffer'], mkTemp],
  ['readdir', (P) => [P('d')]],
  ['readdir', (P) => [P('d'), { encoding: 'buffer' }]],
  ['readdir', (P) => [P('d'), { withFileTypes: true }]],
  ['readdir', (P) => [P('d'), { recursive: true }]],
  ['readFile', (P) => [P('f')]],
  ['readFile', (P) => [P('f'), 'utf8']],
  ['readlink', (P) => [P('l')]],
  ['readlink', (P) => [P('l'), { encoding: 'buffer' }]],
  ['realpath', (P) => [P('l')]],
  ['realpath', (P) => [P('l'), { encoding: 'buffer' }]],
  ['rename', (P) => [P('f'), P('r')]],
  ['rm', (P) => [P('d'), { recursive: true }]],
  ['rm', (P) => [P('f')]],
  ['rmdir', (P) => [P('m0')], null, () => fs.mkdirSync('m0')],
  ['stat', (P) => [P('f')]],
  ['stat', (P) => [P('missing')]],
  ['statfs', (P) => [P('f')], (v) => v.constructor.name],
  ['symlink', (P) => [P('f'), P('s')]],
  ['truncate', (P) => [P('f'), 1]],
  ['unlink', (P) => [P('f')]],
  ['utimes', (P) => [P('f'), 1, 2]],
  ['writeFile', (P) => [P('w'), 'w']],
];
const TWO = new Set(['copyFile', 'cp', 'link', 'rename', 'symlink']);
const NODE_BUGS = new Set(['cp {"recursive":true} bytes cb', 'cp {"recursive":true} bytes promise', 'readdir {"recursive":true} bytes sync', 'readdir {"recursive":true} bytes cb', 'readdir {"recursive":true} bytes promise', 'statfs url promise']);
const after = (name) => {
  if (name === 'appendFile' || name === 'truncate') return ` f=${JSON.stringify(fs.readFileSync('f', 'utf8'))}`;
  if (name === 'copyFile') return ` ${fs.readdirSync('.').sort().join(',')}`;
  if (name === 'cp') return ` d2=${fs.readdirSync('d2').join(',')}`;
  if (name === 'rename' || name === 'rm' || name === 'unlink' || name === 'symlink' || name === 'mkdir' || name === 'rmdir' || name === 'writeFile') return ` ${fs.readdirSync('.').sort().join(',')}`;
  if (name === 'chmod') return ` mode=${(fs.statSync('f').mode & 0o777).toString(8)}`;
  return '';
};

(async () => {
  for (const [name, args, fmt, prep] of OPS) {
    const f = fmt ?? show;
    for (const [form, P] of Object.entries(FORMS)) {
      for (const kind of ['sync', 'cb', 'promise']) {
        const a = args(P);
        const label = `${name} ${a.slice(TWO.has(name) ? 2 : 1).map((x) => JSON.stringify(x)).join(' ')}`.trim();
        if (NODE_BUGS.has(`${label} ${form === 'buf' || form === 'u8' ? 'bytes' : form} ${kind}`)) continue;
        reset();
        prep?.();
        let r;
        try {
          if (kind === 'sync') r = f(fs[`${name}Sync`](...a));
          else if (kind === 'cb') r = await new Promise((res) => fs[name](...a, (e, v) => res(e ? `ERR ${err(e)}` : f(v))));
          else r = f(await fs.promises[name](...a));
        } catch (e) {
          r = `THROW ${err(e)}`;
        }
        out(`${label} ${form} ${kind}: ${r}${r.startsWith?.('THROW') || r.startsWith?.('ERR') ? '' : after(name)}`);
      }
    }
  }

  for (const [form, P] of Object.entries(FORMS)) {
    reset();
    out(`exists ${form}: sync ${fs.existsSync(P('f'))} missing ${fs.existsSync(P('missing'))} cb ${await new Promise((res) => fs.exists(P('f'), res))}`);
    let fd = fs.openSync(P('f'));
    out(`open ${form} sync: ${typeof fd} ${fs.readFileSync(fd, 'utf8')}`);
    fs.closeSync(fd);
    fd = await new Promise((res, rej) => fs.open(P('f'), 'r', (e, v) => (e ? rej(e) : res(v))));
    out(`open ${form} cb: ${typeof fd}`);
    fs.closeSync(fd);
    const fh = await fs.promises.open(P('f'), 'r');
    out(`open ${form} promise: ${typeof fh.fd} ${await fh.readFile('utf8')}`);
    await fh.close();
    try {
      fs.openSync(P('missing'));
    } catch (e) {
      out(`open ${form} missing: ${err(e)}`);
    }
    try {
      await fs.promises.open(P('missing'));
    } catch (e) {
      out(`open ${form} promise missing: ${err(e)}`);
    }
    const dir = fs.opendirSync(P('d'));
    out(`opendir ${form} sync: ${show(dir)} ${show(dir.readSync())}`);
    dir.closeSync();
    const cdir = await new Promise((res, rej) => fs.opendir(P('d'), (e, v) => (e ? rej(e) : res(v))));
    out(`opendir ${form} cb: ${show(cdir)}`);
    cdir.closeSync();
    const pdir = await fs.promises.opendir(P('d'));
    out(`opendir ${form} promise: ${show(pdir)}`);
    await pdir.close();
    out(`openAsBlob ${form}: ${(await fs.openAsBlob(P('f'))).size}`);
    out(`realpathSync.native ${form}: ${show(fs.realpathSync.native(P('l')))}`);
    out(`realpath.native ${form}: ${await new Promise((res) => fs.realpath.native(P('l'), (e, v) => res(e ? err(e) : show(v))))}`);

    const rs = fs.createReadStream(P('f'), 'utf8');
    let text = '';
    for await (const c of rs) text += c;
    out(`createReadStream ${form}: ${text} path ${show(rs.path)}`);
    const ws = fs.createWriteStream(P('w'));
    await new Promise((res) => ws.end('ws', res));
    out(`createWriteStream ${form}: ${fs.readFileSync('w', 'utf8')} path ${show(ws.path)}`);
    const bad = fs.createReadStream(P('missing'));
    out(`createReadStream ${form} missing: ${await new Promise((res) => bad.on('error', (e) => res(err(e))))}`);

    const rs2 = new fs.ReadStream(P('f'));
    let n = 0;
    for await (const c of rs2) n += c.length;
    out(`ReadStream ${form}: ${n} path ${show(rs2.path)}`);
    const ac = new AbortController();
    const it = fs.promises.watch(P('d'), { signal: ac.signal });
    const first = it.next();
    ac.abort();
    out(`promises.watch ${form}: ${await first.then((r) => `done ${r.done}`, (e) => e.name)}`);
    const w = fs.watch(P('d'));
    out(`watch ${form}: ${w.constructor.name}`);
    w.close();
    const listener = () => {};
    try {
      const sw = fs.watchFile(P('f'), { interval: 10 }, listener);
      out(`watchFile ${form}: ${sw.constructor.name}`);
    } catch (e) {
      out(`watchFile ${form}: THROW ${err(e)}`);
    }
    try {
      fs.unwatchFile(P('f'), listener);
      out(`unwatchFile ${form}: ok`);
    } catch (e) {
      out(`unwatchFile ${form}: THROW ${err(e)}`);
    }
    fs.unwatchFile('f');
    fs.unwatchFile(path.resolve('f'));
  }

  reset();
  const fd = fs.openSync('f', 'r');
  const byFd = fs.createReadStream(null, { fd });
  out(`createReadStream fd: path ${show(byFd.path)} ${'path' in byFd}`);
  byFd.destroy();
  const wfd = fs.openSync('w', 'w');
  const wByFd = fs.createWriteStream(undefined, { fd: wfd });
  out(`createWriteStream fd: path ${show(wByFd.path)}`);
  wByFd.destroy();
  for (const [label, call] of [
    ['createReadStream 123', () => fs.createReadStream(123)],
    ['createReadStream undefined', () => fs.createReadStream(undefined)],
    ['new ReadStream url', () => new fs.ReadStream(new URL('http://x/'))],
    ['new WriteStream object', () => new fs.WriteStream({})],
    ['readFileSync fd object', () => fs.readFileSync({ fd: 3 })],
    ['readFileSync null', () => fs.readFileSync(null)],
    ['readlinkSync hex', () => fs.readlinkSync(Buffer.from('l'), 'hex')],
    ['readlinkSync bad encoding', () => fs.readlinkSync(Buffer.from('l'), 'nope')],
    ['realpathSync object', () => fs.realpathSync({ toString: () => 'f' })],
    ['existsSync number', () => fs.existsSync(1)],
  ]) {
    try {
      out(`${label}: ${show(call())}`);
    } catch (e) {
      out(`${label}: ${err(e)}`);
    }
  }
  const fh = await fs.promises.open('f', 'r+');
  out(`promises.readFile FileHandle: ${show(await fs.promises.readFile(fh, 'utf8'))}`);
  await fs.promises.appendFile(fh, 'z');
  out(`promises.appendFile FileHandle: ${fs.readFileSync('f', 'utf8')}`);
  await fh.close();
  const wh = await fs.promises.open('w2', 'w');
  await fs.promises.writeFile(wh, 'q');
  await wh.close();
  out(`promises.writeFile FileHandle: ${fs.readFileSync('w2', 'utf8')}`);
  for (const [label, call] of [
    ['promises.readFile number', () => fs.promises.readFile(3)],
    ['promises.readFile fd object', () => fs.promises.readFile({ fd: 3 })],
    ['promises.writeFile number', () => fs.promises.writeFile(3, 'x')],
    ['promises.readlink buffer', () => fs.promises.readlink(new URL(pathToFileURL(path.resolve('l'))), 'buffer')],
    ['promises.readlink missing', () => fs.promises.readlink(Buffer.from('missing'))],
    ['promises.watch object', () => fs.promises.watch({}).next()],
  ]) {
    out(`${label}: ${await call().then(show, (e) => `reject ${err(e)}`)}`);
  }

  const BAD = {
    object: () => ({}),
    'nul string': () => 'a\0b',
    'nul buffer': () => Buffer.from('a\0b'),
    'nul url': () => pathToFileURL(path.resolve('a\0b')),
    'http url': () => new URL('http://example.com/f'),
    'url host': () => new URL('file://host/f'),
    'url slash': () => new URL('file:///a%2fb'),
  };
  const ONE = ['access', 'appendFile', 'chmod', 'chown', 'lchown', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'statfs', 'truncate', 'unlink', 'utimes', 'writeFile'];
  const EXTRA = { appendFile: ['y'], chmod: [0o644], chown: [-1, -1], lchown: [-1, -1], lutimes: [1, 2], utimes: [1, 2], writeFile: ['y'] };
  for (const [label, B] of Object.entries(BAD)) {
    reset();
    const seen = new Map();
    const note = (call, r) => {
      if (!seen.has(r)) seen.set(r, []);
      seen.get(r).push(call);
    };
    for (const name of ONE) {
      const rest = EXTRA[name] ?? [];
      try {
        note(`${name}Sync`, show(fs[`${name}Sync`](B(), ...rest)));
      } catch (e) {
        note(`${name}Sync`, err(e));
      }
      try {
        note(name, await new Promise((res) => fs[name](B(), ...rest, (e, v) => res(e ? `cb ${err(e)}` : show(v)))));
      } catch (e) {
        note(name, err(e));
      }
      if (name === 'statfs') continue;
      try {
        note(`promises.${name}`, await fs.promises[name](B(), ...rest).then(show, (e) => `reject ${err(e)}`));
      } catch (e) {
        note(`promises.${name}`, `throw ${err(e)}`);
      }
    }
    for (const [name, call] of [
      ['renameSync src', () => fs.renameSync(B(), 'f')],
      ['renameSync dest', () => fs.renameSync('f', B())],
      ['copyFileSync dest', () => fs.copyFileSync('f', B())],
      ['linkSync dest', () => fs.linkSync('f', B())],
      ['symlinkSync target', () => fs.symlinkSync(B(), 's')],
      ['symlinkSync path', () => fs.symlinkSync('f', B())],
      ['cpSync src', () => fs.cpSync(B(), 'c')],
      ['cpSync dest', () => fs.cpSync('f', B())],
      ['existsSync', () => fs.existsSync(B())],
      ['createReadStream', () => fs.createReadStream(B())],
      ['createWriteStream', () => fs.createWriteStream(B())],
      ['watch', () => fs.watch(B()).close()],
      ['watchFile', () => fs.watchFile(B(), () => {})],
      ['unwatchFile', () => fs.unwatchFile(B())],
      ['openAsBlob', () => fs.openAsBlob(B())],
      ['realpathSync.native', () => fs.realpathSync.native(B())],
    ]) {
      try {
        const r = call();
        note(name, r instanceof Promise ? await r.then(show, (e) => `reject ${err(e)}`) : show(r));
      } catch (e) {
        note(name, err(e));
      }
    }
    for (const [r, calls] of seen) out(`bad ${label}: ${r}\n  ${calls.join(' ')}`);
  }
  process.chdir('/');
  fs.rmSync(work, { recursive: true, force: true });
})();
