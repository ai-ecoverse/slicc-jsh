const { StringDecoder } = require('string_decoder');
for (const f of [() => new StringDecoder('nope'), () => new StringDecoder(1), () => new StringDecoder('utf16le').write(Buffer.from([0x61, 0, 0x62])) + '|' + 'x', () => { const o = { message: 'm' }; Error.captureStackTrace(o); return o.stack.split('\n')[0]; }, () => { const o = {}; Error.captureStackTrace(o); return o.stack.split('\n')[0]; }, () => { const e = new Error(); return e.stack.split('\n')[0]; }])
  try { console.log(String(f())); } catch (e) { console.log(e.name, e.code, e.message); }
