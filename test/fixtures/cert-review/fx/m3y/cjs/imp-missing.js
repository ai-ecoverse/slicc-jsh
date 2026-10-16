import('./nope.mjs').catch((e) => console.log('caught', e.code));
console.log('after');
