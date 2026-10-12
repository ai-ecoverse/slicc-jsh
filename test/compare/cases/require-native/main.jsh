for (const n of ['sharp', 'better-sqlite3', 'puppeteer', 'usb']) {
  try { require(n); console.log(n, 'loaded'); } catch (e) { console.log(n, e.code || e.name, '|', e.message.split('\n')[0]); }
}
