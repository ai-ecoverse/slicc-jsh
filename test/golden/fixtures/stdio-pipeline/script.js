const zlib = require('zlib');
const { pipeline } = require('stream');
pipeline(process.stdin, zlib.createGzip(), zlib.createGunzip(), process.stdout, (err) => {
  console.error('pipeline done', err ?? null);
});
