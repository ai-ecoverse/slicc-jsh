const http = require('http'), https = require('https');
const a = https.request('https://a.test/original', { hostname: 'b.test', path: '/override' }); a.on('error', () => {}); console.log('https override', a.host, a.path, a.method); a.destroy();
const b = http.request('http://[2001:db8::1]/x'); b.on('error', () => {}); console.log('http ipv6', b.host, b.path); b.destroy();
const c = http.request({ host: '[::1]', path: '/o' }); c.on('error', () => {}); console.log('object form', c.host); c.destroy();
