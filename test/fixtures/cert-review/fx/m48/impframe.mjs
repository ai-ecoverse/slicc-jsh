try { await import('./thrower.mjs'); } catch (e) { console.log(e.stack.split('\n').map((l) => l.replace(/file:\/\/\S*\/(?=[^/]+:\d)/, '')).filter((l) => !l.includes('node:internal')).join('\n')); }
const m = await import('./frames.mjs'); console.log(m.stack.split('\n').slice(0, 4).map((l) => l.replace(/file:\/\/\S*\/(?=[^/]+:\d)/, '')).filter((l) => !l.includes('node:internal')).join('\n'));
