// every function on os/util/fs/path (and path.posix/win32), destructured and called detached with safe arguments; result type or error code vs Node
const fs = require('fs'); fs.mkdirSync('/tmp/m31', { recursive: true }); fs.writeFileSync('/tmp/m31/f', 'x');
const SAFE = {
  path: ['a/b'], os: [], util: ['x'], fs: ['/tmp/m31/f'],
};
const SKIP = /^(_|createReadStream|createWriteStream|watch|watchFile|unwatchFile|exit|abort|chdir|kill|reallyExit|setuid|setgid|seteuid|setegid|setgroups|initgroups|dlopen|openStdin|binding|_linkedBinding|setPriority|debuglog|deprecate|inherits|promisify|callbackify|parseArgs|MIMEType|MIMEParams|TextEncoder|TextDecoder|log|rm|rmdir|unlink|rename|truncate|ftruncate|mkdtemp|mkdir|write|appendFile|copyFile|cp|link|symlink|chmod|chown|lchown|lchmod|utimes|lutimes|futimes|fchmod|fchown|fsync|fdatasync|close|open|read|readv|writev|opendir|openAsBlob|glob|exists$|readFile$|readdir$|stat$|lstat$|access$|realpath$|readlink$|fstat$|statfs$|transferableAbortController|transferableAbortSignal|aborted|parseEnv|types$|styleText|toUSVString)/;
const out = {};
for (const [name, mod] of [['path', require('path')], ['path.posix', require('path').posix], ['path.win32', require('path').win32], ['os', require('os')], ['util', require('util')], ['fs', fs]]) {
  const args = SAFE[name.split('.')[0]];
  for (const k of Object.keys(mod).sort()) {
    const f = mod[k]; if (typeof f !== 'function' || SKIP.test(k) || /^[A-Z]/.test(k) || (name === 'fs' && !k.endsWith('Sync'))) continue;
    if (name === 'fs' && /^(rm|rmdir|unlink|rename|truncate|mkdtemp|mkdir|write|append|copy|cp|link|symlink|chmod|chown|lchown|lchmod|utimes|lutimes|futimes|fchmod|fchown|fsync|fdatasync|close|open|read|readv|writev|opendir|ftruncate)/.test(k)) continue;
    let r; try { const v = f(...args); r = v === undefined ? 'undef' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; } catch (e) { r = 'throws ' + (e.code || e.name); }
    out[`${name}.${k}`] = r;
  }
}
console.log(Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n'));
