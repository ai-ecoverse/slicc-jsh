(async () => {
  const out = [];
  const t = async (n, f) => { try { out.push(`${n}: ${await f()}`); } catch (e) { out.push(`${n}: ${e.name} ${e.code ?? ''} ${e.message}`); } };
  await t('typeof fetch/WebSocket', () => `${typeof fetch} ${typeof WebSocket}`);
  await t('fetch(url)', () => fetch('http://127.0.0.1:9/'));
  await t('new WebSocket(url)', () => new WebSocket('ws://127.0.0.1:9/'));
  await t('globalThis.fetch = fn', () => { globalThis.fetch = () => 1; return typeof globalThis.fetch; });
  await t('Response text', () => new Response('x').text());
  await t('Response json', () => Response.json({ a: 1 }).json().then(JSON.stringify));
  await t('Response arrayBuffer→Buffer', async () => Buffer.from(await new Response('héllo').arrayBuffer()).toString('hex'));
  await t('Response(Buffer) text', () => new Response(Buffer.from('buf body')).text());
  await t('Response(stream) text', () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('st')); c.close(); } })).text());
  await t('Request body text', () => new Request('http://x/', { method: 'POST', body: 'rq' }).text());
  await t('Blob text', () => new Blob(['a', Buffer.from('b')]).text());
  await t('Blob arrayBuffer', async () => Buffer.from(await new Blob(['zz']).arrayBuffer()).toString());
  await t('FormData', () => { const f = new FormData(); f.append('k', 'v'); return [...f].join(); });
  await t('Headers', () => [...new Headers({ A: '1' })].join());
  console.log(out.join('\n'));
})();
