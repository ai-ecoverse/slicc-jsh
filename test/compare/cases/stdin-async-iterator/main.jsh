const parts = [];
for await (const c of process.stdin) parts.push(Buffer.from(c));
console.log(JSON.stringify(Buffer.concat(parts).toString('utf8')));
