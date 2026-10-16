const { execFile } = require('node:child_process'); const { promisify } = require('node:util');
const { stdout } = await promisify(execFile)('sh', ['-c', 'echo via-promisify; exit 0']); console.log('cp', JSON.stringify(stdout));
