for (const a of process.argv.slice(2)) { const s = /^\d+$/.test(a) ? Number(a) : a; const r = process.kill(process.pid, s); console.log('kill', s, 'returned', r); }
setTimeout(() => console.log('still alive'), 30);
