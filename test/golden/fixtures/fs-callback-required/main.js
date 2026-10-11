const fs = require('fs');

function check(label, fn) {
  try {
    fn();
    console.log(label, 'NO_THROW');
  } catch (e) {
    console.log(label, e.code, e.message);
  }
}

check('readFile', () => fs.readFile('nope'));
check('readFile+enc', () => fs.readFile('nope', 'utf8'));
check('writeFile', () => fs.writeFile('nope', 'x'));
check('appendFile', () => fs.appendFile('nope', 'x'));
check('stat', () => fs.stat('nope'));
check('readdir', () => fs.readdir('nope'));
check('unlink', () => fs.unlink('nope'));
check('exists', () => fs.exists('nope'));
console.log('ok');
