const zlib = require('zlib');
const text = Buffer.from('interop '.repeat(500) + Array.from({ length: 300 }, (_, i) => i * 7919 % 1000).join(','));
console.log('XOUT gzip', zlib.gzipSync(text).toString('base64'));
console.log('XOUT deflate9', zlib.deflateSync(text, { level: 9 }).toString('base64'));
console.log('XOUT raw1', zlib.deflateRawSync(text, { level: 1 }).toString('base64'));
const fromNode = { gzip: 'H4sIAAAAAAAAE23GwQ2AQAgEwFa2AG3AIuzByJrDeAcBEmP3WoDzGh3FMF+wmnDerXswkwLfnss2wWGBasSZDanCCbfWV+tE0FlaauO/L5yoiOpdAAAA' };
try { console.log('decode node gzip', zlib.gunzipSync(Buffer.from(fromNode.gzip, 'base64')).toString()); } catch (e) { console.log('decode node gzip ERR', e.code); }
