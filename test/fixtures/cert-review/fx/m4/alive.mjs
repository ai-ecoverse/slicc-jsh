import http from 'node:http';
const srv = http.createServer(() => {}); srv.listen(0, '127.0.0.1', () => console.log('listening'));
let n = 0; const iv = setInterval(() => { n++; if (n === 3) { console.log('still alive after 3 ticks; closing'); clearInterval(iv); srv.close(); } }, 300);
