const text = await new Promise((resolve, reject) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => resolve(s));
  process.stdin.on('error', reject);
});
console.log(JSON.stringify(text));
