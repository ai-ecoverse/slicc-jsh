(async () => {
  process.stdin.setEncoding('utf8');
  let all = '';
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') throw new Error('not a string');
    all += chunk;
  }
  console.log(JSON.stringify(all.split('\n')), process.stdin.readableEnded);
})();
