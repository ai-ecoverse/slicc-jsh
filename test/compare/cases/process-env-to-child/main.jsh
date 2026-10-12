process.env.COMPARE_NUM = 7;
console.log(typeof process.env.COMPARE_NUM, require('child_process').execSync('echo $COMPARE_NUM', { encoding: 'utf8' }).trim());
