const cp = require('child_process');
for (const stdio of ['ignore', 'pipe', 'inherit']) { const c = cp.spawn(process.execPath, ['-e', '1'], { stdio }); console.log(stdio, 'pid sync', typeof c.pid); c.on('spawn', () => console.log(stdio, 'pid at spawn', typeof c.pid)); }
