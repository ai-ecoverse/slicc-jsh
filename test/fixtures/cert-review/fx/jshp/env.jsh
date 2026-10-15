console.log('argv', JSON.stringify(process.argv.slice(2)), 'isTTY', !!process.stdout.isTTY, 'require.main===module', require.main === module, typeof module.exports);
const fs = require('fs'); fs.writeFileSync(__dirname + '/written-by-jsh.txt', 'x'); console.log('wrote next to script', fs.existsSync(__dirname + '/written-by-jsh.txt'));
