const fs = require('fs');
const sh = (e) => e ? `${e.code}|${e.errno}|${e.syscall}|${e.path}` : 'ok';
for (const [l, f] of [['mkdirSync /', () => fs.mkdirSync('/')], ['mkdirSync / recursive', () => fs.mkdirSync('/', { recursive: true })], ['mkdirSync /tmp', () => fs.mkdirSync('/tmp')]]) { try { console.log(l, 'ok', JSON.stringify(f())); } catch (e) { console.log(l, sh(e)); } }
fs.mkdir('/', (e) => { console.log('mkdir cb /', sh(e)); fs.promises.mkdir('/').then(() => console.log('promises /', 'ok'), (e2) => console.log('promises /', sh(e2))); });
