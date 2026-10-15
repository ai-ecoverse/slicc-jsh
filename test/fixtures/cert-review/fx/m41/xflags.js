const fs = require('fs'), path = require('path'), os = require('os'); const c = fs.constants;
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x41-')); const f = path.join(d, 'f'); fs.writeFileSync(f, 'abc');
for (const fl of ['wx', 'ax', 'ax+', 'wx+', 'a+', 'as', 'rs+']) { try { fs.writeFileSync(f, 'q', { flag: fl }); console.log(fl, 'ok', fs.readFileSync(f, 'utf8')); } catch (e) { console.log(fl, e.code); } }
for (const [n, v] of [['APPEND|CREAT|EXCL', c.O_APPEND | c.O_CREAT | c.O_EXCL | c.O_WRONLY], ['CREAT|EXCL', c.O_CREAT | c.O_EXCL | c.O_WRONLY]]) { try { fs.closeSync(fs.openSync(f, v)); console.log(n, 'ok'); } catch (e) { console.log(n, e.code); } }
try { fs.appendFileSync(f, 'z', { flag: 'ax' }); console.log('appendFileSync ax ok'); } catch (e) { console.log('appendFileSync ax', e.code); }
fs.rmSync(d, { recursive: true });
