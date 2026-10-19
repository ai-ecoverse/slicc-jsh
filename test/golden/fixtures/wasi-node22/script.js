// node:wasi against host Node 22: Node's own lib/wasi.js over the kernel's
// WASI host (ctx.sync.wasi.create). prog.wasm and reactor.wasm are built
// from the .wat files beside them. Everything is printed with fs.writeSync
// on fd 1, as the WASI program writes there itself.
const fs = require('fs');
const path = require('path');
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
const err = (e) => `${e.code} ${e.message}`;
process.on('warning', (w) => log('warning', w.name, w.message));

const { WASI } = require('wasi');
const prog = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'prog.wasm')));
const reactor = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'reactor.wasm')));
const sandbox = path.join(__dirname, 'sandbox');

for (const options of [undefined, {}, { version: 'preview2' }, { version: 'preview1', args: 'x' }, { version: 'preview1', stdout: -1 }]) {
  try {
    new WASI(options);
    log('constructed', JSON.stringify(options));
  } catch (e) {
    log('new WASI', JSON.stringify(options), err(e));
  }
}

const wasi = new WASI({
  version: 'preview1',
  args: ['prog', 'a b', 'ü'],
  // An own __proto__ (JSON.parse makes one) is a variable like any other.
  env: { A: '1', B: 'two', C: undefined, ...JSON.parse('{"__proto__":"p"}') },
  preopens: { '/sandbox': sandbox },
});
const imports = wasi.getImportObject();
log('import object', Object.keys(imports).join());
log('wasiImport', Object.keys(wasi.wasiImport).sort().join());
log('same', imports.wasi_snapshot_preview1 === wasi.wasiImport);
const instance = new WebAssembly.Instance(prog, imports);
log('start returned', wasi.start(instance));
try {
  wasi.start(instance);
} catch (e) {
  log('start again', err(e));
}

const unstable = new WASI({ version: 'unstable' });
log('unstable import object', Object.keys(unstable.getImportObject()).join());

const r = new WASI({ version: 'preview1' });
const ri = new WebAssembly.Instance(reactor, r.getImportObject());
log('initialize', r.initialize(ri), ri.exports.inits());
try {
  new WASI({ version: 'preview1' }).start(new WebAssembly.Instance(reactor, r.getImportObject()));
} catch (e) {
  log('start a reactor', err(e));
}
try {
  new WASI({ version: 'preview1' }).initialize(new WebAssembly.Instance(prog, new WASI({ version: 'preview1' }).getImportObject()));
} catch (e) {
  log('initialize a command', err(e));
}
try {
  new WASI({ version: 'preview1' }).start({ exports: { _start() {} } });
} catch (e) {
  log('no memory', err(e));
}

// Without returnOnExit, proc_exit ends the program at once.
process.on('exit', (code) => log('exit event', code));
const last = new WASI({ version: 'preview1', args: ['last'], preopens: { '/sandbox': sandbox }, returnOnExit: false });
last.start(new WebAssembly.Instance(prog, last.getImportObject()));
log('not reached');
