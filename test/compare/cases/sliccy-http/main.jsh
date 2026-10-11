const http = require('sliccy:http');
console.log('keys', Object.keys(http).sort().join(','));
const api = http.client({ baseUrl: process.env.COMPARE_HTTP, headers: { 'x-custom': 'c1' } });
console.log('client keys', Object.keys(api).sort().join(','));
console.log('get json', JSON.stringify(await api.get('/json')));
console.log('post', JSON.stringify(await api.post('/echo', { body: { a: 1 } })));
try {
  await api.get('/missing');
  console.log('404 did not throw');
} catch (e) {
  console.log('404', e.name, e.status, e.message.split('\n')[0]);
}
console.log('text', JSON.stringify(await api.get('/text')));
