const out = (l, f) => { try { const v = f(); console.log(l, typeof v, v && typeof v === 'object' ? Object.keys(v).length : ''); } catch (e) { console.log(l, 'throws', e.code ?? e.name, String(e.message).slice(0, 60)); } };
process.on('warning', (w) => console.log('warning', w.name, w.code ?? ''));
for (const n of ['fs', 'natives', 'constants', 'util', 'buffer', 'os', 'tcp_wrap', 'spawn_sync', 'process_wrap', 'pipe_wrap', 'tty_wrap', 'crypto', 'http_parser', 'contextify', 'worker', 'nope']) out(`binding(${n})`, () => process.binding(n));
for (const n of ['fs', 'nope']) out(`_linkedBinding(${n})`, () => process._linkedBinding(n));
const m = { exports: {} };
out('dlopen missing', () => process.dlopen(m, '/nope/x.node'));
out('dlopen a js file', () => process.dlopen(m, __filename));
out('dlopen no args', () => process.dlopen());
out('require .node', () => require('/nope/y.node'));
