const http = require('node:http'); const srv = http.createServer(() => {}); srv.listen(0, '127.0.0.1');
let n = 0; const iv = setInterval(() => { if (++n === 3) { console.log('alive 3 ticks; closing'); clearInterval(iv); srv.close(); } }, 300);
