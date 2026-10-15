for (const m of ['dns/promises', 'node:dns/promises', 'inspector/promises', 'node:inspector/promises', 'dns', 'inspector']) { try { require(m); console.log(m, 'loaded'); } catch (e) { console.log(m, e.code); } }
import('node:dns/promises').then(() => console.log('import dns/promises loaded'), (e) => console.log('import dns/promises', e.code));
