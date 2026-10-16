process.on('warning', (w) => console.log('warning', w.name, w.code, w.message.slice(0, 60)));
const p = require('punycode');
console.log(JSON.stringify([p.version, p.encode('mañana'), p.decode('maana-pta'), p.toASCII('mañana.com'), p.toUnicode('xn--maana-pta.com'), p.ucs2.decode('😀'), p.ucs2.encode([0x1f600])]));
try { p.decode('\u00e9'); } catch (e) { console.log('decode bad', e.name, e.message); }
