for (const v of ['process', 'Buffer', 'console', 'global', 'setTimeout', 'queueMicrotask', 'URL', 'exports']) {
  try { require('./c-' + v); process.stdout.write(`const ${v}: ok\n`) } catch (e) { process.stdout.write(`const ${v}: ${e.name}: ${e.message}\n`) }
}
try { console.log('require(process) module:', require('./r-process')) } catch (e) { console.log('r-process', e.name, e.message) }
