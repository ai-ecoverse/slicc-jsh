const fs = require('fs'); fs.writeFileSync('/tmp/afile-chdir', 'x');
for (const d of ['/nope/x', '/tmp/afile-chdir', '', 42]) { try { process.chdir(d); console.log('chdir ok', d, process.cwd()); } catch (e) { console.log('chdir', JSON.stringify(d), e.code, e.errno, e.syscall, e.path, e.dest, e.message); } }
process.chdir('/tmp'); console.log('cwd', process.cwd().replace('/private', ''));
