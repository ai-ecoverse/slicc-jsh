const fs = require('fs'); const T = process.argv[2];
try { process.exit(3); } catch (e) { fs.writeFileSync(T + '.catch', 'catch ran'); } finally { fs.writeFileSync(T + '.finally', 'finally ran'); }
fs.writeFileSync(T + '.after', 'after ran');
