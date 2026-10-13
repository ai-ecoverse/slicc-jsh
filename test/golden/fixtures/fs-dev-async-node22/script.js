const fs = require('fs');
(async () => {
  for (const [l, f] of [
    ['p.writeFile null', () => fs.promises.writeFile('/dev/null', 'x')],
    ['p.readFile null', () => fs.promises.readFile('/dev/null', 'utf8')],
    ['p.open zero', async () => { const h = await fs.promises.open('/dev/zero', 'r'); const { bytesRead, buffer } = await h.read(Buffer.alloc(3, 9), 0, 3); await h.close(); return [bytesRead, [...buffer]]; }],
  ]) {
    try { console.log(l, JSON.stringify(await f())); } catch (e) { console.log(l, 'THROWS', e.code, e.message); }
  }
})();
