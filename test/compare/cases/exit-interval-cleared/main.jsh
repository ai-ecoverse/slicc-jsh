let n = 0;
const t = setInterval(() => { n++; console.log('tick', n); if (n === 3) clearInterval(t); }, 20);
const u = setInterval(() => {}, 1000);
if (typeof u.unref === 'function') u.unref(); else console.log('no unref');
