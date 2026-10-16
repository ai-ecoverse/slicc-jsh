const cp = require('child_process');
let t0 = Date.now(); const a = cp.execSync('(sleep 1.5; echo late) & echo now').toString(); console.log('bg holds the pipe:', JSON.stringify(a), Date.now() - t0 >= 1400 ? 'waited' : 'returned early');
t0 = Date.now(); const b = cp.execSync('(sleep 1.5; echo late) > /dev/null 2>&1 & echo now').toString(); console.log('bg redirected away:', JSON.stringify(b), Date.now() - t0 < 1000 ? 'returned at once' : 'waited');
