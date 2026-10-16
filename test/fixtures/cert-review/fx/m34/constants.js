const c = require('constants');
console.log(typeof c, Object.isFrozen(c), c === require('node:constants'));
console.log(c.O_RDONLY, c.O_WRONLY, c.O_CREAT, c.S_IFMT, c.S_IFREG, c.F_OK, c.R_OK, c.ENOENT, c.EACCES, c.SIGINT, c.SIGTERM, c.UV_UDP_REUSEADDR);
console.log(typeof c.RTLD_LAZY, typeof c.PRIORITY_LOW, typeof c.defaultCoreCipherList, typeof c.RSA_PKCS1_PADDING, typeof c.COPYFILE_EXCL);
const os = require('os').constants, fsc = require('fs').constants;
const keys = Object.keys(c);
console.log('keys>=', keys.length > 200, 'has all fs', Object.keys(fsc).filter((k) => !(k in c)).join(',') || 'yes', 'has errno', Object.keys(os.errno).filter((k) => !(k in c)).join(',') || 'yes', 'has signals', Object.keys(os.signals).filter((k) => !(k in c)).join(',') || 'yes');
try { c.O_RDONLY = 5; console.log('assign silently', c.O_RDONLY); } catch (e) { console.log('assign', e.name); }
