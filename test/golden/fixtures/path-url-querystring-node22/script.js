// Node 22's own lib/path.js, lib/url.js, lib/querystring.js, lib/punycode.js and
// lib/os.js (the parts that don't depend on the machine).
const path = require('path');
const url = require('url');
const qs = require('querystring');
const os = require('os');
const t = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === 'string' ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, 'THROWS', e.name, e.code, e.message.split('\n')[0]);
  }
};

t('win32', () => [path.win32.join('a', 'b', '..', 'c'), path.win32.resolve('C:\\x', 'y'), path.win32.parse('C:\\dir\\f.txt'), path.win32.relative('C:\\a\\b', 'C:\\a\\c'), path.win32.toNamespacedPath('C:\\x'), path.win32.isAbsolute('\\\\srv\\share')]);
t('posix', () => [path.posix === path, path.win32 === require('path/win32'), path.posix === require('path/posix'), path.sep, path.delimiter]);
t('format', () => [path.format({ dir: '/a', name: 'b', ext: 'c' }), path.format({ root: '/', base: 'x.js' })]);
t('matchesGlob', () => [path.matchesGlob('a/b/c.js', 'a/**/*.js'), path.matchesGlob('a/b.ts', 'a/*.js')]);
t('bad arg', () => path.join(1));
t('url.parse', () => {
  const u = url.parse('http://user:pw@Example.COM:8080/p/a/t/h?query=string&a=1#hash', true);
  return [u.protocol, u.auth, u.host, u.port, u.hostname, u.hash, u.search, u.query, u.pathname, u.path, u.href, u.slashes];
});
t('url.parse relative', () => { const u = url.parse('//foo/bar', false, true); return [u.host, u.pathname]; });
t('url.parse javascript', () => url.parse('javascript:alert(1)').href);
t('url.parse idn', () => url.parse('http://español.com/x').hostname);
t('url.format obj', () => url.format({ protocol: 'https', hostname: 'a.com', pathname: '/x', query: { q: 1, r: [2, 3] }, hash: 'h' }));
t('url.format URL', () => url.format(new URL('https://u:p@xn--espaol-zwa.com/x?y#z'), { auth: false, search: false, unicode: true, fragment: false }));
t('url.format str', () => url.format('http://a.com/x'));
t('url.resolve', () => [url.resolve('http://a.com/b/c', '../d'), url.resolve('/one/two/three', 'four'), url.resolve('http://example.com/', '/one'), url.resolve('http://example.com/one', '/two')]);
t('domain', () => [url.domainToASCII('español.com'), url.domainToUnicode('xn--espaol-zwa.com'), url.domainToASCII('xn--iñvalid.com')]);
t('fileURLToPath', () => [url.fileURLToPath('file:///a%20b/c'), url.fileURLToPath(new URL('file:///x/y')), url.fileURLToPath('file:///C:/x', { windows: true })]);
t('fileURLToPath bad', () => url.fileURLToPath('http://x/y'));
t('fileURLToPath host', () => { try { url.fileURLToPath('file://host/y'); } catch (e) { return [e.code, e.message.startsWith('File URL host must be "localhost" or empty on ')]; } });
t('fileURLToPath slash', () => url.fileURLToPath('file:///a%2Fb'));
t('pathToFileURL', () => [url.pathToFileURL('/a b/c#?%').href, url.pathToFileURL('/dir/').href, url.pathToFileURL('C:\\x y\\z', { windows: true }).href]);
t('urlToHttpOptions', () => url.urlToHttpOptions(new URL('https://a:b@h.com:8080/x?y')));
t('Url', () => typeof url.Url === 'function' && new url.Url() instanceof url.Url);
t('qs.stringify', () => [qs.stringify({ a: [1, 2], b: 'x y', c: '' }), qs.stringify({ a: 1 }, ';', ':'), qs.escape('a b&c'), qs.encode === qs.stringify]);
t('qs.parse', () => [qs.parse('a=1&a=2&b=x%20y&c'), qs.parse('a:1;b:2', ';', ':'), qs.parse('a=%E4%BD%A0&b=%ZZ'), qs.unescape('%41%zz')]);
t('qs maxKeys', () => Object.keys(qs.parse('a=1&b=2&c=3', null, null, { maxKeys: 2 })));
t('punycode', () => { const p = require('punycode'); return [p.encode('mañana'), p.decode('maana-pta'), p.toASCII('mañana.com'), p.toUnicode('xn--maana-pta.com'), p.ucs2.decode('😀')]; });
t('os', () => [os.EOL === '\n', os.devNull, os.endianness(), typeof os.machine(), typeof os.availableParallelism(), typeof os.version(), Object.keys(os.userInfo()).sort(), Object.keys(os.constants).sort(), typeof os.constants.signals.SIGTERM, os.constants.priority]);
t('os.loadavg', () => os.loadavg().length);
t('os.priority bad', () => os.setPriority(0, 100));
t('os.networkInterfaces lo', () => Object.values(os.networkInterfaces()).flat().some((i) => i.internal && i.family === 'IPv4' && i.cidr === '127.0.0.1/8'));
