for (const enc of ['utf8', 'UTF-8', 'ucs2', 'utf16le', 'latin1', 'binary', 'base64', 'base64url', 'hex', 'ascii', 'bogus']) { try { console.log(enc, Buffer.from('hé€', enc).toString('hex'), Buffer.isEncoding(enc)); } catch (e) { console.log(enc, 'throws', e.code, e.name, e.message); } }
try { Buffer.alloc(1).toString('bogus'); } catch (e) { console.log('toString bogus', e.code, e.message); }
try { Buffer.alloc(4).write('x', 'bogus'); } catch (e) { console.log('write bogus', e.code); }
console.log('forgiving base64', Buffer.from('aGVs bG8=\n', 'base64').toString(), Buffer.from('aGVsbG8', 'base64').toString(), Buffer.from('aGV-sbG8_', 'base64').toString('hex'), Buffer.from('a=b', 'base64').toString('hex'), Buffer.from('====', 'base64').length, Buffer.from('YQ==YQ==', 'base64').toString('hex'));
console.log('base64url', Buffer.from([251, 255, 254]).toString('base64url'), Buffer.from('-_-_', 'base64url').toString('hex'), Buffer.from('+/+/', 'base64url').toString('hex'));
console.log('ascii masking', Buffer.from([0xe9, 0x80, 0x41, 0xff]).toString('ascii'), JSON.stringify(Buffer.from('é€', 'ascii').toString('hex')), Buffer.from([0xc3, 0xa9]).toString('latin1'));
const b = Buffer.from('abcabcabc');
console.log('lastIndexOf', b.lastIndexOf('abc'), b.lastIndexOf('abc', 5), b.lastIndexOf('abc', -4), b.lastIndexOf('x'), b.lastIndexOf(98), b.lastIndexOf(Buffer.from('ca')), b.lastIndexOf('', 3), b.lastIndexOf('abc', 100), b.lastIndexOf('c', -100), b.lastIndexOf('b', null), b.lastIndexOf('b', undefined), b.lastIndexOf('b', NaN), b.lastIndexOf('b', {}));
console.log('indexOf', b.indexOf('c', -2), b.indexOf('bc', 2), b.includes('cab'), Buffer.from('aaaa').lastIndexOf('aa'));
console.log('ucs2 lastIndexOf', Buffer.from('ababab', 'ucs2').lastIndexOf('ab', undefined, 'ucs2'));
console.log('hex odd', Buffer.from('abc', 'hex').toString('hex'), Buffer.from('zz12', 'hex').length, Buffer.from('12zz34', 'hex').toString('hex'));
console.log('byteLength', Buffer.byteLength('hé€', 'utf8'), Buffer.byteLength('aGVsbG8=', 'base64'), Buffer.byteLength('abc', 'hex'), Buffer.byteLength('é', 'latin1'));
