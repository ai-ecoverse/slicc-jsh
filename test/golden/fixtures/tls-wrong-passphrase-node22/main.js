const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'keys');
const show = (label, options) => {
  try {
    tls.createSecureContext(options);
    console.log(label, 'made');
  } catch (e) {
    console.log(label, e.name, e.code, e.message, e.library, e.reason, JSON.stringify(e.opensslErrorStack));
  }
};
for (const name of fs.readdirSync(dir).sort()) {
  const key = fs.readFileSync(path.join(dir, name));
  const crafted = name.startsWith('crafted-');
  for (const passphrase of crafted ? ['not it'] : ['not it', undefined, '', 'pw']) {
    show(`${name} ${passphrase === undefined ? 'none' : JSON.stringify(passphrase)}`, passphrase === undefined ? { key } : { key, passphrase });
  }
}
const text = fs.readFileSync(path.join(dir, 'p8-ec-aes-256-padpass.pem'), 'utf8');
show('as a string', { key: text, passphrase: 'not it' });
show('as { pem, passphrase }', { key: [{ pem: text, passphrase: 'not it' }], passphrase: 'pw' });
show('{ pem } with the right passphrase beside it', { key: [{ pem: text }], passphrase: 'pw' });
