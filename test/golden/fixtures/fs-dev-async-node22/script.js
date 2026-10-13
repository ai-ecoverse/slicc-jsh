const fs = require('fs');
(async () => {
  for (const [l, f] of [
    ['p.writeFile null', () => fs.promises.writeFile('/dev/null', 'x')],
    ['p.appendFile stdout', () => fs.promises.appendFile('/dev/stdout', 'p append\n')],
    ['p.readFile null', () => fs.promises.readFile('/dev/null', 'utf8')],
    ['cb appendFile stderr', () => new Promise((r, j) => fs.appendFile('/dev/stderr', 'cb append\n', (e) => (e ? j(e) : r('ok'))))],
    ['p.open zero', async () => { const h = await fs.promises.open('/dev/zero', 'r'); const { bytesRead, buffer } = await h.read(Buffer.alloc(3, 9), 0, 3); await h.close(); return [bytesRead, [...buffer]]; }],
  ]) {
    try { console.log(l, JSON.stringify(await f())); } catch (e) { console.log(l, 'THROWS', e.code, e.message); }
  }
  console.log('order 1'); fs.writeSync(1, 'order 2\n'); fs.appendFileSync('/dev/stdout', 'order 3\n'); console.log('order 4');
})();
