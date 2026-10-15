const { Buffer, constants, kMaxLength } = require('buffer');
console.log(Buffer.name, typeof kMaxLength, constants.MAX_STRING_LENGTH);
const a = Buffer.alloc(8, 'ab'); console.log(a.toString(), Buffer.alloc(5, 0x41).toString(), Buffer.alloc(4, '').toString('hex'), Buffer.alloc(6, 'aGk=', 'base64').toString());
const u = Buffer.allocUnsafe(16); console.log(u.length, u.buffer.byteLength >= 16, Buffer.allocUnsafeSlow(3).length);
const s = Buffer.allocUnsafe(10).fill(0); console.log(s.every((x) => x === 0));
console.log(Buffer.alloc(9).fill('xyz', 1, 8).toString('latin1'), Buffer.alloc(4).fill(257).toString('hex'), Buffer.alloc(3).fill(Buffer.from([1, 2])).toString('hex'));
try { Buffer.alloc(4).fill('zz', 'hex'); } catch (e) { console.log('fill bad hex', e.code); }
try { Buffer.alloc(-1); } catch (e) { console.log('alloc -1', e.code); }
try { Buffer.alloc(2 ** 53); } catch (e) { console.log('alloc huge', e.code); }
const t0 = Date.now(); const big = Buffer.alloc(64 * 2 ** 20); for (let i = 0; i < 4; i++) big.fill(i); big.fill('abc'); console.log('fill 64MB x5 ok', big[64 * 2 ** 20 - 1], Date.now() - t0 < 5000);
const len = constants.MAX_STRING_LENGTH + 1;
const huge = Buffer.alloc(len, 0x61);
for (const enc of ['latin1', 'utf8', 'ascii']) { try { huge.toString(enc); console.log(enc, 'no error'); } catch (e) { console.log(enc, e.code, e.name, e.message.slice(0, 60)); } }
try { huge.toString('hex'); console.log('hex no error'); } catch (e) { console.log('hex', e.code); }
try { huge.toString('base64'); console.log('base64 ok'); } catch (e) { console.log('base64', e.code); }
console.log(huge.toString('latin1', 0, 5));
