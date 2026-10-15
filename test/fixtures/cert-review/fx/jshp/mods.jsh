const { fmt, time, pool } = { fmt: require('sliccy:fmt'), time: require('sliccy:time'), pool: require('sliccy:pool') };
const color = require('sliccy:color');
console.log('fmt', JSON.stringify(fmt.trunc('abcdefghij', 5)), fmt.col('x', 4) + '|');
console.log('table', JSON.stringify(fmt.table([{ a: 1, b: 'two' }, { a: 30, b: 'x' }])));
const r = time.range('2h', new Date('2026-01-01T12:00:00Z')); console.log('time', r.start.toISOString(), r.end.toISOString(), time.gmailDate('1d', new Date('2026-01-02T00:00:00Z')));
let live = 0, peak = 0; const out = await pool(2, [1, 2, 3, 4], async (i) => { live++; peak = Math.max(peak, live); await new Promise((z) => setTimeout(z, 10)); live--; return i * i; });
console.log('pool', JSON.stringify(out), 'peak', peak);
console.log('color', JSON.stringify(color.red('r')), typeof color.bold);
