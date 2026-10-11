const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'data.txt');
console.log('sync', JSON.stringify(fs.readFileSync(file, 'utf8')));
console.log('buffer', Buffer.isBuffer(fs.readFileSync(file)));
const st = fs.statSync(__dirname);
console.log('stat', typeof st.isDirectory, st.isDirectory(), fs.statSync(file).isFile());
await new Promise((resolve) => {
  fs.readFile(file, 'utf8', (err, text) => {
    console.log('callback', err, JSON.stringify(text));
    resolve();
  });
});
console.log('promises', JSON.stringify(await fs.promises.readFile(file, 'utf8')));
console.log('promises.stat', (await fs.promises.stat(file)).isFile());
console.log('fs/promises', require('fs/promises') === fs.promises);
console.log('no v6 extras', typeof fs.readFileBinary, typeof fs.readDir, typeof fs.fetchToFile);
