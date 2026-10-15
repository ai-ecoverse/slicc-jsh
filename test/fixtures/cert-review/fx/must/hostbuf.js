(async () => {
  const out = []; const t = async (n, f) => { try { out.push(`${n}: ${await f()}`); } catch (e) { out.push(`${n}: ${e.name} ${e.code ?? ''} ${e.message}`); } };
  await t('globalThis.Buffer === require(buffer).Buffer', () => globalThis.Buffer === require('buffer').Buffer);
  await t('Buffer.poolSize/typeof', () => `${typeof Buffer.poolSize} ${typeof Buffer.allocUnsafeSlow}`);
  await t('reader chunk ctor', async () => { const { value } = await new Response('ab').body.getReader().read(); return `${value.constructor.name} isBuffer=${Buffer.isBuffer(value)}`; });
  await t('Blob.bytes', async () => { const b = await new Blob(['q']).bytes?.(); return b ? `${b.constructor.name} ${b[0]}` : 'n/a'; });
  await t('Response.bytes', async () => { const b = await new Response('r').bytes?.(); return b ? `${b.constructor.name} ${b[0]}` : 'n/a'; });
  await t('TextDecoder(Buffer)', () => new TextDecoder().decode(Buffer.from('td')));
  await t('structuredClone(Buffer)', () => { const c = structuredClone(Buffer.from('sc')); return `${c.constructor.name} ${Buffer.isBuffer(c)}`; });
  await t('Response(Buffer.subarray).text', () => new Response(Buffer.from('xxsubyy').subarray(2, 5)).text());
  await t('Buffer from Response arrayBuffer equals', async () => Buffer.from(await new Response('é').arrayBuffer()).equals(Buffer.from('é')));
  console.log(out.join('\n'));
})();
