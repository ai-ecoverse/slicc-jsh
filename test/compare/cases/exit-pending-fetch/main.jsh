fetch(`${process.env.COMPARE_HTTP}/slow`).then((r) => r.text()).then((t) => console.log('fetched', t));
console.log('body done');
