const fs = require('fs');
fs.readFile('data.txt', 'utf8', (err, data) => {
  console.log('readFile cb', err, JSON.stringify(data));
  fs.writeFile('cb.txt', 'cb', (err2) => {
    console.log('writeFile cb', err2);
    fs.readdir('dir', (err3, names) => {
      console.log('readdir cb', err3, names && names.sort());
      fs.readFile('missing', (err4) => console.log('missing cb', err4 && err4.code));
    });
  });
});
