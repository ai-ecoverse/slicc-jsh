let browser;
try {
  browser = require('sliccy:browser');
  console.log('loaded', Object.keys(browser).sort().join(','));
} catch (e) {
  console.log('require error', e.message.split('\n')[0]);
}
if (browser) {
  try {
    const t = await Promise.race([browser.findTab({ url: 'example.com' }), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 3s')), 3000))]);
    console.log('findTab', JSON.stringify(t));
  } catch (e) {
    console.log('findTab error', e.message.split('\n')[0]);
  }
}
