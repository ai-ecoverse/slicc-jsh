const rlp = require('readline/promises');
(async () => {
  const rl = rlp.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('first? '); console.log('\ngot', JSON.stringify(a));
  const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
  try { const b = await rl.question('second (aborts)? ', { signal: ac.signal }); console.log('\nunexpected', b); } catch (e) { console.log('\nabort', e.name, e.code); }
  rl.close();
  console.log('Interface', typeof rlp.Interface, typeof rlp.Readline, Object.keys(rlp).sort().join(','));
})();
