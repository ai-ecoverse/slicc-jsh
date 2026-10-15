import fs from 'node:fs'; import p from 'node:fs/promises'; import h from './h.cjs';
const d = h.fresh('w-misc'); fs.mkdirSync(`${d}/real`); fs.symlinkSync('real', `${d}/ln`);
console.log('realpathSync', JSON.stringify(fs.realpathSync(`${d}/ln`).replace(process.cwd(), 'CWD')), 'native', JSON.stringify(fs.realpathSync.native(`${d}/ln`).replace(process.cwd(), 'CWD')));
console.log('realpath promise', JSON.stringify((await p.realpath(`${d}/ln`)).replace(process.cwd(), 'CWD')));
await p.writeFile(`${d}/p`, '7a7a', 'hex'); console.log('hex write', fs.readFileSync(`${d}/p`, 'utf8'));
try { await p.appendFile(`${d}/p`, 'x', { flag: 'wx' }); console.log('appendFile wx ok?'); } catch (e) { console.log('appendFile wx', e.code); } console.log('after wx', fs.readFileSync(`${d}/p`, 'utf8'));
try { fs.appendFileSync(`${d}/p`, 'y', { flag: 'wx' }); console.log('appendFileSync wx ok?'); } catch (e) { console.log('appendFileSync wx', e.code); } console.log('after sync wx', fs.readFileSync(`${d}/p`, 'utf8'));
try { fs.writeFileSync(`${d}/p`, 'q', { flag: 'r+' }); } catch (e) { console.log('r+', e.code); } console.log('after r+', fs.readFileSync(`${d}/p`, 'utf8'));
