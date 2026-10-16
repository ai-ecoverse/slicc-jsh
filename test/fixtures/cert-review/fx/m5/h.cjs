const fs = require('fs');
exports.fresh = (n) => { fs.rmSync(n, { recursive: true, force: true }); fs.mkdirSync(n); return n; };
exports.E = (e) => e ? `${e.code ?? e.name} syscall=${e.syscall} path=${e.path} dest=${e.dest} | ${String(e.message).split('\n')[0]}` : 'ok';
exports.t = (label, f) => { try { const r = f(); console.log(label, '->', r === undefined ? 'ok' : JSON.stringify(r)); } catch (e) { console.log(label, '-> THROW', exports.E(e)); } };
exports.ta = async (label, f) => { try { const r = await f(); console.log(label, '->', r === undefined ? 'ok' : JSON.stringify(r)); } catch (e) { console.log(label, '-> THROW', exports.E(e)); } };
exports.tree = (d) => { try { return fs.readdirSync(d, { recursive: true }).sort().join(','); } catch (e) { return exports.E(e); } };
