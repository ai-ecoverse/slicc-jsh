const fs = require('fs');
const flag = process.argv[2];
const start = Date.now();
const poll = () => {
  if (fs.existsSync(flag)) return console.log('grandchild after close');
  if (Date.now() - start > 5000) return console.log('grandchild gave up');
  setTimeout(poll, 20);
};
poll();
