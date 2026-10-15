const fs = require('fs'), os = require('os'), path = require('path');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'));
fs.writeFileSync(path.join(d, 'a'), 'x');
try { fs.linkSync(path.join(d, 'a'), path.join(d, 'b')); console.log('link string ok'); } catch (e) { console.log('link string', e.code); }
const w = fs.createWriteStream(path.join(d, 'w'), 'latin1'); console.log('ws string writableEncoding?', w._writableState.defaultEncoding);
w.end('ÿ', () => {
  console.log('ws latin1', [...fs.readFileSync(path.join(d, 'w'))]);
  const w2 = fs.createWriteStream(path.join(d, 'w2'), { encoding: 'latin1' }); w2.end('ÿ', () => console.log('ws {encoding}', [...fs.readFileSync(path.join(d, 'w2'))]));
});
try { fs.createReadStream(path.join(d, 'a'), 'bogus'); console.log('rs bogus no throw'); } catch (e) { console.log('rs bogus', e.code); }
try { fs.createReadStream(path.join(d, 'a'), { encoding: 'bogus' }); console.log('rs {bogus} no throw'); } catch (e) { console.log('rs {bogus}', e.code); }
try { fs.readFileSync(path.join(d, 'a'), 'bogus'); console.log('readFileSync bogus no throw'); } catch (e) { console.log('readFileSync bogus', e.code); }
const c = require('constants'); console.log('constants keys', Object.keys(c).length);
