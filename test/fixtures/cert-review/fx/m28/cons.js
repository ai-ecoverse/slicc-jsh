const { Console } = require('console'); const { PassThrough } = require('stream');
const out = new PassThrough(), err = new PassThrough(); let o = '', e = ''; out.on('data', (d) => (o += d)); err.on('data', (d) => (e += d));
const c = new Console({ stdout: out, stderr: err, colorMode: false });
c.log('hello %s', 'world'); c.error('to-err'); c.table([{ a: 1 }, { b: 2 }], ['a']); c.group('G'); c.info('in'); c.groupEnd(); c.dir({ x: { y: { z: { w: 1 } } } }, { depth: 1 });
c.count('k'); c.count('k'); c.countReset('k'); c.count('k'); c.assert(false, 'fail %d', 1);
c.time('t'); c.timeLog('t', 'extra'); c.timeEnd('t'); c.timeEnd('nope');
setImmediate(() => { console.log(JSON.stringify(o.replace(/\d+(\.\d+)?m?s/g, 'Nms'))); console.log(JSON.stringify(e.replace(/\d+(\.\d+)?m?s/g, 'Nms'))); console.log('same console?', require('console') === console, typeof console.Console, typeof console.timeLog, typeof console.createTask);
  try { new Console(5); } catch (x) { console.log('bad stream', x.code); } });
