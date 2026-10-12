process.stdin.setEncoding('utf8');
let buf = '';
let chunks = 0;
process.stdin.on('data', (c) => { chunks++; buf += c; });
process.stdin.on('end', () => console.log('end', JSON.stringify(buf), chunks > 0));
