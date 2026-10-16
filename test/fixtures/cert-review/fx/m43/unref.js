const cp = require('child_process');
const c = cp.spawn(process.execPath, ['kid.js', 'late', process.argv[2]], { detached: true, stdio: 'ignore' });
c.unref(); console.log('parent exits');
