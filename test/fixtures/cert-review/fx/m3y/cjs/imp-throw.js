console.log('before');
import('./bad.mjs').then(() => console.log('no'), (e) => console.log('caught', e.message));
console.log('after');
