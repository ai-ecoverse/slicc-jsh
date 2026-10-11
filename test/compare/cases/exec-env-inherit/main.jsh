const { exec } = require('sliccy:exec');
process.env.COMPARE_SET = 'set-in-script';
console.log(JSON.stringify((await exec('echo "given=$COMPARE_GIVEN set=$COMPARE_SET"')).stdout));
