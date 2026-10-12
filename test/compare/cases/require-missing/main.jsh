try {
  require('left-pad-not-installed');
} catch (e) {
  console.log('code', e.code);
  console.log('message', e.message.split('\n')[0]);
  console.log('requireStack', Array.isArray(e.requireStack));
}
try {
  require('./missing-file');
} catch (e) {
  console.log('relative code', e.code);
  console.log('relative message', e.message.split('\n')[0]);
}
