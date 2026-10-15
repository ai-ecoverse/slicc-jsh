const url = require('url');
const P = (l, f) => { try { console.log(l, JSON.stringify(f())); } catch (e) { console.log(l, 'throws', e.code, e.message); } };
for (const u of ['http://user:pw@host.com:8080/p/a/t/h?query=string#hash', 'https://xn--mnchen-3ya.de/', 'http://münchen.de/ä?ö=ü', '//foo/bar', 'mailto:a@b.c', 'javascript:alert(1)', 'http://[::1]:80/x', 'HTTP://EXAMPLE.com/%7Efoo', '/just/a/path?x=1', 'http://a.com\\b\\c', 'file:///C:/x', 'http://a b.com/']) {
  P(`parse ${u}`, () => { const p = url.parse(u, true); return [p.protocol, p.auth, p.host, p.port, p.hostname, p.hash, p.query, p.pathname, p.path, p.href]; });
}
P('parse slashesDenoteHost', () => url.parse('//foo/bar', false, true).host);
P('format obj', () => url.format({ protocol: 'https', hostname: 'ex.com', pathname: '/a b', query: { x: 'y z', arr: [1, 2] } }));
P('format URL options', () => url.format(new URL('https://u:p@ex.com/a?b#c'), { auth: false, fragment: false, search: false, unicode: true }));
P('resolve', () => [url.resolve('/one/two/three', 'four'), url.resolve('http://example.com/', '/one'), url.resolve('http://example.com/one', '/two'), url.resolve('http://a/b/c/d;p?q', '../../../g'), url.resolve('http://a/b', '//other/x')]);
P('resolveObject', () => url.resolveObject('http://a/b/c', '../d').href);
P('Url', () => [typeof url.Url, new url.Url() instanceof url.Url]);
P('domainTo', () => [url.domainToASCII('español.com'), url.domainToASCII('xn--iñvalid.com'), url.domainToUnicode('xn--espaol-zwa.com'), url.domainToUnicode('xn--iñvalid.com')]);
P('fileURLToPath', () => [url.fileURLToPath('file:///a/b%20c'), url.fileURLToPath(new URL('file:///x/y'))]);
P('fileURLToPath windows', () => url.fileURLToPath('file:///C:/a/b', { windows: true }));
P('fileURLToPath host', () => url.fileURLToPath('file://host/a'));
P('fileURLToPath %2F', () => url.fileURLToPath('file:///a%2Fb'));
P('fileURLToPath http', () => url.fileURLToPath('http://x/y'));
P('fileURLToPath bad type', () => url.fileURLToPath(5));
P('pathToFileURL', () => [url.pathToFileURL('/a b/c#d?e').href, url.pathToFileURL('/a/', {}).href, url.pathToFileURL('C:\\a\\b', { windows: true }).href]);
P('urlToHttpOptions', () => url.urlToHttpOptions(new URL('https://u:p@[::1]:8443/x?y=1#z')));
P('URL same', () => [url.URL === URL, url.URLSearchParams === URLSearchParams]);
