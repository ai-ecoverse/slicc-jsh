const parts = [];
process.stdin.on('data', (c) => parts.push(c));
process.stdin.on('end', () => {
  console.log('chunk type', Buffer.isBuffer(parts[0]) ? 'Buffer' : typeof parts[0]);
  console.log(JSON.stringify(Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8')));
});
