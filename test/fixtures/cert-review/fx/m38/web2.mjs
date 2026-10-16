import { Readable, Writable, Duplex } from 'node:stream';
const t = async (l, f) => { try { console.log(l, await f()); } catch (e) { console.log(l, 'error', e.name, String(e.message).slice(0, 80)); } };
await t('Readable.fromWeb', async () => { let s = ''; for await (const c of Readable.fromWeb(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([104, 105])); c.close(); } }))) s += c; return s; });
await t('Readable.toWeb', async () => (await Readable.toWeb(Readable.from(['q'])).getReader().read()).value);
await t('Writable.toWeb', async () => typeof Writable.toWeb(new Writable({ write(c, e, cb) { cb(); } })).getWriter);
await t('Writable.fromWeb', async () => typeof Writable.fromWeb(new WritableStream()).write);
await t('Duplex.fromWeb', async () => typeof Duplex.fromWeb({ readable: new ReadableStream(), writable: new WritableStream() }).write);
