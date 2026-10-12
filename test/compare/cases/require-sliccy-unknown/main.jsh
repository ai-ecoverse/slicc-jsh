for (const n of ['nope', '', 'agent', 'usb', 'serial', 'hid', 'computer', 'browser']) {
  try {
    const m = require('sliccy:' + n);
    console.log(n || '(empty)', 'loaded', typeof m, Object.keys(m).sort().join(','));
  } catch (e) {
    console.log(n || '(empty)', 'error', e.message.split('\n')[0]);
  }
}
