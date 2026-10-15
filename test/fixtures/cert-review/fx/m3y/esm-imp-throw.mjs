try { await import('./cjs/bad.mjs'); } catch (e) { console.log('esm caught', e.message); }
console.log('esm after');
