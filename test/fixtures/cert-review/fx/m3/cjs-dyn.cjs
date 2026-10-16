import('./tla.mjs').then(() => console.log('cjs dynamic import of .mjs ok'), (e) => console.log('ERR', e.message));
