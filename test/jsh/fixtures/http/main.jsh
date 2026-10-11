const http = require('sliccy:http');
const client = http.client({ headers: { 'x-test': '1' } });
console.log(JSON.stringify(await client.get('data:application/json,{"a":1}')));
console.log(JSON.stringify(await client.get('data:text/plain,hello', { raw: true })));
