console.log('before');
import('./tty.mjs').then(() => console.log('loaded tty'), (e) => console.log('caught', e.code));
console.log('after');
