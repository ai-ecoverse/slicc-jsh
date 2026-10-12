try {
  const pw = require('playwright');
  console.log('loaded', Object.keys(pw).sort().join(','));
} catch (e) {
  console.log('error', e.code || e.name, '|', e.message.split('\n')[0]);
}
